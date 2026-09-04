import type { ClientConnection } from '@agentclientprotocol/sdk'

import { ACP_PROMPT_FAILED_EVENT_TITLE, type AcpConnectRequest } from '../../shared/acp'
import type { AgentFramework } from '../agent-framework'
import { createLogger, errorLogFields } from '../logger'
import type { AcpAgentConnectionCandidate } from './agent-connection-adapter'
import { AcpConnectionCloseWorkflow, type CloseState } from './connection-close-workflow'
import { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'
import type { AcpConnectionResourceAttempt } from './connection-resource-owner'
import { AcpModelChangeWorkflow } from './model-change-workflow'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'

const log = createLogger('acp')

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, error)
  } catch {
    // Lifecycle recovery and the original failure take precedence over diagnostic sinks.
  }
}

type AcpRuntimeLifecycleHost = Readonly<{
  connect: (request: AcpConnectRequest) => ReturnType<AcpConnectionLifecycleWorkflow['connect']>
  disconnect: (emitClosedStatus?: boolean) => ReturnType<AcpConnectionCloseWorkflow['disconnect']>
  openAgentConnection: (
    attempt: AcpConnectionResourceAttempt,
    onFrameworkResolved: (framework: AgentFramework['id']) => void
  ) => Promise<AcpAgentConnectionCandidate>
  clearPromptResources?: () => void
}>

