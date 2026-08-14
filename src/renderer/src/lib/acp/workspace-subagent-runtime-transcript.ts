import type {
  DelegatedWorkAttemptRecord,
  PersistedChatMessage
} from '../../../../shared/session-persistence'
import { createSessionStore, type ChatSession } from '../../stores/session-store'
type WorkspaceSubagentFrameProjection = Readonly<{
  frameId: string
  status: 'running' | 'awaiting_user' | 'completed' | 'cancelled' | 'error'
  attempt?: DelegatedWorkAttemptRecord
  messages: readonly PersistedChatMessage[]
}>

type SubagentPresentationStore = ReturnType<typeof createSessionStore>

const hasSharedEventIdentity = (
  left: Readonly<{ eventIds: readonly string[] }>,
  right: Readonly<{ eventIds: readonly string[] }>
): boolean => left.eventIds.some((eventId) => right.eventIds.includes(eventId))

const isSameMessageIdentity = (
  left: ChatSession['messages'][number],
  right: ChatSession['messages'][number]
): boolean =>
  left.id === right.id ||
  (Boolean(left.streamId) && left.streamId === right.streamId) ||
  hasSharedEventIdentity(left, right)

const mergeAcceptedProjectionItems = <Item>(
  accepted: readonly Item[],
  durable: readonly Item[],
  isSameIdentity: (left: Item, right: Item) => boolean,
  retainAccepted: (item: Item) => boolean = () => true,
  resolveConflict: (accepted: Item, durable: Item) => Item = (_accepted, durableItem) => durableItem
): Item[] => {
  const remainingDurable = [...durable]
  const merged = accepted.flatMap((item) => {
    const durableIndex = remainingDurable.findIndex((candidate) => isSameIdentity(item, candidate))
    if (durableIndex >= 0) {
      const [durableItem] = remainingDurable.splice(durableIndex, 1)
      return [resolveConflict(item, durableItem)]
    }
    return retainAccepted(item) ? [item] : []
  })
  return [...merged, ...remainingDurable]
}

const hasVisibleMessageContent = (message: ChatSession['messages'][number]): boolean =>
  Boolean(
    message.content.trim() ||
    message.images?.length ||
    message.artifactIds?.length ||
    message.uploads?.length
  )

const appendUnique = <Item>(items: readonly Item[], additional: readonly Item[]): Item[] => [
  ...new Set([...items, ...additional])
]

const mergeMessageConflict = (
  accepted: ChatSession['messages'][number],
  durable: ChatSession['messages'][number]
): ChatSession['messages'][number] => {
  const uncoveredEventIds = accepted.eventIds.filter(
    (eventId) => !durable.eventIds.includes(eventId)
  )
  if (uncoveredEventIds.length === 0) return durable
  const acceptedImages = accepted.images?.filter((image) => uncoveredEventIds.includes(image.id))
  return {
    ...accepted,
    ...durable,
    // A runtime stream is cumulative. If durability covers only a prefix of its event identities,
    // the accepted candidate still owns the visible tail while durable metadata owns the row.
    content: accepted.content,
    eventIds: appendUnique(durable.eventIds, uncoveredEventIds),
    images:
      durable.images || acceptedImages
        ? [
            ...(durable.images ?? []),
            ...(acceptedImages ?? []).filter(
              (image) => !durable.images?.some((candidate) => candidate.id === image.id)
            )
          ]
        : undefined,
    artifactIds: appendUnique(durable.artifactIds ?? [], accepted.artifactIds ?? []),
    updatedAt: Math.max(accepted.updatedAt, durable.updatedAt)
  }
}

const settleAcceptedMessages = (
  messages: ChatSession['messages'],
  status: WorkspaceSubagentFrameProjection['status']
): ChatSession['messages'] => {
  if (status === 'awaiting_user') return messages
  const lastAgentMessage = messages.findLast((message) => message.role === 'agent')
  return messages.map((message) =>
    message.status !== 'streaming'
      ? message
      : {
          ...message,
          status:
            status !== 'completed' && message === lastAgentMessage ? ('error' as const) : 'complete'
        }
  )
}

