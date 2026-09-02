import * as acp from '@agentclientprotocol/sdk'

import type { AcpPromptRequest } from '../../shared/acp'
import type { AgentFramework } from '../agent-framework'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { createLogger, errorLogFields } from '../logger'
import { AcpPromptPreparationOwner } from './prompt-preparation-owner'
import {
  AcpPromptTurnWorkflow,
  type AcpPromptTurnPlanWorkflow,
  type AcpPromptTurnWorkflowOptions
} from './prompt-turn-workflow'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'

type AcpRuntimePromptReloadHost = Readonly<{
  disconnect: AcpPromptTurnWorkflowOptions['disconnectForReload']
  resume: AcpPromptTurnWorkflowOptions['resumeAfterReload']
}>

type AcpRuntimePromptHost = Readonly<{
  plan: AcpPromptTurnPlanWorkflow
  reload: AcpRuntimePromptReloadHost
  onPromptEnded?: (sessionId: string, turnToken: string) => void
}>

const log = createLogger('acp')

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const acpErrorKind = (error: unknown): string | undefined => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind
    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Prompt projection and the original provider outcome take precedence over diagnostics.
  }
}

// Composes the complete Prompt workflow around authoritative Base and Session owners. The host is
// limited to Plan application policy and public reload re-entry; constructors never invoke it.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimePromptOwners = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  host: AcpRuntimePromptHost
) => {
  const callbacks = options.callbacks ?? {}
  const activeSession = (sessionId: string) =>
    session.sessionRegistry.lookup(sessionId)?.attachment?.session
  const currentFramework = () => base.backendGeneration.current.framework
  const projectId = (sessionId: string): string => session.sessionEnvironment.projectId(sessionId)
  const emitState = (): void => session.publication.emitState()
  const diagnosticContext = () => ({
    framework: currentFramework().id,
    generation: base.connectionResources.epoch,
    status: base.snapshotOwner.status
  })
  const emitSkillActivities = (
    sessionId: string,
    promptTurn: number,
    inputs: ReadonlyArray<{ name: string }>,
    status: 'in_progress' | 'completed' | 'failed'
  ): void => {
    for (const [index, { name }] of inputs.entries()) {
      session.publication.pushEvent({
        kind: 'tool',
        level: status === 'failed' ? 'error' : 'info',
        sessionId,
        toolCallId: `open-science-skill-${promptTurn}-${index}`,
        providerToolName: 'skill',
        title: `Loaded skill: ${name}`,
        status
      })
    }
  }
  const openArtifact = async (
    sessionId: string,
    executionId: string,
    provenanceContext: AcpPromptRequest['provenanceContext']
  ): Promise<ArtifactTurnHandle | undefined> => {
    if (!base.artifactTurns) return undefined
    return base.artifactTurns.openRootExecution({
      executionId,
      appSessionId: sessionId,
      artifactStorageSessionId:
        base.sessionCapabilities.artifactRoutingIdFor(sessionId) ?? sessionId,
      projectId: projectId(sessionId),
      agentName: currentFramework().displayName,
      provenanceContext
    })
  }
  const publishArtifact = async (
    sessionId: string,
    artifact: ArtifactTurnHandle | undefined,
    onPublished?: () => void
  ): Promise<void> => {
    if (!artifact || !base.artifactTurns) return
    const publication = await base.artifactTurns.finalize(artifact)
    if (!publication) return
    session.publication.pushEvent(
      {
        kind: 'artifact',
        level: 'info',
        sessionId,
        title: 'Generated files',
        runId: publication.runId,
        promptMessageId: publication.promptMessageId,
        artifactSessionId: publication.artifactStorageSessionId,
        artifactClaimId: publication.artifactClaimId,
        artifacts: publication.artifacts
      },
      onPublished
    )
  }
  const disposeArtifact = async (artifact: ArtifactTurnHandle | undefined): Promise<void> => {
    if (artifact) await base.artifactTurns?.dispose(artifact)
  }

  const promptPreparation = new AcpPromptPreparationOwner({
    promptContent: base.promptContentOwner,
    imageInputCompatibility: options.imageInputCompatibility,
    presentation: base.sessionPresentationPolicy,
    contextUsage: base.contextUsageTracker,
    selectBridgeSkills: async (text, catalog, signal, observeUsage) =>
      (await base.connectionResources.selectBridgeSkills(text, catalog, signal, observeUsage)) ??
      [],
    authorizeReferencedUploads: options.skillImport?.authorizeReferencedUploads,
    memory: options.memory,
    isMemoryEnabledForSession: (sessionId) =>
      session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().memoryEnabled ?? false,
    ...(options.notebook
      ? {
          notebook: {
            peekHandoffContext: options.notebook.peekHandoffContext,
            registerTurnInputs: options.notebook.registerTurnInputs
          }
        }
      : {}),
    emitState
  })
  const beforeFrameworkPromptDispatch = async (input: {
    appSessionId: string
    framework: AgentFramework
    providerSessionId: string
    cwd: string
    skillRuntimeAllowlist?: readonly string[]
  }): Promise<void> => {
    if (!input.framework.beforePromptDispatch) return
    const connection = base.connectionResources.connection
    if (!connection) throw new Error('ACP connection is not available.')
    await input.framework.beforePromptDispatch({
      connection,
      providerSessionId: input.providerSessionId,
      cwd: input.cwd,
      mcpServers: base.sessionCapabilities.mcpServersFor(input.appSessionId),
      ...(input.skillRuntimeAllowlist ? { skillRuntimeAllowlist: input.skillRuntimeAllowlist } : {})
    })
  }
  const contextCompactionWorkflow = new AcpContextCompactionWorkflow({
    sessions: { activeSession, currentFramework },
    interactions: base.sessionInteractions,
    context: base.contextUsageTracker,
    promptContent: base.promptContentOwner,
    contextEstimateInput: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).estimateInput,
    selectedContextWindow: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).selectedWindow,
    routeHiddenNotification: (notification, sessionId) =>
      session.sessionUpdateProjector.route(notification, {
        appSessionId: sessionId,
        visible: false,
        emitState: () => {
          try {
            emitState()
          } catch (error) {
            safeLogError('compaction state callback failed', error)
          }
        }
      }),
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    errorMessage,
    beforePromptDispatch: async ({ appSessionId, session: active }) => {
      const framework = currentFramework()
      await beforeFrameworkPromptDispatch({
        appSessionId,
        framework,
        providerSessionId: active.sessionId,
        cwd:
          session.sessionRegistry.lookup(appSessionId)?.aggregate.snapshot().cwd ??
          base.snapshotOwner.cwd,
        skillRuntimeAllowlist: []
      })
    },
    serialization: base.providerPromptSerialization,
    ...(options.auxiliaryUsage
      ? {
          usage: {
            begin: (input) => base.providerPromptExecutor.beginObservation(input),
            cwd: (sessionId) =>
              session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd ??
              base.snapshotOwner.cwd,
            model: () =>
              base.backendGeneration.current.context.model ??
              base.backendGeneration.current.session.model,
            record: async ({ sessionId, eventId, frameworkId, model, completedAtMs, facts }) => {
              const projectId = await options.auxiliaryUsage!.projectIdForSession(sessionId)
              if (!projectId) return
              await options.auxiliaryUsage!.record({
                projectId,
                sessionId,
                eventId,
                source: 'context-compaction',
                frameworkId,
                ...(base.backendGeneration.current.providerId
                  ? { providerId: base.backendGeneration.current.providerId }
                  : {}),
                model,
                completedAtMs,
                usage: {
                  ...facts.turnUsage!,
                  ...(facts.modelTurnCount === undefined ? {} : { turnCount: facts.modelTurnCount })
                }
              })
            }
          }
        }
      : {}),
    cancelCompaction: async (sessionId) => {
      const connection = base.connectionResources.connection
      const active = activeSession(sessionId)
      if (!connection || !active) {
        throw new Error(`ACP session not found: ${sessionId}`)
      }
      await connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: active.sessionId
      })
    }
  })
  const promptTurnWorkflow = new AcpPromptTurnWorkflow({
    registry: session.sessionRegistry,
    interactions: base.sessionInteractions,
    skills: base.turnSkills,
    preparation: promptPreparation,
    executor: base.providerPromptExecutor,
    serialization: base.providerPromptSerialization,
    contextUsage: base.contextUsageTracker,
    providerReconnectPending: () => base.connectionTransitions.providerReconnectPending,
    finalizer: base.promptOutcomeFinalizer,
    permission: session.permissionContext,
    environment: {
      connectionGeneration: () => base.connectionResources.epoch,
      backend: () => base.backendGeneration.current,
      tooling: () => session.sessionEnvironment.toolingAvailability(),
      role: () => session.sessionEnvironment.role(),
      bridgeSkillsAvailable: () => base.connectionResources.bridgeSkillsAvailable,
      skillImportEnabled: () => base.sessionCapabilities.isSkillImportEnabled(),
      contextEstimateInput: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).estimateInput,
      selectedContextWindow: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).selectedWindow,
      ...(options.resolveComputeExecutionTargetIds
        ? { resolveComputeExecutionTargetIds: options.resolveComputeExecutionTargetIds }
        : {}),
      emitSkillActivities,
      onSkillImportAttachmentEligible: callbacks.onSkillImportAttachmentEligible,
      onProviderPromptAccepted: callbacks.onProviderPromptAccepted,
      sideChatRelays: options.sideChatRelays,
      routeNotification: (notification, sessionId) =>
        session.sessionUpdateProjector.route(notification, { appSessionId: sessionId }),
      diagnosticContext,
      pushUserMessage: ({ sessionId, promptMessageId, text, attribution }) =>
        session.publication.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId,
          // App-routed prompts (for example an Auditor correction) do not already exist in the
          // renderer store. Reuse the provenance id so the durable graph and Artifact claim share
          // one Prompt owner instead of inventing two identities for the same turn.
          ...(promptMessageId ? { promptMessageId, messageId: promptMessageId } : {}),
          role: 'user',
          ...(attribution ? { attribution } : {}),
          text
        }),
      beforePromptDispatch: beforeFrameworkPromptDispatch
    },
    artifacts: {
      open: openArtifact,
      promptMessageIdFor: (artifact) =>
        artifact ? base.artifactTurns?.snapshot(artifact).promptMessageId : undefined,
      publish: publishArtifact,
      dispose: disposeArtifact
    },
    plan: host.plan,
    finalization: {
      errorMessage,
      errorKind: acpErrorKind,
      pushEvent: (event) => session.publication.pushEvent(event),
      onPromptEnded: (sessionId, turnToken) => {
        host.onPromptEnded?.(sessionId, turnToken)
        callbacks.onPromptEnded?.(sessionId, turnToken)
      },
      generationActivityChanged: base.notifyGenerationActivityChanged,
      autoCompact: (sessionId, active, interaction) =>
        contextCompactionWorkflow.compactAutomatic({
          sessionId,
          session: active,
          interaction
        }),
      compactIfIdle: (sessionId) => contextCompactionWorkflow.compactIfIdle(sessionId),
      preemptCompaction: (sessionId) => contextCompactionWorkflow.preemptForPrompt(sessionId)
    },
    currentCwd: () => base.snapshotOwner.cwd,
    resolveProjectId: projectId,
    disconnectForReload: host.reload.disconnect,
    resumeAfterReload: host.reload.resume,
    recordAdmittedPrompt: (request) => base.handoffContinuity.recordAdmittedPrompt(request),
    onPromptStarted: (sessionId, turnToken, promptAttemptId) =>
      callbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId),
    emitState
  })

  return Object.freeze({ contextCompactionWorkflow, promptTurnWorkflow })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimePromptOwners = ReturnType<typeof composeAcpRuntimePromptOwners>

export { composeAcpRuntimePromptOwners }
export type { AcpRuntimePromptHost, AcpRuntimePromptOwners }
