import {
  prepareResearchFilmPrompt,
  researchFilmInputBudget,
  researchFilmTokenCounter
} from '../research-video/input-context'
import type { LocalModelSnapshot } from '../../shared/local-models'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createResearchFilmAuthor,
  createResearchVideoGenerator,
  createVideoExportTools,
  researchFilmResources,
  ResearchFilmOutputLimitError,
  type ResearchVideoSessionSource,
  RESEARCH_NARRATION_MODELS,
  RESEARCH_VIDEO_SCREENPLAY_PROMPT,
  RESEARCH_VIDEO_ANIMATION_PROMPT,
  VIDEO_EXPORT_REVISIONS
} from '@aipoch/research-film'
import {
  RestrictedInferenceRunner,
  RestrictedInferenceError,
  extractRestrictedInferenceUsage
} from '../acp/restricted-inference-runner'
import type { ApplicationModuleBuilder } from '../application-runtime'
import { createLocalModelOwner } from '../local-models/owner'
import type { ResearchFilmLifecycle } from '../research-video/lifecycle'
import { createResearchVideoPresentationOwner } from '../research-video/presentation'
import { runtimeMetadata } from '../runtime-metadata'
import type { SessionPackageService } from '../session-package/service'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import type { createDefaultSessionRepository } from '../session-persistence/ipc'
import type { SettingsService } from '../settings/service'
import { resolveDataRoot } from '../storage-root'

