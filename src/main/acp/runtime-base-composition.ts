import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { claudeCodeFramework } from '../agent-framework'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { readCurrentRunContext } from '../artifacts/mcp-server'
import { createLogger, errorLogFields } from '../logger'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { createProductionPlanService } from '../session-plan/production-plan-service'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { AcpAgentConnectionAdapter } from './agent-connection-adapter'
import { AcpBackendGenerationOwner } from './backend-generation-owner'
import type { AcpConnectionCloseWorkflow } from './connection-close-workflow'
import { AcpConnectionResourceOwner } from './connection-resource-owner'
import { AcpConnectionTransitionOwner } from './connection-transition-owner'
import { ContextUsageTracker } from './context-usage-tracker'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import { AcpGenerationActivityOwner } from './generation-activity-owner'
import { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import type { AcpModelChangeWorkflow } from './model-change-workflow'
import { AcpPromptContentOwner } from './prompt-content-owner'
import { AcpPromptOutcomeFinalizer } from './prompt-outcome-finalizer'
import { AcpProviderPromptExecutor } from './provider-prompt-executor'
import { AcpProviderPromptSerializationOwner } from './provider-prompt-serialization-owner'
import type { ReviewerSessionOwner } from './reviewer-session-owner'
import type { AcpRuntimeOptions } from './runtime'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { AcpSessionCapabilityOwner } from './session-capability-owner'
import { AcpSessionConfigurator } from './session-configurator'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { ArtifactTurnOwner } from './artifact-turn-owner'
import { AcpTurnSkillOwner } from './turn-skill-owner'
import { TurnResourceSnapshotStore } from './turn-resource-snapshot-store'
import type { ArtifactLiteratureRequest } from '../../shared/artifact-literature'

const log = createLogger('acp')

type AcpGenerationConnectionEffects = Readonly<{
  reviewerSessions: Pick<ReviewerSessionOwner, 'hasActiveSessions'>
  modelChanges: Pick<AcpModelChangeWorkflow, 'activityChanged'>
  connectionClose: Pick<
    AcpConnectionCloseWorkflow,
    'disconnect' | 'recoverFailedDeferredDisconnect'
  >
  publishIdle: () => void
}>

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Transition recovery and the original failure take precedence over diagnostic sinks.
  }
}