const runtimeItemAlias = (id: string, runtimeSegmentId: string | undefined): string => {
  if (!runtimeSegmentId) return id
  const prefix = `agent-runtime:${encodeURIComponent(runtimeSegmentId)}:`
  if (!id.startsWith(prefix)) return id
  try {
    return decodeURIComponent(id.slice(prefix.length))
  } catch {
    return id
  }
}

const mergeActivityConflict = (
  accepted: NonNullable<ChatSession['activities']>[number],
  durable: NonNullable<ChatSession['activities']>[number]
): NonNullable<ChatSession['activities']>[number] => {
  const uncoveredEventIds = accepted.eventIds.filter(
    (eventId) => !durable.eventIds.includes(eventId)
  )
  if (uncoveredEventIds.length === 0) return durable
  const acceptedIsTerminal = accepted.status === 'completed' || accepted.status === 'failed'
  return {
    ...durable,
    // Uncovered events are a newer accepted tail. Retain their payload while the durable identity
    // continues to own the canonical namespaced row and group linkage.
    ...accepted,
    id: durable.id,
    activityGroupId: durable.activityGroupId ?? accepted.activityGroupId,
    sortIndex: durable.sortIndex,
    eventIds: appendUnique(durable.eventIds, uncoveredEventIds),
    status: acceptedIsTerminal ? accepted.status : durable.status,
    createdAt: Math.min(accepted.createdAt, durable.createdAt),
    updatedAt: Math.max(accepted.updatedAt, durable.updatedAt)
  }
}

const settleAcceptedActivity = (
  activity: NonNullable<ChatSession['activities']>[number],
  status: WorkspaceSubagentFrameProjection['status']
): NonNullable<ChatSession['activities']>[number] => {
  if (
    status === 'awaiting_user' ||
    (activity.status !== 'pending' && activity.status !== 'in_progress')
  ) {
    return activity
  }
  return {
    ...activity,
    status: status === 'completed' ? 'completed' : 'failed'
  }
}

const childConversationSession = (
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): ChatSession => {
  const messages = [...detail.messages]
  const promptMessage = messages.findLast((message) => message.role === 'user')
  const running = detail.status === 'running' && detail.attempt?.status === 'running'

  return {
    ...session,
    status: detail.status === 'running' ? 'running' : detail.status === 'error' ? 'error' : 'idle',
    error: detail.attempt?.error?.message,
    activeRun:
      running && promptMessage
        ? { promptMessageId: promptMessage.id, startedAt: detail.attempt.startedAt }
        : undefined,
    agentPromptInFlight: running ? true : undefined,
    messages,
    conversationGraph: session.conversationGraph
      ? { ...session.conversationGraph, activeFrameId: detail.frameId }
      : undefined,
    // This store is an isolated presentation projection. Authority remains in the root Session
    // graph; the adapter only lets the existing transcript components render the selected Frame.
    activities: session.conversationGraph?.activities
      .filter((activity) => activity.agentFrameId === detail.frameId)
      .map(({ agentFrameId, messageBranchId, runtimeSegmentId, ...activity }) => {
        void agentFrameId
        void messageBranchId
        void runtimeSegmentId
        return activity
      }) as ChatSession['activities'],
    activityGroups: session.conversationGraph?.activityGroups
      .filter((group) => group.agentFrameId === detail.frameId)
      .map(({ agentFrameId, messageBranchId, ...group }) => {
        void agentFrameId
        void messageBranchId
        return group
      })
  }
}