/** Button-owned generation: no conversation tools, Artifact publication or Notebook transport. */
export async function composeResearchFilm({
  configRoot,
  settingsService,
  sessionRepository,
  sessionPersistenceCoordinator,
  sessionPackageService,
  researchFilmLifecycle,
  recordAuxiliaryUsage,
  modules
}: {
  configRoot: string
  settingsService: SettingsService
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'runSessionMutation'>
  sessionPackageService: Pick<SessionPackageService, 'readResearchFilm'>
  researchFilmLifecycle: ResearchFilmLifecycle
  recordAuxiliaryUsage(record: SessionAuxiliaryTurnUsageRecord): Promise<void>
  modules: ApplicationModuleBuilder
}): Promise<{
  researchNarrationModels: ReturnType<typeof createLocalModelOwner>
  videoExportModels: ReturnType<typeof createLocalModelOwner>
  videoExportTools: ReturnType<typeof createVideoExportTools<LocalModelSnapshot>>
  researchVideoPresentation: ReturnType<typeof createResearchVideoPresentationOwner>
}> {
  const researchNarrationModels = createLocalModelOwner({
    namespace: 'research-narration',
    requireRecommendedRevision: true,
    revisions: RESEARCH_NARRATION_MODELS
  })
  await modules.add({ researchNarrationModels }, ({ researchNarrationModels: owner }) => ({
    name: 'research-narration-models',
    capability: undefined,
    dispose: () => owner.close()
  }))
  const videoExportModels = createLocalModelOwner({
    namespace: 'video-export',
    revisions: VIDEO_EXPORT_REVISIONS
  })
  await modules.add({ videoExportModels }, ({ videoExportModels: owner }) => ({
    name: 'video-export-tools',
    capability: undefined,
    dispose: () => owner.close()
  }))
  const videoExportTools = createVideoExportTools(videoExportModels)
  const resources = researchFilmResources()
  const researchVideoEngineDirectory = resources.stageDirectory
  const animationInstructions =
    RESEARCH_VIDEO_ANIMATION_PROMPT +
    '\n\n' +
    (await readFile(join(resources.authoringDirectory, 'KIT.md'), 'utf8'))
  const researchVideoGenerate = createResearchVideoGenerator({ temporaryRoot: tmpdir() })
  const researchVideoInference = new RestrictedInferenceRunner({
    appVersion: runtimeMetadata().version,
    configRoot,
    profileNamespace: 'research-video',
    allowNativeCodexSubscription: true,
    resolveTarget: (target, context) => settingsService.resolveExplicitAgentBackend(target, context)
  })
  // One frozen source belongs to one job. Corrections and parallel scene calls share its target.
  const capture = async (): Promise<{
    target: Awaited<ReturnType<SettingsService['captureActiveExplicitAgentBackendTarget']>>
    budget: number
    count: (text: string) => number
  }> => {
    const target = await settingsService.captureActiveExplicitAgentBackendTarget()
    const snapshot = await settingsService.getSettingsView()
    const provider = snapshot.providers.find((entry) => entry.id === target.providerId)
    if (!provider) throw new Error('The selected research film provider is unavailable.')
    const model = target.model.kind === 'required' ? target.model.id : provider.model
    return {
      target,
      budget: researchFilmInputBudget(provider, model),
      count: researchFilmTokenCounter({
        ...target,
        model: model ? { kind: 'required', id: model } : target.model
      })
    }
  }
  const targets = new WeakMap<ResearchVideoSessionSource, ReturnType<typeof capture>>()
  const inferResearchVideo = async (
    source: ResearchVideoSessionSource,
    systemPrompt: string,
    payload: unknown,
    signal: AbortSignal
  ): Promise<string> => {
    signal.throwIfAborted()
    if (!targets.has(source)) targets.set(source, capture())
    const { target, budget, count } = await targets.get(source)!
    signal.throwIfAborted()
    const response = await researchVideoInference
      .run({
        target,
        prompt: prepareResearchFilmPrompt(payload, systemPrompt, budget, count),
        systemPrompt,
        agentName: 'Research explanation',
        description: 'Generate a research explanation from a frozen session',
        outputLimitBytes: 64 * 1024,
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)])
      })
      .catch(async (error: unknown) => {
        const usage = extractRestrictedInferenceUsage(error)
        if (usage)
          await recordAuxiliaryUsage({
            projectId: source.provenance.projectId,
            sessionId: source.provenance.sessionId,
            eventId: randomUUID(),
            source: 'host-llm',
            frameworkId: target.frameworkId,
            providerId: target.providerId,
            model: target.model.kind === 'required' ? target.model.id : undefined,
            completedAtMs: Date.now(),
            usage
          })
        signal.throwIfAborted()
        if (error instanceof RestrictedInferenceError && error.code === 'output-limit')
          throw new ResearchFilmOutputLimitError(error.message)
        throw error
      })
    if (response.usage)
      await recordAuxiliaryUsage({
        projectId: source.provenance.projectId,
        sessionId: source.provenance.sessionId,
        eventId: randomUUID(),
        source: 'host-llm',
        frameworkId: response.frameworkId,
        providerId: target.providerId,
        model: response.model,
        completedAtMs: Date.now(),
        usage: response.usage
      })
    signal.throwIfAborted()
    if (response.stopReason === 'max_tokens')
      throw new ResearchFilmOutputLimitError(
        'Research film generation reached the model output token limit. Increase the model output limit or select another model and try again.'
      )
    if (response.stopReason !== 'end_turn')
      throw new Error(
        `Research film generation stopped before completing (${response.stopReason}). Try again or select another model.`
      )
    if (!response.text.trim())
      throw new Error(
        'The model returned no research film content. Try again or select another model.'
      )
    return response.text
  }
  const researchVideoPresentation = createResearchVideoPresentationOwner({
    mutate: (request, work) =>
      sessionPersistenceCoordinator.runSessionMutation(request.projectId, request.sessionId, work),
    lifecycle: researchFilmLifecycle,
    loadImportedFilm: (request, options) =>
      sessionPackageService.readResearchFilm(request, options),
    dataRoot: resolveDataRoot,
    models: researchNarrationModels,
    checkReadiness: async () => {
      const readiness = await settingsService.getPreflight()
      if (!readiness.agentReady)
        throw new Error(
          'Set up the selected agent runtime in Settings before generating a research film.'
        )
      if (!readiness.activeProviderReady)
        throw new Error(
          'Check the selected model and credentials in Settings before generating a research film.'
        )
      const snapshot = await settingsService.getSettingsView()
      const provider = snapshot.providers.find((entry) => entry.id === snapshot.activeProviderId)
      if (!provider) throw new Error('The selected research film provider is unavailable.')
      const model = snapshot.activeModel ?? provider.model
      const count = researchFilmTokenCounter({
        frameworkId: snapshot.agentFrameworkId,
        model: model ? { kind: 'required', id: model } : { kind: 'provider-default' }
      })
      const budget = researchFilmInputBudget(provider, model)
      if (
        budget <
        Math.max(count(RESEARCH_VIDEO_SCREENPLAY_PROMPT), count(animationInstructions)) + 512
      )
        throw new Error(
          'The selected model input limit cannot fit the research film instructions. Select a model with a larger input limit.'
        )
    },
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    generate: researchVideoGenerate,
    engineDirectory: researchVideoEngineDirectory,
    ...createResearchFilmAuthor(inferResearchVideo)
  })
  await modules.add({ researchVideoPresentation }, ({ researchVideoPresentation: owner }) => ({
    name: 'research-video-presentation',
    capability: undefined,
    dispose: async () => {
      await owner.close()
      await researchVideoInference.shutdown()
    }
  }))
  return { researchNarrationModels, videoExportModels, videoExportTools, researchVideoPresentation }
}
