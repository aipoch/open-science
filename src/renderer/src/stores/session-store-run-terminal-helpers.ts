import type { AcpTurnTokenUsage } from '../../../shared/acp'
import { isReportableRunFailure } from '../../../shared/run-error-classification'
import type {
  PersistedActivityGroup,
  PersistedChatSession
} from '../../../shared/session-persistence'
import { synchronizeSessionGraph } from './session-store-message-graph-owner'
import {
  completeOpenActivities,
  completeOpenActivityGroups,
  failOpenActivities
} from './session-store-run-activity-helpers'
import type { ChatMessage, ChatSession, ToolActivity } from './session-store-persistence-owner'

const ARTIFACT_ERROR_PREFIX = 'Generated file finalization failed'
const CONVERSATION_GRAPH_SYNC_ERROR =
  'Conversation history could not be finalized safely. Restart the app to restore the last saved conversation state, then report this issue.'

const CLEARED_AGENT_RUN_STATE = {
  activeRun: undefined,
  agentStatus: undefined,
  awaitingFirstAgentOutput: undefined,
  agentPromptInFlight: undefined,
  compacting: undefined
} satisfies Pick<
  ChatSession,
  'activeRun' | 'agentStatus' | 'awaitingFirstAgentOutput' | 'agentPromptInFlight' | 'compacting'
>

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
  now: number
): ChatMessage[] => {
  const usageFooterMessageId = promptMessageId
    ? [...messages]
        .reverse()
        .find(
          (message) => message.role === 'agent' && message.responseToMessageId === promptMessageId
        )?.id
    : undefined
  return messages.map((message) => {
    const completesStream = message.status === 'streaming'
    const ownsTurnUsageFooter = message.id === usageFooterMessageId
    if (!completesStream && !ownsTurnUsageFooter) return message
    const recordsCompletion =
      completesStream ||
      (ownsTurnUsageFooter && message.status === 'complete' && message.completedAt === undefined)
    return {
      ...message,
      ...(completesStream ? { status: 'complete' as const } : {}),
      ...(recordsCompletion ? { completedAt: now } : {}),
      ...(ownsTurnUsageFooter
        ? turnUsage
          ? { turnUsage }
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
  return session.agentPromptInFlight === agentPromptInFlight
    ? session
    : { ...session, agentPromptInFlight }
}

export const projectArtifactError = (session: ChatSession, error: string): ChatSession => ({
  ...session,
  status: 'error',
  error: `${ARTIFACT_ERROR_PREFIX}: ${error}`,
  errorReportable: true,
  updatedAt: Date.now()
})

export const projectArtifactErrorCleared = (session: ChatSession): ChatSession => {
  if (!session.error?.startsWith(ARTIFACT_ERROR_PREFIX)) return session
  return {
    ...session,
    status: session.activeRun ? 'running' : 'idle',
    error: undefined,
    errorReportable: undefined,
    updatedAt: Date.now()
  }
}

export const projectFinishedRun = (
  session: ChatSession,
  turnUsage?: AcpTurnTokenUsage,
  promptMessageId?: string
): ChatSession => {
  const keepArtifactError = session.error?.startsWith(ARTIFACT_ERROR_PREFIX) ?? false
  const now = Math.max(Date.now(), session.updatedAt + 1)
  const messages = completeStreamingMessages(
    session.messages,
    promptMessageId ?? session.activeRun?.promptMessageId,
    turnUsage,
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
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: keepArtifactError ? 'error' : 'idle',
    error: keepArtifactError ? session.error : undefined,
    errorReportable: keepArtifactError ? session.errorReportable : undefined,
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
  reportable?: boolean
): ChatSession => {
  const now = Date.now()
  const messages = failStreamingMessages(session.messages, now)
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
  return {
    ...session,
    ...CLEARED_AGENT_RUN_STATE,
    status: 'error',
    error,
    errorReportable: reportable ?? isReportableRunFailure(error),
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

export const projectDisconnectedSession = (session: ChatSession, error: string): ChatSession => ({
  ...session,
  ...CLEARED_AGENT_RUN_STATE,
  status: 'error',
  interrupted: true,
  error,
  errorReportable: undefined,
  messages: failStreamingMessages(session.messages),
  activities: failOpenActivities(session.activities),
  activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
  updatedAt: Date.now()
})
