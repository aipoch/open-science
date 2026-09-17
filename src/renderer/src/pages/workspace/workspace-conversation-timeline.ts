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
  const lastItemIndexByPromptId = new Map<string, number>()
  groupedItems.forEach((item, index) => {
    const promptId = resolveTimelineItemPrompt(item, resolveActivityPrompt)
    if (promptId) lastItemIndexByPromptId.set(promptId, index)
  })
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
      completionIndex = Math.max(
        completionIndex,
        lastItemIndexByPromptId.get(promptMessageId) ?? messageIndex
      )
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

// Anchor to the copied conversation path, not the last inherited footer: late tool events can
// move an old turn completion below newer turns. Legacy forks have no explicit local head.
const resolveForkBoundaryItemId = (
  session: ChatSession | undefined,
  timeline: readonly WorkspaceConversationTimelineItem[]
): string | undefined => {
  if (!session?.forkOrigin) return undefined
  const headId =
    session.forkHeadMessageId ?? session.messages.findLast((message) => message.usageOrigin)?.id
  const headIndex = session.messages.findIndex((message) => message.id === headId)
  if (headIndex < 0) return undefined

  const visibleMessageIndex = new Map(
    timeline.flatMap((item, index) =>
      item.type === 'message' ? [[item.message.id, index] as const] : []
    )
  )
  // Hidden control messages can be the graph head. Use its last visible ancestor, and do not
  // relocate the divider onto a different branch when the recorded head is absent there.
  const visibleHead = session.messages
    .slice(0, headIndex + 1)
    .findLast((message) => visibleMessageIndex.has(message.id))
  if (!visibleHead) return undefined
  const messageIndex = visibleMessageIndex.get(visibleHead.id)!
  const completionIndex = timeline.findIndex(
    (item) => item.type === 'turn-completion' && item.message.id === visibleHead.id
  )
  const completionBelongsBeforeNextTurn =
    completionIndex > messageIndex &&
    !timeline.slice(messageIndex + 1, completionIndex).some((item) => item.type === 'message')
  return timeline[completionBelongsBeforeNextTurn ? completionIndex : messageIndex].id
}

export { createWorkspaceConversationTimeline, resolveForkBoundaryItemId }
export type { ConversationTurnCompletionItem, WorkspaceConversationTimelineItem }
