import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import {
  isHiddenControlMessage,
  isInheritedForkTurn,
  isTurnAnchor,
  latestOutcomePrompt,
  latestTurnAnchor,
  turnAnchorInterval,
  resolveTurnOutcome,
  resolvePreparationNoticeBaseline,
  type TurnOutcome
} from '../../../../shared/session-persistence'
import {
  resolveActiveConversationMessages,
  resolveMessageBranchPath
} from '../../../../shared/conversation-graph'

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

type ConversationTurnOutcomeItem = {
  id: string
  type: 'turn-outcome'
  createdAt: number
  sortIndex: number
  promptMessageId: string
  outcome: Extract<TurnOutcome, { kind: 'failed' }>
}

type WorkspaceConversationTimelineItem =
  GroupedConversationItem | ConversationTurnCompletionItem | ConversationTurnOutcomeItem

type CurrentTurnOutcomeItem = {
  promptMessageId: string
  outcome: Exclude<TurnOutcome, { kind: 'completed' }>
}

const eligiblePrompt = (message: ChatMessage): boolean =>
  isTurnAnchor(message) && !isHiddenControlMessage(message)

// Preparation is durable but is not admission. While Main owns a preparation, keep presenting the
// previous settled turn instead of treating the newly saved prompt or optimistic Branch as current.
// No renderer cache is involved, so Session and Branch switches cannot leak another notice.
// Turns inherited by a fork are history in either branch: a failed one falls into the historical
// marker loop and an interrupted one has no presentation, so neither offers Resume.
const resolveCurrentTurnOutcomeItem = (
  session: ChatSession | undefined
): CurrentTurnOutcomeItem | undefined => {
  if (!session) return undefined
  const latestPrompt = latestOutcomePrompt(session)
  const preparation = session.promptPreparation
  if (preparation && latestPrompt?.id === preparation.promptMessageId) {
    const baseline = resolvePreparationNoticeBaseline(session)
    const activeMessages = session.conversationGraph
      ? resolveActiveConversationMessages(session.conversationGraph)
      : session.messages
    const allMessages = session.conversationGraph?.messages ?? session.messages
    const preparedNode = session.conversationGraph?.messages.find(
      ({ id }) => id === preparation.promptMessageId
    )
    const preparedBranch = session.conversationGraph?.branches.find(
      ({ id }) => id === preparedNode?.introducedOnBranchId
    )
    // An edit points at the replaced Message, but the notice belonged to the latest turn on
    // its original Branch. That Branch retains the full downstream path during preparation.
    const previousBranchMessages =
      session.conversationGraph &&
      preparedNode?.supersedesMessageId &&
      preparedBranch?.supersededMessageId === preparedNode.supersedesMessageId &&
      preparedBranch.parentBranchId
        ? resolveMessageBranchPath(session.conversationGraph, preparedBranch.parentBranchId)
        : activeMessages.filter(({ id }) => id !== preparation.promptMessageId)
    const exactPreviousPromptMessageId =
      baseline?.promptMessageId ?? preparation.previousState.resumeRecovery?.promptMessageId
    const candidate = exactPreviousPromptMessageId
      ? allMessages.find(
          (message) => message.id === exactPreviousPromptMessageId && eligiblePrompt(message)
        )
      : latestPrompt.turnOutcome
        ? latestPrompt
        : latestTurnAnchor(previousBranchMessages)
    if (!candidate || !eligiblePrompt(candidate) || isInheritedForkTurn(session, candidate.id))
      return undefined
    const previousSession: ChatSession = {
      ...session,
      ...(baseline?.state ?? preparation.previousState),
      activeRun: undefined,
      promptPreparation: undefined,
      conversationGraph: undefined,
      messages: previousBranchMessages.some(({ id }) => id === candidate.id)
        ? previousBranchMessages
        : [candidate]
    }
    const outcome = candidate.turnOutcome ?? resolveTurnOutcome(previousSession, candidate.id)
    return outcome && outcome.kind !== 'completed'
      ? { promptMessageId: candidate.id, outcome }
      : undefined
  }

  const latestOutcome = latestPrompt ? resolveTurnOutcome(session, latestPrompt.id) : undefined
  return latestPrompt &&
    eligiblePrompt(latestPrompt) &&
    !isInheritedForkTurn(session, latestPrompt.id) &&
    latestOutcome &&
    latestOutcome.kind !== 'completed'
    ? { promptMessageId: latestPrompt.id, outcome: latestOutcome }
    : undefined
}

