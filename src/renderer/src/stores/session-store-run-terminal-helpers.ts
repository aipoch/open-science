import {
  sanitizeAcpContextWindowSample,
  type AcpContextWindowSample,
  type AcpModelCallUsage,
  type AcpTurnTokenUsage
} from '../../../shared/acp'
import { isReportableRunFailure } from '../../../shared/run-error-classification'
import type {
  PersistedActivityGroup,
  PersistedChatSession,
  PersistedSessionResumeRecovery
} from '../../../shared/session-persistence'
import { synchronizeSessionGraph } from './session-store-message-graph-helpers'
import {
  completeOpenActivities,
  completeOpenActivityGroups,
  failOpenActivities
} from './session-store-run-activity-helpers'
import { projectSessionInteractionState } from './session-store-interaction-state'
import type { ChatMessage, ChatSession, ToolActivity } from './session-store-persistence-owner'

const ARTIFACT_ERROR_PREFIX = 'Generated file finalization failed'
const TERMINAL_ARTIFACT_ERROR_PREFIX = 'Generated file finalization cannot be retried'
export const isArtifactFinalizationError = (error: string | undefined): boolean =>
  error?.startsWith(ARTIFACT_ERROR_PREFIX) === true ||
  error?.startsWith(TERMINAL_ARTIFACT_ERROR_PREFIX) === true
export const isRetryableArtifactFinalizationError = (error: string | undefined): boolean =>
  error?.startsWith(ARTIFACT_ERROR_PREFIX) ?? false
const CONVERSATION_GRAPH_SYNC_ERROR =
  'Conversation history could not be finalized safely. Restart the app to restore the last saved conversation state, then report this issue.'

export type RunTerminalContextWindowSample = Omit<AcpContextWindowSample, 'runtimeSegmentId'>

const CLEARED_AGENT_RUN_STATE = {
  activeRun: undefined,
  activeRunRuntimeSegmentId: undefined,
  agentStatus: undefined,
  awaitingFirstAgentOutput: undefined,
  agentPromptInFlight: undefined,
  compacting: undefined,
  interactionState: undefined
} satisfies Pick<
  ChatSession,
  | 'activeRun'
  | 'activeRunRuntimeSegmentId'
  | 'agentStatus'
  | 'awaitingFirstAgentOutput'
  | 'agentPromptInFlight'
  | 'compacting'
  | 'interactionState'
>

const hasPendingPlanReview = (session: ChatSession): boolean =>
  session.activePlanProjection
    ? session.activePlanProjection.lifecycle === 'awaiting_approval' &&
      session.activePlanProjection.approval === 'pending'
    : session.runtimeContext?.plan?.approval === 'pending'

const settleConversationGraphSyncFailure = (
  session: ChatSession,
  input: {
    messages: ChatMessage[]
    activities?: ToolActivity[]
    activityGroups?: PersistedActivityGroup[]
    now: number
    cause: unknown
    runError?: string
  }
): ChatSession => {
  console.error('[session-store] conversation graph synchronization failed', {
    sessionId: session.id,
    cause: input.cause
  })
  return {
    ...session,
    status: 'error',
    ...CLEARED_AGENT_RUN_STATE,
    error: input.runError
      ? `${input.runError}\n\n${CONVERSATION_GRAPH_SYNC_ERROR}`
      : CONVERSATION_GRAPH_SYNC_ERROR,
    errorReportable: true,
    messages: input.messages,
    activities: input.activities,
    activityGroups: input.activityGroups,
    conversationGraph: session.conversationGraph,
    conversationGraphSyncBlocked: true,
    updatedAt: input.now
  }
}

