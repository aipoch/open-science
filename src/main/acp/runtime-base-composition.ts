import { resolve } from 'node:path'

import { claudeCodeFramework } from '../agent-framework'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createLogger, errorLogFields } from '../logger'
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
  const sessionCapabilities = new AcpSessionCapabilityOwner({
    artifacts: options.artifacts,
    notebook: options.notebook,
    skillImport: options.skillImport,
    plan: options.plan,
    sideChat: options.sideChat,
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
                  setArtifactProvenanceContext: options.notebook.setArtifactProvenanceContext
                }
              }
            : {})
        })
      : undefined
  const planInteractions = new SessionPlanInteractionOwner()
  const planService =
    options.plan && artifactTurns && options.artifacts?.provenance?.resolveVersionContent
      ? createProductionPlanService({
          interactions: planInteractions,
          artifactTurns,
          provenance: {
            resolveVersionContent: (request) =>
              options.artifacts!.provenance!.resolveVersionContent!(request)
          },
          sessions: options.plan.sessions,
          onApprovalRequested: options.plan.onApprovalRequested,
          onApprovalSettled: options.plan.onApprovalSettled
        })
      : undefined
  const uploadRepository = options.uploads?.repository
  const fileReferenceResolver = createManagedFileReferenceResolver({
    uploads: uploadRepository,
    artifacts: artifactRepository,
    artifactVersions: options.artifacts?.provenance,
    grantedRoots: options.grantedRoots,
    managedFileVersions: options.artifacts?.managedFileVersions
  })

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
      fileReferenceResolver,
      inlineImageBudgetBytes: options.inlineImageBudgetBytes
    }),
    sessionPresentationPolicy: new AcpSessionPresentationPolicy(),
    promptOutcomeFinalizer: new AcpPromptOutcomeFinalizer()
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeBaseOwners = ReturnType<typeof composeAcpRuntimeBaseOwners>

export { composeAcpRuntimeBaseOwners }
export type { AcpGenerationConnectionEffects, AcpRuntimeBaseOwners }