const terminalTimestamp = (message: ChatMessage): number | undefined =>
  message.status === 'complete'
    ? message.completedAt
    : message.status === 'error'
      ? message.failedAt
      : undefined

const openPromptMessageId = (session: ChatSession): string | undefined =>
  session.activeRun || session.agentPromptInFlight || session.status.startsWith('waiting-')
    ? (session.activeRun?.promptMessageId ?? latestTurnAnchor(session.messages)?.id)
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
    // A routed reply is a row of its owning turn; it must not detach the turn's footer from it.
    return item.message.role === 'user'
      ? (item.message.responseToMessageId ?? item.message.id)
      : item.message.responseToMessageId
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
  handoffEvents: readonly HandoffLifecycleEvent[] = [],
  includeTurnOutcomes = true
): WorkspaceConversationTimelineItem[] => {
  const groupedItems = groupConversationItems(
    createConversationItems(session, handoffEvents),
    session?.activityGroups
  )
  if (!session) return groupedItems

  // Explicit history reads are constant-time. Resolve legacy Session-only state once, on its
  // latest eligible anchor, rather than traversing the graph for every historical user Message.
  const latestPrompt = includeTurnOutcomes ? latestOutcomePrompt(session) : undefined
  const currentOutcomePromptMessageId = includeTurnOutcomes
    ? resolveCurrentTurnOutcomeItem(session)?.promptMessageId
    : undefined
  const legacyOutcome =
    latestPrompt &&
    !latestPrompt.turnOutcome &&
    (session.status === 'error' || session.resumeRecovery)
      ? resolveTurnOutcome(session, latestPrompt.id)
      : undefined
  // Older files can omit responseToMessageId. Only the latest eligible legacy turn can
  // borrow those response rows. A later prompt or relay ends that interval; the turn's own
  // routed replies (steering, answered questions) do not.
  const legacyResponseIds = new Set<string>()
  if (latestPrompt && legacyOutcome && legacyOutcome.kind !== 'completed') {
    for (const message of turnAnchorInterval(session.messages, latestPrompt.id)) {
      if (message.role === 'agent' && !message.responseToMessageId)
        legacyResponseIds.add(message.id)
    }
  }
  const terminalMessageIds = resolveTurnTerminalAgentMessageIds(session.messages)
  const activePromptMessageId = openPromptMessageId(session)
  const resolveActivityPrompt = createActivityPromptResolver(session)
  const lastItemIndexByPromptId = new Map<string, number>()
  groupedItems.forEach((item, index) => {
    const promptId =
      resolveTimelineItemPrompt(item, resolveActivityPrompt) ??
      (legacyResponseIds.has(item.id) ? latestPrompt?.id : undefined)
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

  const outcomesByItemIndex = new Map<number, ConversationTurnOutcomeItem[]>()
  for (const message of includeTurnOutcomes ? session.messages : []) {
    if (!eligiblePrompt(message)) continue
    // The latest visible outcome is actionable beside the composer. It becomes historical only
    // after Main admits another prompt and that new durable anchor becomes latestPrompt.
    if (message.id === currentOutcomePromptMessageId) continue
    const outcome =
      message.turnOutcome ?? (message.id === latestPrompt?.id ? legacyOutcome : undefined)
    // Historical interruption/cancellation has no presentation value. Keep its durable outcome and
    // transcript records, but only failed turns get compact historical details/actions.
    if (!outcome || outcome.kind !== 'failed') continue
    const itemIndex = lastItemIndexByPromptId.get(message.id)
    if (itemIndex === undefined) continue
    const outcomeItem: ConversationTurnOutcomeItem = {
      id: `turn-outcome-${message.id}`,
      type: 'turn-outcome',
      createdAt: outcome.settledAt,
      sortIndex: (message.sortIndex ?? itemIndex) + 0.5,
      promptMessageId: message.id,
      outcome
    }
    const outcomes = outcomesByItemIndex.get(itemIndex)
    if (outcomes) outcomes.push(outcomeItem)
    else outcomesByItemIndex.set(itemIndex, [outcomeItem])
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
      ) ?? []),
    ...(outcomesByItemIndex
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
  if (!session?.forkOrigin && !session?.branchSource) return undefined
  const headId =
    session.forkHeadMessageId ??
    (session.forkOrigin
      ? session.messages.findLast((message) => message.usageOrigin)?.id
      : session.branchSource?.headMessageId)
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

export {
  createWorkspaceConversationTimeline,
  resolveCurrentTurnOutcomeItem,
  resolveForkBoundaryItemId
}
export type { ConversationTurnCompletionItem, WorkspaceConversationTimelineItem }