const completeStreamingMessages = (
  messages: ChatMessage[],
  promptMessageId: string | undefined,
  turnUsage: AcpTurnTokenUsage | undefined,
  modelCallUsage: readonly AcpModelCallUsage[] | undefined,
  now: number
): ChatMessage[] => {
  const promptResponses = promptMessageId
    ? messages.filter(
        (message) => message.role === 'agent' && message.responseToMessageId === promptMessageId
      )
    : []
  const usageFooterMessageId = promptResponses.at(-1)?.id
  return messages.map((message) => {
    const completesStream = message.status === 'streaming'
    const ownsTurnUsageFooter = message.id === usageFooterMessageId
    const belongsToPrompt =
      promptMessageId !== undefined &&
      message.role === 'agent' &&
      message.responseToMessageId === promptMessageId
    if (!completesStream && !belongsToPrompt) return message
    const recordsCompletion =
      completesStream ||
      (ownsTurnUsageFooter && message.status === 'complete' && message.completedAt === undefined)
    return {
      ...message,
      ...(belongsToPrompt
        ? {
            turnUsage: undefined,
            turnUsageUnavailable: undefined,
            modelCallUsage: undefined
          }
        : {}),
      ...(completesStream ? { status: 'complete' as const } : {}),
      ...(recordsCompletion ? { completedAt: now } : {}),
      ...(ownsTurnUsageFooter
        ? turnUsage
          ? {
              turnUsage,
              modelCallUsage: modelCallUsage?.map((call) => ({ ...call }))
            }
          : { turnUsageUnavailable: true as const }
        : {}),
      updatedAt: now
    }
  })
}

const failStreamingMessages = (messages: ChatMessage[], now = Date.now()): ChatMessage[] =>
  messages.map((message) =>
    message.status === 'streaming'
      ? {
          ...message,
          status: 'error',
          failedAt: message.failedAt ?? now,
          updatedAt: now
        }
      : message
  )

const appendContextWindowSample = (
  session: ChatSession,
  messages: ChatMessage[],
  promptMessageId: string | undefined,
  sample: RunTerminalContextWindowSample | undefined,
  now: number
): ChatMessage[] => {
  if (!promptMessageId || !sample) return messages
  const runtimeSegmentId =
    session.activeRunRuntimeSegmentId ??
    session.conversationGraph?.messages.find((message) => message.id === promptMessageId)
      ?.runtimeSegmentId
  const sanitized = sanitizeAcpContextWindowSample({
    ...sample,
    ...(runtimeSegmentId ? { runtimeSegmentId } : {})
  })
  if (!sanitized) return messages

  return messages.map((message) => {
    if (
      message.id !== promptMessageId ||
      message.role !== 'user' ||
      message.contextWindowSamples?.some((candidate) => candidate.id === sanitized.id)
    ) {
      return message
    }
    return {
      ...message,
      contextWindowSamples: [...(message.contextWindowSamples ?? []), sanitized],
      updatedAt: Math.max(now, message.updatedAt + 1)
    }
  })
}

export const projectAwaitingFirstAgentOutput = (
  session: ChatSession,
  waiting: boolean
): ChatSession => ({
  ...session,
  awaitingFirstAgentOutput: waiting ? true : undefined
})

export const projectAgentPromptInFlight = (
  session: ChatSession,
  inFlight: boolean
): ChatSession => {
  const agentPromptInFlight = inFlight ? true : undefined
  const status =
    inFlight && session.status === 'idle'
      ? 'running'
      : !inFlight && session.status === 'running' && !session.activeRun
        ? 'idle'
        : session.status
  return session.agentPromptInFlight === agentPromptInFlight && session.status === status
    ? session
    : {
        ...session,
        agentPromptInFlight,
        status,
        ...(status !== session.status ? { updatedAt: Date.now() } : {})
      }
}

export const projectElicitationPending = (session: ChatSession, pending: boolean): ChatSession => {
  return projectSessionInteractionState(session, { elicitation: pending })
}

export const projectPermissionPending = (
  session: ChatSession,
  rearmAuthority = false
): ChatSession => {
  const runtimeContext = session.runtimeContext
  const permission = runtimeContext?.permission
  if (rearmAuthority && (!runtimeContext || permission?.state !== 'continuing')) return session
  let nextRuntimeContext = runtimeContext
  if (rearmAuthority && runtimeContext && permission) {
    nextRuntimeContext = { ...runtimeContext, permission: { ...permission, state: 'pending' } }
  }
  return projectSessionInteractionState(
    nextRuntimeContext === runtimeContext
      ? session
      : { ...session, runtimeContext: nextRuntimeContext },
    { permission: true }
  )
}

