import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { SESSION_PLAN_SYSTEM_PROMPT_APPEND } from '../session-plan/guidance'
import { createLogger } from '../logger'
import { AcpAppContinuationOwner } from './app-continuation-owner'
import { AcpClientInteractionOwner } from './client-interaction-owner'
import { AcpContextUsagePolicy } from './context-usage-policy'
import { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'
import { AcpElicitationOwner } from './elicitation-owner'
import { AcpPermissionContext } from './permission-context'
import { AcpPermissionWaitOwner } from './permission-wait-owner'
import { ReviewerSessionOwner } from './reviewer-session-owner'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { RuntimeSnapshotProjection } from './runtime-snapshot-owner'
import { AcpSessionEnvironmentPolicy } from './session-environment-policy'
import { AcpSessionRegistry } from './session-registry'
import { AcpSessionUpdateProjector } from './session-update-projector'

const log = createLogger('acp')

/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimeSessionOwners = (options: AcpRuntimeOptions, base: AcpRuntimeBaseOwners) => {
  const callbacks = options.callbacks ?? {}
  const activeSessionIds = (): string[] =>
    sessionRegistry.entries(true).map(({ appSessionId }) => appSessionId)
  const promptInFlightSessionIds = (): string[] => {
    const interactions = base.sessionInteractions.snapshot()
    return Array.from(
      new Set([
        ...interactions.filter(({ kind }) => kind === 'prompt').map(({ sessionId }) => sessionId),
        ...interactions
          .filter(({ kind }) => kind === 'compaction')
          .map(({ sessionId }) => sessionId),
        ...appContinuations.sessionIds()
      ])
    )
  }
  const agentPromptInFlightSessionIds = (): string[] =>
    Array.from(
      new Set([
        ...base.sessionInteractions
          .snapshot()
          .filter(({ kind }) => kind === 'prompt')
          .map(({ sessionId }) => sessionId),
        ...appContinuations.sessionIds()
      ])
    )
  const snapshotProjection = (): RuntimeSnapshotProjection => {
    const sessionIds = activeSessionIds()
    const promptInFlightIds = promptInFlightSessionIds()
    const permissionProfiles: Record<string, SessionPermissionProfileState> = {}
    for (const { appSessionId: sessionId, aggregate } of sessionRegistry.entries()) {
      const profile = aggregate.snapshot().permissionProfile
      if (profile) permissionProfiles[sessionId] = profile as SessionPermissionProfileState
    }

    return {
      sessionId: sessionRegistry.currentSessionId,
      sessionIds,
      pendingElicitations: elicitationOwner.getPendingRequests(),
      pendingPermissions: permissionContext.getPendingRequests(),
      permissionProfiles,
      permissionGrants: Object.fromEntries(
        sessionIds.map((sessionId) => [sessionId, permissionContext.listGrants(sessionId)])
      ),
      contextUsageBySession: base.contextUsageTracker.usageSnapshot(),
      nativeContextCompactionSessionIds:
        base.backendGeneration.current.framework.contextCompaction.kind === 'native-command'
          ? sessionIds
          : [],
      promptInFlight: promptInFlightIds.length > 0,
      agentPromptInFlightSessionIds: agentPromptInFlightSessionIds(),
      promptInFlightSessionIds: promptInFlightIds
    }
  }
  const publication = new AcpRuntimePublicationOwner({
    snapshotOwner: base.snapshotOwner,
    interactions: base.sessionInteractions,
    snapshotProjection,
    callbacks
  })
  const appContinuations = new AcpAppContinuationOwner({
    activityChanged: base.notifyGenerationActivityChanged
  })
  base.generationActivity.bindAdditionalActivity(() => appContinuations.hasPending())
  const elicitationOwner = new AcpElicitationOwner({
    onProjection: (request, projection) => {
      publication.pushEvent({
        kind: 'tool',
        level: 'info',
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        promptMessageId: request.durable?.promptMessageId,
        title: request.message,
        status: 'in_progress',
        elicitation: projection
      })
    }
  })
  const sessionRegistry: AcpSessionRegistry = new AcpSessionRegistry({
    addStartupBlocker: (token) => base.generationActivity.acquireStartup(token),
    foreignIdentityCollision: (sessionIds): Error | undefined => {
      const pendingReviewerCollision: string | undefined = sessionIds.find((sessionId) =>
        reviewerSessions.hasPendingSessionId(sessionId)
      )
      if (pendingReviewerCollision) {
        return new Error(
          `Primary session id collision with pending reviewer: ${pendingReviewerCollision}`
        )
      }
      const activeReviewerCollision = sessionIds.find((sessionId) =>
        reviewerSessions.hasActiveSessionId(sessionId)
      )
      return activeReviewerCollision
        ? new Error(`Primary session id collision with reviewer: ${activeReviewerCollision}`)
        : undefined
    },
    removeStartupBlocker: (token) => base.generationActivity.releaseStartup(token)
  })
  const sessionEnvironment = new AcpSessionEnvironmentPolicy({
    backendGeneration: base.backendGeneration,
    capabilities: base.sessionCapabilities,
    presentation: base.sessionPresentationPolicy,
    registry: sessionRegistry,
    defaultProjectId: options.artifacts?.projectId,
    ...(options.sessionCapabilityPolicy
      ? { capabilityPolicy: options.sessionCapabilityPolicy }
      : {}),
    ...(base.planService ? { planSystemPromptAppend: SESSION_PLAN_SYSTEM_PROMPT_APPEND } : {})
  })
  const contextUsagePolicy = new AcpContextUsagePolicy({
    backend: () => base.backendGeneration.current,
    appliedModel: (sessionId) =>
      sessionRegistry.lookup(sessionId)?.aggregate.snapshot().appliedModel,
    systemPromptAppends: () => sessionEnvironment.systemPromptAppends(),
    tooling: () => sessionEnvironment.toolingAvailability()
  })
  const durableContinuationContext = new AcpDurableContinuationContextOwner(
    options.permissionWait?.sessions,
    options.permissionWait?.onContinuationSessionUpdated
  )
  const permissionWaitOwner = new AcpPermissionWaitOwner(
    options.permissionWait?.sessions,
    options.permissionWait?.onSessionUpdated
  )
  const permissionContext = new AcpPermissionContext({
    emitPermissionRequest: (request) => publication.publishPermissionRequest(request),
    routing: {
      resolveAppSessionId: (sessionId) => sessionRegistry.resolveAppSessionId(sessionId),
      sessionSnapshot: (sessionId) => {
        const snapshot = sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
        return snapshot
          ? {
              ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
              ...(snapshot.frameworkId === undefined ? {} : { frameworkId: snapshot.frameworkId }),
              ...(snapshot.permissionProfile === undefined
                ? {}
                : {
                    permissionProfile: {
                      ...snapshot.permissionProfile,
                      availableModeIds: [...snapshot.permissionProfile.availableModeIds]
                    }
                  })
            }
          : undefined
      },
      hasActivePrimarySession: (sessionId) =>
        sessionRegistry.lookup(sessionId)?.attachment !== undefined,
      capturePrompt: (sessionId) => {
        const scope = base.sessionInteractions.current(sessionId)
        return scope?.kind === 'prompt'
          ? {
              sequence: scope.sequence,
              promptMessageId: scope.promptMessageId,
              isCancellationAccepted: () => base.sessionInteractions.isCancellationAccepted(scope)
            }
          : undefined
      },
      currentInteractionSequence: (sessionId) =>
        base.sessionInteractions.current(sessionId)?.sequence,
      mcpServerNamesFor: (sessionId) => base.sessionCapabilities.mcpServerNamesFor(sessionId),
      reviewerContextFor: (sessionId) => reviewerSessions.contextFor(sessionId),
      resolveReviewerPermission: (request) => reviewerSessions.resolvePermission(request),
      currentFramework: () => base.backendGeneration.current.framework,
      resolveProjectId: (sessionId) => sessionEnvironment.projectId(sessionId)
    },
    conversationGrants: options.permissionGrantStore,
    permissionGrantRegistry: options.permissionGrantRegistry,
    permissionGrantContext: options.permissionGrantContext,
    permissionWaitHooks: {
      persist: (candidate) => permissionWaitOwner.persist(candidate),
      settleLive: (candidate) => permissionWaitOwner.clearLive(candidate)
    },
    setTimer: base.setTimer,
    clearTimer: base.clearTimer,
    onPermissionSettled: callbacks.onPermissionSettled,
    onToolPermissionSettled: (request, state, context) => {
      const frameworkId = sessionRegistry
        .lookup(request.sessionId)
        ?.aggregate.snapshot().frameworkId
      if (state === 'resolved' && frameworkId !== 'codebuddy') return
      publication.pushEvent({
        kind: 'tool',
        level: 'info',
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        promptMessageId: context?.promptMessageId,
        title: request.title,
        providerToolName: request.providerToolName ?? request.mcpIdentity,
        rawInput: request.rawInput,
        status:
          state === 'rejected'
            ? 'completed'
            : state === 'resolved'
              ? (request.status ?? 'in_progress')
              : 'in_progress',
        ...(state === 'resolved'
          ? {}
          : {
              toolDisposition:
                state === 'rejected' ? ('declined' as const) : ('permission-closed' as const)
            })
      })
    },
    onNotebookExecutionAuthorized: (authorization) => {
      const executionInvocationId = options.notebook?.authorizeExecution?.({
        sessionId: authorization.sessionId,
        toolCallId: authorization.toolCallId,
        promptMessageId: authorization.promptMessageId,
        method: authorization.method,
        rawInput: authorization.executionInput
      })
      if (!executionInvocationId) return
      publication.pushEvent({
        kind: 'tool',
        level: 'info',
        sessionId: authorization.sessionId,
        toolCallId: permissionContext.presentationToolCallId(
          authorization.sessionId,
          authorization.toolCallId
        ),
        promptMessageId: authorization.promptMessageId,
        title: authorization.title,
        providerToolName: authorization.providerToolName,
        rawInput: authorization.rawInput,
        status: 'in_progress',
        executionInvocationId
      })
    },
    onOpenCodeWaitTimeout: ({ sessionId, toolCallId, waitMs }) => {
      log.warn('OpenCode permission context wait timed out', { sessionId, toolCallId, waitMs })
    }
  })
  const reviewerSessions: ReviewerSessionOwner = new ReviewerSessionOwner({
    addStartupBlocker: (token) => base.generationActivity.acquireStartup(token),
    assertCurrentConnection: (connection) => {
      if (
        base.connectionResources.connection !== connection ||
        base.snapshotOwner.status !== 'connected'
      ) {
        throw new Error('ACP session startup was superseded.')
      }
    },
    clearPermissionCorrelations: (sessionId) =>
      permissionContext.clearCorrelationsForSession(sessionId),
    currentSessionSetup: () => ({
      framework: base.backendGeneration.current.framework,
      sessionOptions: base.backendGeneration.current.session.options
    }),
    currentStartupGeneration: () => sessionRegistry.startupGeneration,
    isPrimarySessionIdClaimed: (sessionId) => sessionRegistry.isIdentityClaimed(sessionId),
    onActiveSessionReleased: base.notifyGenerationActivityChanged,
    registerBridgeSession: (sessionId) =>
      base.connectionResources.registerBridgeReviewerSession(sessionId),
    removeStartupBlocker: (token) => base.generationActivity.releaseStartup(token),
    unregisterBridgeSession: (sessionId) =>
      base.connectionResources.unregisterBridgeReviewerSession(sessionId)
  })
  const clientInteractions = new AcpClientInteractionOwner({
    routing: {
      resolveAppSessionId: (sessionId) => sessionRegistry.resolveAppSessionId(sessionId),
      isActiveSession: (sessionId) => sessionRegistry.lookup(sessionId)?.attachment !== undefined,
      frameworkForSession: (sessionId) =>
        sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId,
      reviewerFrameworkForSession: (sessionId) =>
        reviewerSessions.contextFor(sessionId)?.frameworkId,
      promptMessageIdForSession: (sessionId) => {
        const interaction = base.sessionInteractions.current(sessionId)
        return interaction?.kind === 'prompt' ? interaction.promptMessageId : undefined
      }
    },
    elicitation: elicitationOwner,
    permission: permissionContext
  })
  const sessionUpdateProjector = new AcpSessionUpdateProjector({
    registry: sessionRegistry,
    contextUsage: base.contextUsageTracker,
    contextPolicy: contextUsagePolicy,
    hasActiveSession: (sessionId) => sessionRegistry.lookup(sessionId)?.attachment !== undefined,
    currentFramework: () => base.backendGeneration.current.framework.id,
    reconnectPending: () => base.connectionTransitions.providerReconnectPending,
    mcpServerNamesFor: (sessionId) => base.sessionCapabilities.mcpServerNamesFor(sessionId),
    presentationToolCallId: (notification, context, providerToolCallId) =>
      permissionContext.presentationToolCallIdForUpdate(notification, context) ??
      providerToolCallId,
    nextEventId: () => publication.nextEventId(),
    setProviderPermissionProfile: (sessionId, profile) =>
      permissionContext.setProviderPermissionProfile(sessionId, profile),
    emitState: () => publication.emitState(),
    pushEvent: (event) => publication.pushEvent(event),
    reportToolFailure: (effect) =>
      log.warn('tool call failed', {
        tool: effect.tool,
        toolCallId: effect.toolCallId,
        sessionId: effect.sessionId,
        reason: effect.reason
      })
  })

  return Object.freeze({
    sessionRegistry,
    sessionEnvironment,
    contextUsagePolicy,
    publication,
    appContinuations,
    elicitationOwner,
    durableContinuationContext,
    permissionWaitOwner,
    permissionContext,
    clientInteractions,
    reviewerSessions,
    sessionUpdateProjector
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeSessionOwners = ReturnType<typeof composeAcpRuntimeSessionOwners>

export { composeAcpRuntimeSessionOwners }
export type { AcpRuntimeSessionOwners }
