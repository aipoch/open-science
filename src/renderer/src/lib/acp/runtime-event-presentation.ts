import type { AcpRuntimeEvent } from '../../../../shared/acp'
import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../../../shared/activity-groups'
import type { ChatSession, SessionStoreApi, ToolActivity } from '../../stores/session-store'
import {
  createRuntimeStreamId,
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  isAssistantRuntimeChatMessageEvent,
  isRuntimeChatMessageEvent
} from './chat-events'

type RuntimePresentationContext = {
  activityGroupToolCallIdsBySession: Map<string, Set<string>>
}

const createRuntimePresentationContext = (): RuntimePresentationContext => ({
  activityGroupToolCallIdsBySession: new Map()
})

const isActivityGroupControlEvent = (
  event: AcpRuntimeEvent,
  context: RuntimePresentationContext
): boolean => {
  if (!event.sessionId || !event.toolCallId) return false

  if (isActivityGroupToolEvent(event)) {
    const toolCallIds =
      context.activityGroupToolCallIdsBySession.get(event.sessionId) ?? new Set<string>()
    toolCallIds.add(event.toolCallId)
    context.activityGroupToolCallIdsBySession.set(event.sessionId, toolCallIds)
    return true
  }

  return (
    context.activityGroupToolCallIdsBySession.get(event.sessionId)?.has(event.toolCallId) === true
  )
}

const isTerminalToolActivity = (activity: ToolActivity | undefined): boolean =>
  activity?.status === 'completed' || activity?.status === 'failed'

const getCurrentPromptMessageId = (session: ChatSession): string | undefined =>
  session.activeRun?.promptMessageId ??
  session.messages.findLast((message) => message.role === 'user')?.id

const ownsForegroundPrompt = (session: ChatSession): boolean =>
  Boolean(
    session.agentPromptInFlight ||
    (session.activeRun && (session.status === 'running' || session.status === 'waiting-permission'))
  )

const didCurrentToolBecomeTerminal = (
  before: ChatSession | undefined,
  after: ChatSession | undefined,
  toolCallId: string,
  eventId: string
): boolean => {
  if (!after || !ownsForegroundPrompt(after)) return false

  const beforeActivity = before?.activities?.find((activity) => activity.id === toolCallId)
  const afterActivity = after.activities?.find((activity) => activity.id === toolCallId)
  if (
    !afterActivity ||
    beforeActivity?.eventIds.includes(eventId) ||
    isTerminalToolActivity(beforeActivity) ||
    !isTerminalToolActivity(afterActivity) ||
    !afterActivity.eventIds.includes(eventId)
  ) {
    return false
  }

  const promptMessageId = getCurrentPromptMessageId(after)
  return Boolean(promptMessageId && afterActivity.promptMessageId === promptMessageId)
}

const isNonActionableCodexDiagnostic = (text: string): boolean => {
  const withoutSkillBudgetNotice = text.replace(
    /Warning:\s*Skill descriptions were shortened to fit the 2% skills context budget\.\s*Codex can still see every skill, but some descriptions are shorter\.\s*Disable unused skills or plugins to leave more room for the rest\.\s*/gi,
    ''
  )
  const withoutTransportFallback = withoutSkillBudgetNotice.replace(
    /Warning:\s*Falling back from WebSockets to HTTPS transport\.\s*request timed out\s*/gi,
    ''
  )

  return withoutTransportFallback.trim().length === 0
}

const applyRuntimePresentationEvent = (
  event: AcpRuntimeEvent,
  storeApi: SessionStoreApi,
  context: RuntimePresentationContext
): boolean => {
  const store = storeApi.getState()

  if (
    isRuntimeChatMessageEvent(event) &&
    event.role === 'user' &&
    event.sessionId &&
    event.messageId
  ) {
    store.appendRoutedUserMessage({
      sessionId: event.sessionId,
      messageId: event.messageId,
      eventId: event.id,
      content: getAcpRuntimeEventText(event) ?? '',
      createdAt: event.timestamp,
      ...(event.promptMessageId ? { responseToMessageId: event.promptMessageId } : {}),
      ...(event.uploads && event.uploads.length > 0 ? { uploads: event.uploads } : {}),
      ...(event.parts && event.parts.length > 0 ? { parts: event.parts } : {})
    })
    return true
  }

  if (isAssistantRuntimeChatMessageEvent(event)) {
    const image = getAcpRuntimeEventImage(event)
    const content = getAcpRuntimeEventText(event)
    const session = store.sessions.find((candidate) => candidate.id === event.sessionId)

    if (
      session?.agentFrameworkId === 'codex' &&
      !image &&
      typeof content === 'string' &&
      content.trim().length > 0 &&
      isNonActionableCodexDiagnostic(content)
    ) {
      return true
    }

    store.completeActivityGroup(event.sessionId, event.promptMessageId)
    store.appendAgentMessageChunk({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      promptMessageId: event.promptMessageId,
      content,
      image
    })
    return true
  }

  if (event.kind === 'tool' && event.sessionId && event.toolCallId) {
    if (isActivityGroupControlEvent(event, context)) {
      const title = getActivityGroupTitleFromToolEvent(event)
      if (title) {
        store.beginActivityGroup(event.sessionId, event.toolCallId, title, event.promptMessageId)
      }
      return true
    }

    const sessionBeforeToolEvent = store.sessions.find((session) => session.id === event.sessionId)
    store.upsertToolActivity({
      sessionId: event.sessionId,
      toolCallId: event.toolCallId,
      eventId: event.id,
      timestamp: event.timestamp,
      promptMessageId: event.promptMessageId,
      title: event.title,
      status: event.status,
      toolDisposition: event.toolDisposition,
      executionInvocationId: event.executionInvocationId,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      terminalOutput: event.terminalOutput,
      terminalExitCode: event.terminalExitCode
    })
    const sessionAfterToolEvent = storeApi
      .getState()
      .sessions.find((session) => session.id === event.sessionId)
    if (
      didCurrentToolBecomeTerminal(
        sessionBeforeToolEvent,
        sessionAfterToolEvent,
        event.toolCallId,
        event.id
      )
    ) {
      storeApi.getState().setAwaitingFirstAgentOutput(event.sessionId, true)
    }
    return true
  }

  return false
}

export {
  applyRuntimePresentationEvent,
  createRuntimePresentationContext,
  isNonActionableCodexDiagnostic
}
export type { RuntimePresentationContext }