const reconcileDurableChildProjection = (
  store: SubagentPresentationStore,
  projection: ChatSession,
  running: boolean,
  status: WorkspaceSubagentFrameProjection['status'],
  runtimeSegmentId: string | undefined
): void => {
  if (running) {
    store.getState().upsertPersistedSession(projection)
    return
  }

  // The selected child Frame owns lifecycle state in this isolated store, so the durable projection
  // closes the run even when no ephemeral stop event arrived. Transcript rows that were already
  // accepted and displayed remain useful evidence, though: merge them by provider identity while
  // letting durable rows win conflicts. The subscription remains keyed to this runtime identity so
  // events already in transport can still append evidence after the lifecycle becomes terminal.
  store.setState((state) => ({
    sessions: state.sessions.map((candidate) =>
      candidate.id === projection.id
        ? (() => {
            const sameRuntimeItemIdentity = (
              left: { id: string },
              right: { id: string }
            ): boolean =>
              runtimeItemAlias(left.id, runtimeSegmentId) ===
              runtimeItemAlias(right.id, runtimeSegmentId)
            const messages = settleAcceptedMessages(
              mergeAcceptedProjectionItems(
                candidate.messages,
                projection.messages,
                isSameMessageIdentity,
                hasVisibleMessageContent,
                mergeMessageConflict
              ),
              status
            )
            const mergedActivities = mergeAcceptedProjectionItems(
              candidate.activities ?? [],
              projection.activities ?? [],
              (left, right) =>
                sameRuntimeItemIdentity(left, right) || hasSharedEventIdentity(left, right),
              undefined,
              mergeActivityConflict
            )
            const mergedGroups = mergeAcceptedProjectionItems(
              candidate.activityGroups ?? [],
              projection.activityGroups ?? [],
              sameRuntimeItemIdentity,
              undefined,
              (accepted, durable) => ({
                ...accepted,
                ...durable,
                activityIds: appendUnique(durable.activityIds, accepted.activityIds)
              })
            )
            const finalActivityIdByAlias = new Map(
              mergedActivities.map((activity) => [
                runtimeItemAlias(activity.id, runtimeSegmentId),
                activity.id
              ])
            )
            const finalGroupIdByAlias = new Map(
              mergedGroups.map((group) => [runtimeItemAlias(group.id, runtimeSegmentId), group.id])
            )
            const resolveActivityId = (id: string): string =>
              finalActivityIdByAlias.get(runtimeItemAlias(id, runtimeSegmentId)) ?? id
            const resolveGroupId = (id: string | undefined): string | undefined =>
              id
                ? (finalGroupIdByAlias.get(runtimeItemAlias(id, runtimeSegmentId)) ?? id)
                : undefined
            return {
              ...projection,
              error: projection.error ?? candidate.error,
              messages,
              activities: mergedActivities.map((activity) =>
                settleAcceptedActivity(
                  {
                    ...activity,
                    activityGroupId: resolveGroupId(activity.activityGroupId)
                  },
                  status
                )
              ),
              activityGroups: mergedGroups.map((group) => ({
                ...(status === 'awaiting_user' || group.completedAt !== undefined
                  ? group
                  : {
                      ...group,
                      completedAt: projection.updatedAt,
                      updatedAt: projection.updatedAt
                    }),
                activityIds: appendUnique([], group.activityIds.map(resolveActivityId))
              })),
              activeRun: undefined,
              agentPromptInFlight: undefined,
              awaitingFirstAgentOutput: undefined,
              agentStatus: undefined,
              activeRunRuntimeSegmentId: undefined,
              interactionState: undefined
            }
          })()
        : candidate
    )
  }))
}

const fenceTerminalLifecycle = (
  store: SubagentPresentationStore,
  projection: ChatSession
): void => {
  store.setState((state) => ({
    sessions: state.sessions.map((candidate) =>
      candidate.id === projection.id
        ? {
            ...candidate,
            status: projection.status,
            error: projection.error ?? candidate.error,
            activeRun: undefined,
            agentPromptInFlight: undefined,
            awaitingFirstAgentOutput: undefined,
            agentStatus: undefined,
            activeRunRuntimeSegmentId: undefined,
            interactionState: undefined
          }
        : candidate
    )
  }))
}

export { childConversationSession, fenceTerminalLifecycle, reconcileDurableChildProjection }
export type { SubagentPresentationStore, WorkspaceSubagentFrameProjection }