// Composes the model/connection lifecycle cycle around authoritative base and Session owners.
// Host callbacks retain only structural facade operations and are never invoked during construction.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimeLifecycleOwners = (
  options: Pick<AcpRuntimeOptions, 'appVersion' | 'defaultCwd' | 'hasReplayableImageHistory'>,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  host: AcpRuntimeLifecycleHost
) => {
  const currentConnection = (): ClientConnection | undefined => base.connectionResources.connection
  const currentFramework = (): AgentFramework => base.backendGeneration.current.framework
  const diagnosticContext = (
    framework: AgentFramework['id'] = currentFramework().id,
    generation = base.connectionResources.epoch
  ) => ({ framework, generation, status: base.snapshotOwner.status })
  const setStatus = (status: Parameters<typeof base.snapshotOwner.transitionStatus>[0]): void => {
    base.snapshotOwner.transitionStatus(status)
    session.publication.emitState()
  }
  const invalidatePendingSessionStartups = (): void => {
    base.generationActivity.invalidateStartups()
    session.sessionRegistry.invalidatePending()
    session.reviewerSessions.invalidatePending()
  }
  const activeSessionIds = (): string[] =>
    session.sessionRegistry.entries(true).map(({ appSessionId }) => appSessionId)
  const closeState: CloseState = {
    invalidatePendingSessionStartups,
    disposePermissionContext: () => session.permissionContext.dispose(),
    disposeElicitationOwner: () => session.elicitationOwner.dispose(),
    clearPendingAppContinuations: () => session.appContinuations.clear(),
    clearReviewerState: () => session.reviewerSessions.clear(),
    clearPlanInteractions: () =>
      base.planInteractions.clearAll('The Session Plan interaction was disconnected.'),
    settleActivePrompts: () => base.sessionInteractions.settleActivePrompts(),
    supersedeInteractions: () => base.sessionInteractions.supersedeAll(),
    clearContextUsage: () => base.contextUsageTracker.clear(),
    clearAppliedSessionModels: () => session.sessionRegistry.clearAppliedModels(),
    activeSessionIds,
    disposeSessionCapabilities: (sessionIds) => base.sessionCapabilities.dispose(sessionIds),
    disposeActiveSessions: (recordFailure) => {
      for (const { attachment } of session.sessionRegistry.entries(true)) {
        if (!attachment) continue
        try {
          attachment.session.dispose()
        } catch (error) {
          recordFailure('primary-session', error)
        }
      }
    },
    detachSessionConnections: (clearPermissionProfile) => {
      for (const entry of session.sessionRegistry.entries()) {
        if (entry.attachment) session.sessionRegistry.detach(entry.attachment, 'connection')
        else entry.aggregate.detachConnection()
        if (clearPermissionProfile) entry.aggregate.setPermissionProfile(undefined)
      }
    },
    clearPromptContent: (connectionGeneration) => {
      host.clearPromptResources?.()
      if (connectionGeneration === undefined) base.promptContentOwner.clear()
      else base.promptContentOwner.clearGeneration(connectionGeneration)
    },
    clearHandoffContinuity: () => base.handoffContinuity.clearGeneration(),
    clearSessionProjection: () => session.sessionUpdateProjector.clearGeneration(),
    disposeSessionProjection: () => session.sessionUpdateProjector.dispose(),
    clearHttpRoutes: () => base.sessionCapabilities.clearHttpRoutes(),
    selectSession: () => session.sessionRegistry.select(undefined),
    publishInterruptedPromptFailures: (prompts) => {
      for (const { scope, terminal } of prompts as ReturnType<
        AcpSessionInteractionOwner['settleActivePrompts']
      >) {
        try {
          session.publication.pushEvent({
            kind: 'error',
            level: 'error',
            providerError: false,
            sessionId: scope.sessionId,
            ...(scope.promptMessageId ? { promptMessageId: scope.promptMessageId } : {}),
            timestamp: terminal.timestamp,
            title: ACP_PROMPT_FAILED_EVENT_TITLE,
            text: 'ACP connection closed'
          })
        } catch (error) {
          safeLogError('connection-close prompt event failed', errorLogFields(error))
        }
      }
    },
    cancelPendingStatePublication: () => session.publication.cancelPendingStatePublication(),
    setStatus,
    transitionStatus: (status) => base.snapshotOwner.transitionStatus(status),
    emitState: () => session.publication.emitState(),
    hasContextUsage: () => base.contextUsageTracker.hasUsage()
  }

  const modelChanges = new AcpModelChangeWorkflow({
    backendGeneration: base.backendGeneration,
    connectionResources: base.connectionResources,
    registry: session.sessionRegistry,
    configurator: base.sessionConfigurator,
    contextUsage: base.contextUsageTracker,
    currentStatus: () => base.snapshotOwner.status,
    providerReconnectPending: () => base.connectionTransitions.providerReconnectPending,
    isGenerationBusy: () => base.generationActivity.blockers().retirement,
    contextEstimateInput: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).estimateInput,
    hasReplayableImageHistory: options.hasReplayableImageHistory,
    emitState: () => session.publication.emitState(),
    requestReconnect: () => base.connectionTransitions.requestProviderReconnect(),
    recoverFailedReconnect: (disconnectedGeneration) =>
      connectionClose.recoverFailedDeferredDisconnect(disconnectedGeneration),
    reportReconnectFailure: (error) =>
      safeLogError('model-change reconnect failed', errorLogFields(error)),
    diagnosticContext
  })
  const connectionClose: AcpConnectionCloseWorkflow = new AcpConnectionCloseWorkflow({
    currentGeneration: () => base.connectionResources.epoch,
    currentStatus: () => base.snapshotOwner.status,
    getSnapshot: () => session.publication.getSnapshot(),
    transitions: base.connectionTransitions,
    resources: base.connectionResources,
    backendGeneration: base.backendGeneration,
    modelChanges,
    state: closeState,
    reportFailure: (message, error) => safeLogError(message, errorLogFields(error))
  })

  base.bindGenerationConnectionEffects({
    reviewerSessions: session.reviewerSessions,
    modelChanges,
    connectionClose: {
      disconnect: (emitClosedStatus) => host.disconnect(emitClosedStatus),
      recoverFailedDeferredDisconnect: (disconnectedGeneration) =>
        connectionClose.recoverFailedDeferredDisconnect(disconnectedGeneration)
    },
    publishIdle: () => setStatus('idle')
  })

  const connectionLifecycle = new AcpConnectionLifecycleWorkflow({
    appVersion: options.appVersion,
    defaultCwd: options.defaultCwd,
    currentConnection,
    currentStatus: () => base.snapshotOwner.status,
    currentGeneration: () => base.connectionResources.epoch,
    currentFramework: () => currentFramework().id,
    reconnectBarrier: () => base.connectionTransitions.barrier,
    connect: (request) => host.connect(request),
    getSnapshot: () => session.publication.getSnapshot(),
    connectResources: base.connectionResources,
    invalidatePendingSessionStartups,
    disconnectCurrent: (emitClosedStatus, generation) =>
      connectionClose.disconnectCurrent(emitClosedStatus, generation),
    updateCwd: (cwd) => base.snapshotOwner.updateCwd(cwd),
    updateError: (error) => base.snapshotOwner.updateError(error),
    setStatus,
    pushEvent: (event) => session.publication.pushEvent(event),
    transitionStatus: (status) => base.snapshotOwner.transitionStatus(status),
    emitState: () => session.publication.emitState(),
    diagnosticContext,
    openCandidate: (attempt, onFrameworkResolved) =>
      host.openAgentConnection(attempt, onFrameworkResolved)
  })

  return Object.freeze({ modelChanges, connectionClose, connectionLifecycle })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeLifecycleOwners = ReturnType<typeof composeAcpRuntimeLifecycleOwners>

export { composeAcpRuntimeLifecycleOwners }
export type { AcpRuntimeLifecycleHost, AcpRuntimeLifecycleOwners }
