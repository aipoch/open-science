import type {
  PersistedChatSession,
  SessionDelegatedWorkRuntimeContext,
  SessionRuntimeContext
} from '../../../shared/session-persistence'

const mergeCollectionByIdentity = <Item>(
  currentItems: readonly Item[],
  incomingItems: readonly Item[],
  identity: (item: Item) => string,
  resolveConflict: (currentItem: Item, incomingItem: Item) => Item
): Item[] => {
  const incomingByIdentity = new Map(incomingItems.map((item) => [identity(item), item]))
  const merged = currentItems.map((item) => {
    const itemIdentity = identity(item)
    const candidate = incomingByIdentity.get(itemIdentity)
    if (!candidate) return structuredClone(item)
    incomingByIdentity.delete(itemIdentity)
    return structuredClone(resolveConflict(item, candidate))
  })
  merged.push(...[...incomingByIdentity.values()].map((item) => structuredClone(item)))
  return merged
}

const mergeConversationGraphByIdentity = (
  current: NonNullable<PersistedChatSession['conversationGraph']>,
  incoming: NonNullable<PersistedChatSession['conversationGraph']>,
  options: Readonly<{
    incomingWinsConflicts?: boolean
    incomingOwnsFrameConflicts?: boolean
  }> = {}
): NonNullable<PersistedChatSession['conversationGraph']> => {
  const incomingWinsConflicts = options.incomingWinsConflicts ?? false
  const incomingOwnsFrameConflicts = options.incomingOwnsFrameConflicts ?? incomingWinsConflicts
  const newerUpdatedAt = <Item extends { updatedAt: number }>(left: Item, right: Item): boolean =>
    right.updatedAt > left.updatedAt
  const merge = <Item extends { id: string }>(
    currentItems: readonly Item[],
    incomingItems: readonly Item[],
    preferIncoming: (currentItem: Item, incomingItem: Item) => boolean
  ): Item[] =>
    mergeCollectionByIdentity(
      currentItems,
      incomingItems,
      ({ id }) => id,
      (currentItem, incomingItem) =>
        preferIncoming(currentItem, incomingItem) ? incomingItem : currentItem
    )
  return {
    ...structuredClone(current),
    frames: mergeCollectionByIdentity(
      current.frames,
      incoming.frames,
      ({ id }) => id,
      (left, right) => {
        if (incomingOwnsFrameConflicts) {
          return left.id === current.rootFrameId
            ? { ...right, activeBranchId: left.activeBranchId }
            : right
        }
        return (right.completedAt ?? right.createdAt) > (left.completedAt ?? left.createdAt)
          ? right
          : left
      }
    ),
    branches: merge(current.branches, incoming.branches, (left, right) => {
      const isCurrentRootBranch =
        left.agentFrameId === current.rootFrameId &&
        left.id === current.frames.find(({ id }) => id === current.rootFrameId)?.activeBranchId
      return isCurrentRootBranch
        ? newerUpdatedAt(left, right)
        : incomingWinsConflicts || newerUpdatedAt(left, right)
    }),
    messages: merge(
      current.messages,
      incoming.messages,
      (left, right) => incomingWinsConflicts || newerUpdatedAt(left, right)
    ),
    activities: merge(
      current.activities,
      incoming.activities,
      (left, right) => incomingWinsConflicts || newerUpdatedAt(left, right)
    ),
    activityGroups: merge(
      current.activityGroups,
      incoming.activityGroups,
      (left, right) => incomingWinsConflicts || newerUpdatedAt(left, right)
    ),
    runtimeSegments: merge(
      current.runtimeSegments,
      incoming.runtimeSegments,
      (left, right) =>
        incomingWinsConflicts ||
        (right.endedAt ?? right.startedAt) > (left.endedAt ?? left.startedAt)
    )
  }
}

