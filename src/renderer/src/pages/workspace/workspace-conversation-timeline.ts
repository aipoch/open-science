import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'

import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'
import {
  createConversationItems,
  resolveTurnTerminalAgentMessageIds
} from './workspace-conversation-items'
import {
  groupConversationItems,
  type GroupedConversationItem
} from './workspace-tool-activity-groups'

type ConversationTurnCompletionItem = {
  id: string
  type: 'turn-completion'
  createdAt: number
  sortIndex: number
  message: ChatMessage
}

type WorkspaceConversationTimelineItem = GroupedConversationItem | ConversationTurnCompletionItem

const terminalTimestamp = (message: ChatMessage): number | undefined =>
  message.status === 'complete'
    ? message.completedAt
    : message.status === 'error'
      ? message.failedAt
      : undefined

const openPromptMessageId = (session: ChatSession): string | undefined =>
  session.activeRun || session.agentPromptInFlight || session.status.startsWith('waiting-')
    ? (session.activeRun?.promptMessageId ??
      session.messages.findLast((message) => message.role === 'user')?.id)
    : undefined

const createActivityPromptResolver = (
  session: ChatSession
): ((activity: ToolActivity) => string | undefined) => {
  const graphPromptByActivityId = new Map(
    session.conversationGraph?.activities.map((activity) => [
      activity.id,
      activity.promptMessageId
    ]) ?? []
  )

  return (activity) => activity.promptMessageId ?? graphPromptByActivityId.get(activity.id)
}

const resolveSingleActivityPrompt = (
  activities: readonly ToolActivity[],
  resolveActivityPrompt: (activity: ToolActivity) => string | undefined
): string | undefined => {
  const promptIds = new Set(
    activities.flatMap((activity) => {
      const promptMessageId = resolveActivityPrompt(activity)
      return promptMessageId ? [promptMessageId] : []
    })
  )
  return promptIds.size === 1 ? promptIds.values().next().value : undefined
}

const resolveTimelineItemPrompt = (
  item: GroupedConversationItem,
  resolveActivityPrompt: (activity: ToolActivity) => string | undefined
): string | undefined => {
  if (item.type === 'message') {
    return item.message.role === 'user' ? item.message.id : item.message.responseToMessageId
  }
  if (item.type === 'activity-group') {
    return resolveSingleActivityPrompt(item.activities, resolveActivityPrompt)
  }
  if (
    item.type === 'activity' ||
    item.type === 'plan-activity' ||
    item.type === 'compaction-activity'
  ) {
    return resolveActivityPrompt(item.activity)
  }
  if (item.type === 'handoff') return item.originatingUserMessageId
  if (item.type === 'subagent-message') return item.message.promptMessageId
  return undefined
}

// Produces the renderer's authoritative transcript order. A turn completion is a sibling timeline
// item rather than part of an Agent Message, so every later visible row owned by the same Prompt
// remains above the terminal timestamp, elapsed time, usage, and completion actions.
const createWorkspaceConversationTimeline = (
  session: ChatSession | undefined,
  handoffEvents: readonly HandoffLifecycleEvent[] = []
): WorkspaceConversationTimelineItem[] => {
  const groupedItems = groupConversationItems(
    createConversationItems(session, handoffEvents),
    session?.activityGroups
  )
  if (!session) return groupedItems

  const terminalMessageIds = resolveTurnTerminalAgentMessageIds(session.messages)
  const activePromptMessageId = openPromptMessageId(session)
  const resolveActivityPrompt = createActivityPromptResolver(session)
  const promptByItemIndex = groupedItems.map((item) =>
    resolveTimelineItemPrompt(item, resolveActivityPrompt)
  )
  const itemIndexById = new Map(groupedItems.map((item, index) => [item.id, index]))
  const completionsByItemIndex = new Map<number, ConversationTurnCompletionItem[]>()

  for (const message of session.messages) {
    const completedAt = terminalTimestamp(message)
    if (!terminalMessageIds.has(message.id) || completedAt === undefined) continue

    const promptMessageId = message.responseToMessageId
    if (promptMessageId && promptMessageId === activePromptMessageId) continue

    const messageIndex = itemIndexById.get(message.id)
    if (messageIndex === undefined) continue
    let completionIndex = messageIndex
    if (promptMessageId) {
      promptByItemIndex.forEach((candidatePromptMessageId, index) => {
        if (candidatePromptMessageId === promptMessageId)
          completionIndex = Math.max(completionIndex, index)
      })
    }

    const completion: ConversationTurnCompletionItem = {
      id: `turn-completion-${message.id}`,
      type: 'turn-completion',
      createdAt: completedAt,
      sortIndex: message.sortIndex ?? completionIndex,
      message
    }
    const completions = completionsByItemIndex.get(completionIndex)
    if (completions) completions.push(completion)
    else completionsByItemIndex.set(completionIndex, [completion])
  }

  return groupedItems.flatMap((item, index) => [
    item,
    ...(completionsByItemIndex
      .get(index)
      ?.toSorted(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.sortIndex - right.sortIndex ||
          left.id.localeCompare(right.id)
      ) ?? [])
  ])
}

export { createWorkspaceConversationTimeline }
export type { ConversationTurnCompletionItem, WorkspaceConversationTimelineItem }