export const projectPermissionCleared = (
  session: ChatSession,
  authority?: 'continuing' | 'settled',
  requestId?: string
): ChatSession => {
  const runtimeContext = session.runtimeContext
  const permission = runtimeContext?.permission
  if (
    authority === 'continuing' &&
    (!runtimeContext ||
      permission?.state !== 'pending' ||
      permission.request.requestId !== requestId)
  ) {
    return session
  }
  let nextRuntimeContext = runtimeContext
  if (authority === 'continuing' && runtimeContext && permission) {
    nextRuntimeContext = { ...runtimeContext, permission: { ...permission, state: 'continuing' } }
  } else if (authority === 'settled' && runtimeContext && permission) {
    const settledRuntimeContext = { ...runtimeContext }
    delete settledRuntimeContext.permission
    nextRuntimeContext = settledRuntimeContext
  }
  return projectSessionInteractionState(
    nextRuntimeContext === runtimeContext
      ? session
      : { ...session, runtimeContext: nextRuntimeContext },
    { permission: false }
  )
}

export const projectArtifactError = (
  session: ChatSession,
  error: string,
  retryable = true,
  eventId?: string
): ChatSession => {
  const artifactErrorEventIds = eventId
    ? [
        ...new Set([
          ...(isArtifactFinalizationError(session.error)
            ? (session.artifactErrorEventIds ?? [])
            : []),
          eventId
        ])
      ]
    : session.artifactErrorEventIds
  return {
    ...session,
    status: 'error',
    error: `${retryable ? ARTIFACT_ERROR_PREFIX : TERMINAL_ARTIFACT_ERROR_PREFIX}: ${error}`,
    errorReportable: true,
    artifactErrorEventIds,
    updatedAt: Date.now()
  }
}

export const projectArtifactErrorCleared = (
  session: ChatSession,
  eventId?: string
): ChatSession => {
  if (!isArtifactFinalizationError(session.error)) return session
  if (eventId && session.artifactErrorEventIds?.length) {
    if (!session.artifactErrorEventIds.includes(eventId)) return session
    const artifactErrorEventIds = session.artifactErrorEventIds.filter(
      (candidate) => candidate !== eventId
    )
    if (artifactErrorEventIds.length > 0) return { ...session, artifactErrorEventIds }
  }
  return {
    ...session,
    status: session.activeRun ? 'running' : 'idle',
    error: undefined,
    errorReportable: undefined,
    artifactErrorEventIds: undefined,
    updatedAt: Date.now()
  }
}

export const projectFinishedRun = (
  session: ChatSession,
  turnUsage?: AcpTurnTokenUsage,
  promptMessageId?: string,
  contextWindowSample?: RunTerminalContextWindowSample,
  modelCallUsage?: readonly AcpModelCallUsage[]
): ChatSession => {
  const keepArtifactError = isArtifactFinalizationError(session.error)
  const now = Math.max(Date.now(), session.updatedAt + 1)
  const terminalPromptMessageId = promptMessageId ?? session.activeRun?.promptMessageId
  const messages = appendContextWindowSample(
    session,
    completeStreamingMessages(
      session.messages,
      terminalPromptMessageId,
      turnUsage,
      modelCallUsage,
      now
    ),
    terminalPromptMessageId,
    contextWindowSample,
    now
  )
  const activities = completeOpenActivities(session.activities)
  const activityGroups = completeOpenActivityGroups(session.activityGroups, now)
  let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
  try {
    conversationGraph = synchronizeSessionGraph(
      { ...session, messages, activities, activityGroups },
      messages,
      now
    )
  } catch (cause) {
    return settleConversationGraphSyncFailure(session, {
      messages,
      activities,
      activityGroups,
      now,
      cause
    })
  }
  const planAwaitingApproval = hasPendingPlanReview(session)
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: keepArtifactError ? 'error' : planAwaitingApproval ? 'waiting-plan-approval' : 'idle',
    error: keepArtifactError ? session.error : undefined,
    errorReportable: keepArtifactError ? session.errorReportable : undefined,
    resumeRecovery: undefined,
    interrupted: undefined,
    messages,
    activities,
    activityGroups,
    conversationGraph,
    conversationGraphSyncBlocked: undefined,
    updatedAt: now
  }
}