const mergeDelegatedWorkByIdentity = (
  current: SessionDelegatedWorkRuntimeContext | undefined,
  incoming: SessionDelegatedWorkRuntimeContext | undefined,
  preferIncomingConflicts: boolean
): SessionDelegatedWorkRuntimeContext | undefined => {
  if (!incoming) return current ? structuredClone(current) : undefined
  if (!current) return structuredClone(incoming)
  const resolve = <Item>(currentItem: Item, incomingItem: Item): Item =>
    preferIncomingConflicts ? incomingItem : currentItem
  return {
    records: mergeCollectionByIdentity(
      current.records,
      incoming.records,
      ({ agentFrameId }) => agentFrameId,
      (record, candidate) => ({
        agentFrameId: record.agentFrameId,
        attempts: mergeCollectionByIdentity(
          record.attempts,
          candidate.attempts,
          ({ id }) => id,
          resolve
        )
      })
    ),
    ...((incoming.messageCommandsQuarantine ?? current.messageCommandsQuarantine) !== undefined
      ? {
          messageCommandsQuarantine: structuredClone(
            (preferIncomingConflicts
              ? (incoming.messageCommandsQuarantine ?? current.messageCommandsQuarantine)
              : (current.messageCommandsQuarantine ?? incoming.messageCommandsQuarantine))!
          )
        }
      : {
          messageCommands: mergeCollectionByIdentity(
            current.messageCommands ?? [],
            incoming.messageCommands ?? [],
            ({ messageId }) => messageId,
            resolve
          )
        }),
    ...((incoming.questionRequestsQuarantine ?? current.questionRequestsQuarantine) !== undefined
      ? {
          questionRequestsQuarantine: structuredClone(
            (preferIncomingConflicts
              ? (incoming.questionRequestsQuarantine ?? current.questionRequestsQuarantine)
              : (current.questionRequestsQuarantine ?? incoming.questionRequestsQuarantine))!
          )
        }
      : current.questionRequests !== undefined || incoming.questionRequests !== undefined
        ? {
            questionRequests: mergeCollectionByIdentity(
              current.questionRequests ?? [],
              incoming.questionRequests ?? [],
              ({ requestId }) => requestId,
              resolve
            )
          }
        : {})
  }
}

const mergeRuntimeContextByOwner = (
  current: SessionRuntimeContext | undefined,
  incoming: SessionRuntimeContext | undefined
): SessionRuntimeContext | undefined => {
  if (!incoming) return current ? structuredClone(current) : undefined
  if (!current) return structuredClone(incoming)
  const incomingAdvanced = incoming.revision > current.revision
  const delegatedWork = mergeDelegatedWorkByIdentity(
    current.delegatedWork,
    incoming.delegatedWork,
    incomingAdvanced
  )
  const authoritative = incomingAdvanced ? incoming : current
  const fallback = incomingAdvanced ? current : incoming
  return {
    version: 1,
    revision: Math.max(current.revision, incoming.revision),
    ...((authoritative.plan ?? fallback.plan)
      ? { plan: structuredClone(authoritative.plan ?? fallback.plan!) }
      : {}),
    ...(delegatedWork ? { delegatedWork } : {}),
    ...(authoritative.permission ? { permission: structuredClone(authoritative.permission) } : {}),
    ...(authoritative.sideChat ? { sideChat: structuredClone(authoritative.sideChat) } : {}),
    ...(authoritative.sideChatRelays
      ? { sideChatRelays: structuredClone(authoritative.sideChatRelays) }
      : {})
  }
}

type PersistedIdentityState = Pick<
  PersistedChatSession,
  'artifacts' | 'conversationGraph' | 'filesRevision' | 'messages' | 'runtimeContext'
>

export const mergePersistedRuntimeIdentityProjection = (
  current: Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'>,
  incoming: Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'>,
  options: Readonly<{ incomingOwnsFrameConflicts: boolean }>
): Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'> => ({
  runtimeContext: mergeRuntimeContextByOwner(current.runtimeContext, incoming.runtimeContext),
  ...(incoming.conversationGraph
    ? {
        conversationGraph: current.conversationGraph
          ? mergeConversationGraphByIdentity(
              current.conversationGraph,
              incoming.conversationGraph,
              {
                incomingOwnsFrameConflicts: options.incomingOwnsFrameConflicts
              }
            )
          : structuredClone(incoming.conversationGraph)
      }
    : {})
})

export const mergeNewerPersistedSessionByIdentity = (
  current: PersistedIdentityState,
  incoming: PersistedChatSession
): PersistedChatSession => ({
  ...structuredClone(incoming),
  messages: mergeCollectionByIdentity(
    current.messages,
    incoming.messages,
    ({ id }) => id,
    (_currentMessage, incomingMessage) => incomingMessage
  ),
  runtimeContext: mergeRuntimeContextByOwner(current.runtimeContext, incoming.runtimeContext),
  ...(current.conversationGraph && incoming.conversationGraph
    ? {
        conversationGraph: mergeConversationGraphByIdentity(
          current.conversationGraph,
          incoming.conversationGraph,
          { incomingWinsConflicts: true }
        )
      }
    : current.conversationGraph && !incoming.conversationGraph
      ? { conversationGraph: structuredClone(current.conversationGraph) }
      : {}),
  artifacts: mergeCollectionByIdentity(
    current.artifacts ?? [],
    incoming.artifacts ?? [],
    ({ id }) => id,
    (_currentArtifact, incomingArtifact) => incomingArtifact
  ),
  filesRevision: Math.max(current.filesRevision ?? 0, incoming.filesRevision ?? 0)
})