// Composes base owners before Runtime. The generation/connection group exposes one bind-once seam
// for the workflows constructed later; no owner can observe a partial Runtime during construction.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimeBaseOwners = (options: AcpRuntimeOptions) => {
  const callbacks = options.callbacks ?? {}
  const snapshotOwner = new AcpRuntimeSnapshotOwner(resolve(options.defaultCwd))
  const connectionResources = new AcpConnectionResourceOwner({
    closeMcpHost: async () => {
      await options.mcpHttpHost?.close()
    }
  })
  const backendGeneration = new AcpBackendGenerationOwner(options.framework ?? claudeCodeFramework)
  const contextUsageTracker = options.contextUsageTracker ?? new ContextUsageTracker()
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const sessionInteractions = new AcpSessionInteractionOwner({
    cancelTimeoutMs: options.cancelTimeoutMs,
    setTimer,
    clearTimer
  })
  const artifactRepository = options.artifacts
    ? (options.artifacts.repository ?? new ArtifactRepository(options.artifacts.dataRoot))
    : undefined
  const artifactRunRegistry = options.artifacts
    ? (options.artifacts.runRegistry ?? new ArtifactRunRegistry())
    : undefined
  const artifactTurns =
    options.artifacts &&
    !options.artifacts.currentRunFile &&
    artifactRepository &&
    artifactRunRegistry
      ? new ArtifactTurnOwner({
          dataRoot: options.artifacts.dataRoot,
          repository: artifactRepository,
          runRegistry: artifactRunRegistry,
          issueRpcCapability: options.artifacts.issueRpcCapability,
          revokeRpcCapability: options.artifacts.revokeRpcCapability,
          provenance: options.artifacts.provenance,
          ...(options.notebook
            ? {
                notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(
                  options.artifacts.dataRoot
                ),
                notebook: {
                  setArtifactTurnBinding: options.notebook.setArtifactTurnBinding,
                  clearArtifactTurnBinding: options.notebook.clearArtifactTurnBinding
                }
              }
            : {})
        })
      : undefined
  const publishPreparedLiteratureArtifact = async (
    appSessionId: string,
    projectId: string,
    input: {
      filename: string
      contentBase64: string
      mimeType: string
      literature: ArtifactLiteratureRequest
      toolId: 'format_citation_document' | 'prepare_latex_bundle'
      normalizedArguments: Record<string, string>
    }
  ): Promise<void> => {
    const interaction = sessionInteractions.current(appSessionId)
    if (interaction?.kind !== 'prompt') {
      throw new Error('No active assistant turn to attach the prepared Literature file to.')
    }
    const producer = {
      kind: 'connector' as const,
      connectorId: 'open-science-library',
      toolId: input.toolId,
      invocationId: randomUUID(),
      implementationVersion: '1',
      normalizedArguments: input.normalizedArguments
    }
    if (artifactTurns) {
      await artifactTurns.write(artifactTurns.handleForExecution(interaction.turnToken), {
        filename: input.filename,
        content: input.contentBase64,
        encoding: 'base64',
        mimeType: input.mimeType,
        literature: input.literature,
        producer
      })
      return
    }

    const currentRunFile = options.artifacts?.currentRunFile
    const provenance = options.artifacts?.provenance
    if (!currentRunFile || !provenance) {
      throw new Error('No active assistant turn to attach the prepared Literature file to.')
    }
    const context = await readCurrentRunContext(currentRunFile)
    if (
      context.appSessionId !== appSessionId ||
      !context.artifactStorageSessionId ||
      !context.rootFrameId ||
      !context.agentFrameId ||
      !context.messageBranchId ||
      !context.runtimeSegmentId ||
      !context.promptMessageId
    ) {
      throw new Error('The active Artifact turn does not match this Literature session.')
    }
    await provenance.writeAppGeneratedVersion({
      projectId,
      appSessionId,
      artifactStorageSessionId: context.artifactStorageSessionId,
      artifactRunId: context.artifactRunId,
      rootFrameId: context.rootFrameId,
      agentFrameId: context.agentFrameId,
      messageBranchId: context.messageBranchId,
      messageBranchAncestry: context.messageBranchAncestry ?? [],
      messageAncestry: context.messageAncestry ?? [],
      runtimeSegmentId: context.runtimeSegmentId,
      promptMessageId: context.promptMessageId,
      agentName: context.agentName,
      filename: input.filename,
      content: input.contentBase64,
      encoding: 'base64',
      contentType: input.mimeType,
      literature: input.literature,
      producer
    })
  }
  const sessionCapabilities = new AcpSessionCapabilityOwner({
    artifacts: options.artifacts,
    notebook: options.notebook,
    skillImport: options.skillImport,
    plan: options.plan,
    sideChat: options.sideChat,
    wslSetupSessions: options.wslSetupSessions,
    literature: options.literature
      ? {
          isEnabled: options.literature.isEnabled,
          handlerFor: (appSessionId, projectId) => ({
            readDocument: (input) => {
              const interaction = sessionInteractions.current(appSessionId)
              if (interaction?.kind !== 'prompt' || !interaction.promptMessageId) {
                return Promise.reject(
                  new Error(
                    'NO_LINKED_PDF_CONTEXT: Literature tools require an active message with a linked PDF snapshot.'
                  )
                )
              }
              return options.literature!.readDocument({
                projectId,
                sessionId: appSessionId,
                promptMessageId: interaction.promptMessageId,
                input
              })
            }
          })
        }
      : undefined,
    library: options.literatureLibrary
      ? {
          handlerFor: (appSessionId, projectId, workspaceCwd) => ({
            searchLibrary: async (request) => {
              const interaction = sessionInteractions.current(appSessionId)
              const result = await options.literatureLibrary!.searchLibrary({
                ...request,
                projectId
              })
              if (
                interaction?.kind === 'prompt' &&
                interaction.promptMessageId &&
                !interaction.signal.aborted &&
                sessionInteractions.current(appSessionId) === interaction
              ) {
                options.artifacts?.provenance?.recordLiteratureSearch?.({
                  projectId,
                  appSessionId,
                  promptMessageId: interaction.promptMessageId,
                  scope: request.scope ?? 'project',
                  ...(request.query ? { query: request.query } : {}),
                  ...(request.collectionId ? { collectionId: request.collectionId } : {}),
                  ...(request.itemIds ? { itemIds: [...request.itemIds] } : {}),
                  ...(request.offset === undefined ? {} : { offset: request.offset }),
                  ...(request.limit === undefined ? {} : { limit: request.limit }),
                  result
                })
              }
              return result
            },
            readAbstract: async (request) => {
              const interaction = sessionInteractions.current(appSessionId)
              const result = await options.literatureLibrary!.readAbstract({
                ...request,
                projectId
              })
              if (
                result?.abstract.trim() &&
                interaction?.kind === 'prompt' &&
                interaction.promptMessageId &&
                !interaction.signal.aborted &&
                sessionInteractions.current(appSessionId) === interaction
              ) {
                options.artifacts?.provenance?.recordLiteratureAbstractRead?.({
                  projectId,
                  appSessionId,
                  promptMessageId: interaction.promptMessageId,
                  itemId: result.itemId
                })
              }
              return result
            },
            readPdf: async (request) => {
              const interaction = sessionInteractions.current(appSessionId)
              const result = await options.literatureLibrary!.readPdf({
                ...request,
                projectId
              })
              const passages = result?.evidence.passages
              const hasContent =
                Array.isArray(passages) &&
                passages.some(
                  (passage) =>
                    passage && typeof passage.content === 'string' && passage.content.trim()
                )
              if (
                hasContent &&
                interaction?.kind === 'prompt' &&
                interaction.promptMessageId &&
                !interaction.signal.aborted &&
                sessionInteractions.current(appSessionId) === interaction
              ) {
                options.artifacts?.provenance?.recordLiteraturePdfRead?.({
                  projectId,
                  appSessionId,
                  promptMessageId: interaction.promptMessageId,
                  itemId: request.itemId
                })
              }
              return result
            },
            ...(options.literatureLibrary!.resolveSaveReferences
              ? {
                  resolveSaveReferences: (references: readonly string[], signal?: AbortSignal) =>
                    options.literatureLibrary!.resolveSaveReferences!(references, signal)
                }
              : {}),
            ...(options.literatureLibrary!.readCandidateFile
              ? {
                  readCandidateFile: (filename: string, signal?: AbortSignal) =>
                    options.literatureLibrary!.readCandidateFile!({
                      projectId,
                      sessionId: appSessionId,
                      workspaceCwd,
                      filename,
                      signal
                    })
                }
              : {}),
            ...(options.literatureLibrary!.formatReferences
              ? {
                  formatReferences: (request) =>
                    options.literatureLibrary!.formatReferences!({ ...request, projectId })
                }
              : {}),
            ...(options.literatureLibrary!.formatCitationDocument
              ? {
                  formatCitationDocument: async (request) => {
                    const prepared = await options.literatureLibrary!.formatCitationDocument!({
                      ...request,
                      projectId,
                      sessionId: appSessionId,
                      workspaceCwd
                    })
                    await publishPreparedLiteratureArtifact(appSessionId, projectId, {
                      filename: prepared.filename,
                      contentBase64: prepared.contentBase64,
                      mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      literature: prepared.literature,
                      toolId: 'format_citation_document',
                      normalizedArguments: {
                        filename: request.filename,
                        styleId: request.styleId,
                        locale: request.locale
                      }
                    })
                    return {
                      filename: prepared.filename,
                      citationCount: prepared.citationCount,
                      referenceCount: prepared.referenceCount
                    }
                  }
                }
              : {}),
            ...(options.literatureLibrary!.prepareLatexBundle
              ? {
                  prepareLatexBundle: async (request) => {
                    const prepared = await options.literatureLibrary!.prepareLatexBundle!({
                      ...request,
                      projectId,
                      sessionId: appSessionId,
                      workspaceCwd
                    })
                    await publishPreparedLiteratureArtifact(appSessionId, projectId, {
                      filename: prepared.filename,
                      contentBase64: prepared.contentBase64,
                      mimeType: 'application/zip',
                      literature: prepared.literature,
                      toolId: 'prepare_latex_bundle',
                      normalizedArguments: { filename: request.filename }
                    })
                    return {
                      filename: prepared.filename,
                      citationCount: prepared.citationCount,
                      referenceCount: prepared.referenceCount
                    }
                  }
                }
              : {}),
            saveToInbox: (request) =>
              options.literatureLibrary!.saveToInbox({
                ...request,
                projectId,
                sessionId: appSessionId
              }),
            ...(options.literatureLibrary!.acquirePdf
              ? {
                  acquirePdf: (request) =>
                    options.literatureLibrary!.acquirePdf!({
                      ...request,
                      projectId,
                      sessionId: appSessionId
                    })
                }
              : {})
          })
        }
      : undefined,
    mcpHttpHost: options.mcpHttpHost
  })
  let generationConnectionEffects: AcpGenerationConnectionEffects | undefined
  const effects = (): AcpGenerationConnectionEffects => {
    if (!generationConnectionEffects) {
      throw new Error('ACP generation/connection effects are not bound.')
    }
    return generationConnectionEffects
  }
  const generationActivityChanged = (): void => {
    connectionTransitions.activityChanged()
    effects().modelChanges.activityChanged()
  }
  const generationActivity = new AcpGenerationActivityOwner({
    activityChanged: generationActivityChanged,
    hasActivePrompts: () => sessionInteractions.snapshot().length > 0,
    hasActiveReviewerSessions: () => effects().reviewerSessions.hasActiveSessions()
  })
  const connectionTransitions = new AcpConnectionTransitionOwner({
    blockers: () => generationActivity.blockers(),
    connectionGeneration: () => connectionResources.epoch,
    disconnect: (emitClosedStatus) => effects().connectionClose.disconnect(emitClosedStatus),
    onRetired: () => callbacks.onRetired?.(),
    publishIdle: () => effects().publishIdle(),
    recoverFailedDeferredDisconnect: (_error, disconnectedGeneration) =>
      effects().connectionClose.recoverFailedDeferredDisconnect(disconnectedGeneration),
    reportFailure: safeLogError
  })
  const bindGenerationConnectionEffects = (next: AcpGenerationConnectionEffects): void => {
    if (generationConnectionEffects) {
      throw new Error('ACP generation/connection effects are already bound.')
    }
    generationConnectionEffects = next
  }
  const turnSkills = new AcpTurnSkillOwner({
    resolveSpecialistSkills: options.resolveSpecialistSkills,
    skills: options.skills,
    requestSkillsReload: () => connectionTransitions.requestSkillsReload()
  })
  const sessionConfigurator = new AcpSessionConfigurator({
    assertCurrentConnection: (connection) => {
      if (connectionResources.connection !== connection || snapshotOwner.status !== 'connected') {
        throw new Error('ACP session startup was superseded.')
      }
    },
    diagnosticContext: (backend) => ({
      framework: backend.framework.id,
      generation: connectionResources.epoch,
      status: snapshotOwner.status
    })
  })
  const planInteractions = new SessionPlanInteractionOwner()
  const planService =
    options.plan && artifactTurns && options.artifacts?.managedFileVersions
      ? createProductionPlanService({
          interactions: planInteractions,
          artifactTurns,
          managedFileVersions: options.artifacts.managedFileVersions,
          sessions: options.plan.sessions,
          onApprovalRequested: options.plan.onApprovalRequested,
          onApprovalSettled: options.plan.onApprovalSettled
        })
      : undefined
  const uploadRepository = options.uploads?.repository
  const fileReferenceResolver = createManagedFileReferenceResolver({
    uploads: uploadRepository,
    artifacts: artifactRepository,
    literature: options.literature?.resolveAttachmentVersion
      ? { resolveVersion: options.literature.resolveAttachmentVersion }
      : undefined,
    grantedRoots: options.grantedRoots,
    managedFileVersions: options.artifacts?.managedFileVersions
  })
  const notebookInputStorageRoot = options.notebook ? options.artifacts?.dataRoot : undefined

  return Object.freeze({
    snapshotOwner,
    connectionAdapter: new AcpAgentConnectionAdapter(),
    connectionResources,
    handoffContinuity: new AcpHandoffContinuityOwner(),
    backendGeneration,
    providerPromptExecutor: new AcpProviderPromptExecutor({
      backendGeneration,
      opencodeUsageFetch: options.opencodeUsageFetch
    }),
    providerPromptSerialization: new AcpProviderPromptSerializationOwner(),
    contextUsageTracker,
    setTimer,
    clearTimer,
    sessionInteractions,
    sessionCapabilities,
    generationActivity,
    notifyGenerationActivityChanged: generationActivityChanged,
    connectionTransitions,
    bindGenerationConnectionEffects,
    turnSkills,
    sessionConfigurator,
    artifactRepository,
    artifactRunRegistry,
    artifactTurns,
    planInteractions,
    planService,
    promptContentOwner: new AcpPromptContentOwner({
      uploadRepository,
      managedFileVersions: options.artifacts?.managedFileVersions,
      fileReferenceResolver,
      inlineImageBudgetBytes: options.inlineImageBudgetBytes,
      ...(notebookInputStorageRoot
        ? {
            createResourceSnapshotStore: ({ appSessionId, projectId }) =>
              new TurnResourceSnapshotStore({
                temporaryRoot: getNotebookInputRoot(
                  notebookInputStorageRoot,
                  projectId,
                  appSessionId
                )
              })
          }
        : {})
    }),
    sessionPresentationPolicy: new AcpSessionPresentationPolicy(),
    promptOutcomeFinalizer: new AcpPromptOutcomeFinalizer()
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeBaseOwners = ReturnType<typeof composeAcpRuntimeBaseOwners>

export { composeAcpRuntimeBaseOwners }
export type { AcpGenerationConnectionEffects, AcpRuntimeBaseOwners }