export const projectFailedRun = (
  session: ChatSession,
  error: string,
  reportable?: boolean,
  promptMessageId = session.activeRun?.promptMessageId,
  contextWindowSample?: RunTerminalContextWindowSample
): ChatSession => {
  const now = Math.max(Date.now(), session.updatedAt + 1)
  const messages = appendContextWindowSample(
    session,
    failStreamingMessages(session.messages, now),
    promptMessageId,
    contextWindowSample,
    now
  )
  const activities = failOpenActivities(session.activities)
  const activityGroups = completeOpenActivityGroups(session.activityGroups, now)
  let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
  try {
    conversationGraph = synchronizeSessionGraph(
      { ...session, messages, activities, activityGroups },
      messages,
      now
    )
  } catch (cause) {
    return settleConversationGraphSyncFailure(session, {
      messages,
      activities,
      activityGroups,
      now,
      cause,
      runError: error
    })
  }
  const planAwaitingApproval = hasPendingPlanReview(session)
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: planAwaitingApproval ? 'waiting-plan-approval' : 'error',
    error: planAwaitingApproval ? undefined : error,
    errorReportable: planAwaitingApproval
      ? undefined
      : (reportable ?? isReportableRunFailure(error)),
    messages,
    activities,
    activityGroups,
    conversationGraph,
    conversationGraphSyncBlocked: undefined,
    updatedAt: now
  }
}

export const projectAgentStatus = (session: ChatSession, text: string): ChatSession =>
  session.status === 'running' ? { ...session, agentStatus: text } : session

export const projectCompactionStarted = (
  session: ChatSession,
  supersedeActiveRun = false
): ChatSession => {
  if (session.activeRun && !supersedeActiveRun) return session
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: 'idle',
    error: undefined,
    errorReportable: undefined,
    compacting: true,
    messages: failStreamingMessages(session.messages),
    activities: failOpenActivities(session.activities),
    activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
    updatedAt: Date.now()
  }
}

export const projectCompactionFinished = (session: ChatSession): ChatSession =>
  session.compacting && !session.activeRun
    ? { ...session, status: 'idle', compacting: undefined, updatedAt: Date.now() }
    : session

export const projectCompactionFailed = (session: ChatSession, error: string): ChatSession =>
  session.compacting && !session.activeRun
    ? {
        ...session,
        status: 'error',
        compacting: undefined,
        error,
        errorReportable: false,
        updatedAt: Date.now()
      }
    : session

export const projectInterruptedRun = (
  session: ChatSession,
  recoveryCause: PersistedSessionResumeRecovery['cause'],
  error: string,
  promptMessageId = session.activeRun?.promptMessageId,
  contextWindowSample?: RunTerminalContextWindowSample,
  turnUsage?: AcpTurnTokenUsage,
  modelCallUsage?: readonly AcpModelCallUsage[]
): ChatSession => {
  const now = Math.max(Date.now(), session.updatedAt + 1)
  const failedMessages = failStreamingMessages(session.messages, now)
  const messages = appendContextWindowSample(
    session,
    (turnUsage
      ? completeStreamingMessages(failedMessages, promptMessageId, turnUsage, modelCallUsage, now)
      : failedMessages
    ).map((message) =>
      message.id === promptMessageId && message.role === 'user'
        ? { ...message, interrupted: true as const, updatedAt: now }
        : message
    ),
    promptMessageId,
    contextWindowSample,
    now
  )
  const activities = failOpenActivities(session.activities)
  const activityGroups = completeOpenActivityGroups(session.activityGroups, now)
  const resumeRecovery = {
    kind: 'resume-required' as const,
    cause: recoveryCause,
    ...(promptMessageId ? { promptMessageId } : {})
  }
  let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
  try {
    conversationGraph = synchronizeSessionGraph(
      { ...session, messages, activities, activityGroups },
      messages,
      now
    )
    if (promptMessageId) {
      conversationGraph = {
        ...conversationGraph,
        messages: conversationGraph.messages.map((message) =>
          message.id === promptMessageId && message.role === 'user'
            ? { ...message, interrupted: true, updatedAt: now }
            : message
        )
      }
    }
  } catch (cause) {
    return {
      ...settleConversationGraphSyncFailure(session, {
        messages,
        activities,
        activityGroups,
        now,
        cause,
        runError: error
      }),
      interrupted: true,
      resumeRecovery
    }
  }
  const planAwaitingApproval = hasPendingPlanReview(session)
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: planAwaitingApproval ? 'waiting-plan-approval' : 'error',
    interrupted: planAwaitingApproval ? undefined : true,
    resumeRecovery: planAwaitingApproval ? undefined : resumeRecovery,
    error: planAwaitingApproval ? undefined : error,
    errorReportable: undefined,
    messages,
    activities,
    activityGroups,
    conversationGraph,
    conversationGraphSyncBlocked: undefined,
    updatedAt: now
  }
}
