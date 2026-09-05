import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedUploadedAttachment,
  SessionDelegatedWorkRuntimeContext,
  SessionRuntimeContext
} from '../../../shared/session-persistence'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'

const collectDirectDelegateFrameIds = (
  graph: NonNullable<PersistedChatSession['conversationGraph']>
): Set<string> =>
  new Set(
    graph.frames
      .filter((frame) => frame.kind === 'delegate' && frame.parentFrameId === graph.rootFrameId)
      .map(({ id }) => id)
  )

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
  const pdfContext =
    incoming.revision === current.revision
      ? (authoritative.pdfContext ?? fallback.pdfContext)
      : authoritative.pdfContext
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
      : {}),
    ...(pdfContext ? { pdfContext: structuredClone(pdfContext) } : {})
  }
}

const mergeDelegatedRuntimeAuthority = (
  current: SessionRuntimeContext | undefined,
  incoming: SessionRuntimeContext | undefined
): SessionRuntimeContext | undefined => {
  if (!incoming?.delegatedWork) return current ? structuredClone(current) : undefined
  const incomingAdvanced = incoming.revision > (current?.revision ?? -1)
  const delegatedWork = mergeDelegatedWorkByIdentity(
    current?.delegatedWork,
    incoming.delegatedWork,
    incomingAdvanced
  )
  return {
    version: 1,
    revision: Math.max(current?.revision ?? 0, incoming.revision),
    ...(current?.plan ? { plan: structuredClone(current.plan) } : {}),
    ...(delegatedWork ? { delegatedWork } : {}),
    ...(current?.permission ? { permission: structuredClone(current.permission) } : {}),
    ...(current?.sideChat ? { sideChat: structuredClone(current.sideChat) } : {}),
    ...(current?.sideChatRelays ? { sideChatRelays: structuredClone(current.sideChatRelays) } : {}),
    ...(current?.pdfContext ? { pdfContext: structuredClone(current.pdfContext) } : {})
  }
}

const mergeDelegatedConversationAuthority = (
  current: NonNullable<PersistedChatSession['conversationGraph']>,
  incoming: NonNullable<PersistedChatSession['conversationGraph']>
): NonNullable<PersistedChatSession['conversationGraph']> => {
  const childFrameIds = collectDirectDelegateFrameIds(incoming)
  const replaceChildIdentity = <Item extends { id: string }>(
    currentItems: readonly Item[],
    incomingItems: readonly Item[]
  ): Item[] =>
    mergeCollectionByIdentity(
      currentItems,
      incomingItems,
      ({ id }) => id,
      (_currentItem, incomingItem) => incomingItem
    )
  const childFrames = incoming.frames.filter(({ id }) => childFrameIds.has(id))
  const childBranches = incoming.branches.filter(({ agentFrameId }) =>
    childFrameIds.has(agentFrameId)
  )
  const childMessages = incoming.messages.filter(({ agentFrameId }) =>
    childFrameIds.has(agentFrameId)
  )
  const childActivities = incoming.activities.filter(({ agentFrameId }) =>
    childFrameIds.has(agentFrameId)
  )
  const childActivityGroups = incoming.activityGroups.filter(({ agentFrameId }) =>
    childFrameIds.has(agentFrameId)
  )
  const childRuntimeSegments = incoming.runtimeSegments.filter(({ agentFrameId }) =>
    childFrameIds.has(agentFrameId)
  )

  return {
    ...structuredClone(current),
    frames: replaceChildIdentity(current.frames, childFrames),
    branches: replaceChildIdentity(current.branches, childBranches),
    messages: replaceChildIdentity(current.messages, childMessages),
    activities: replaceChildIdentity(current.activities, childActivities),
    activityGroups: replaceChildIdentity(current.activityGroups, childActivityGroups),
    runtimeSegments: replaceChildIdentity(current.runtimeSegments, childRuntimeSegments)
  }
}

type PersistedIdentityState = Pick<
  PersistedChatSession,
  'artifacts' | 'conversationGraph' | 'filesRevision' | 'messages' | 'runtimeContext'
>

const isSameSubmittedUpload = (
  current: PersistedUploadedAttachment,
  submitted: PersistedUploadedAttachment
): boolean =>
  current.id === submitted.id &&
  current.versionId === submitted.versionId &&
  current.sessionId === submitted.sessionId &&
  current.name === submitted.name &&
  current.originalName === submitted.originalName &&
  current.path === submitted.path &&
  current.mimeType === submitted.mimeType &&
  current.size === submitted.size

export const mergeDurableUploadProjection = <Message extends PersistedChatMessage>(
  currentMessages: Message[],
  submittedMessages: PersistedChatMessage[],
  durableMessages: PersistedChatMessage[]
): { messages: Message[]; changed: boolean } => {
  const submittedById = new Map(submittedMessages.map((message) => [message.id, message]))
  const durableById = new Map(durableMessages.map((message) => [message.id, message]))
  let changed = false
  const messages = currentMessages.map((message) => {
    const submitted = submittedById.get(message.id)
    const durable = durableById.get(message.id)
    if (!message.uploads || !submitted?.uploads || !durable?.uploads) return message
    const submittedUploads = new Map(submitted.uploads.map((upload) => [upload.id, upload]))
    const durableUploads = new Map(durable.uploads.map((upload) => [upload.id, upload]))
    let uploadsChanged = false
    const uploads = message.uploads.map((upload) => {
      const submittedUpload = submittedUploads.get(upload.id)
      const durableUpload = durableUploads.get(upload.id)
      if (
        !submittedUpload ||
        !durableUpload?.versionId ||
        submittedUpload.versionId ||
        !isSameSubmittedUpload(upload, submittedUpload)
      ) {
        return upload
      }
      uploadsChanged = true
      return durableUpload
    })
    if (!uploadsChanged) return message
    changed = true
    return { ...message, uploads } as Message
  })
  return { messages, changed }
}

export const mergeRuntimeConversationAuthority = (
  current: Pick<PersistedChatSession, 'conversationGraph' | 'messages'>,
  incoming: Pick<PersistedChatSession, 'conversationGraph' | 'messages'>
): Pick<PersistedChatSession, 'conversationGraph' | 'messages'> => ({
  messages: mergeCollectionByIdentity(
    current.messages,
    incoming.messages,
    ({ id }) => id,
    (currentMessage) => currentMessage
  ),
  ...(incoming.conversationGraph
    ? {
        conversationGraph: current.conversationGraph
          ? mergeConversationGraphByIdentity(current.conversationGraph, incoming.conversationGraph)
          : structuredClone(incoming.conversationGraph)
      }
    : current.conversationGraph
      ? { conversationGraph: structuredClone(current.conversationGraph) }
      : {})
})

const planProjectionMatchesRuntimePlan = (
  projection: ActivePlanProjection | undefined,
  plan: NonNullable<SessionRuntimeContext['plan']> | undefined
): projection is ActivePlanProjection =>
  Boolean(
    projection &&
    plan &&
    projection.artifactId === plan.artifactId &&
    projection.artifactVersionId === plan.artifactVersionId &&
    projection.artifactChecksum === plan.artifactChecksum &&
    projection.originatingPromptMessageId === plan.originatingPromptMessageId &&
    projection.materializedAt === plan.materializedAt &&
    projection.approval === plan.approval &&
    JSON.stringify(projection.stepStatuses) === JSON.stringify(plan.stepStatuses)
  )

export const retainRuntimePlanProjection = (
  current: Pick<PersistedChatSession, 'runtimeContext'> & {
    activePlanProjection?: ActivePlanProjection
  },
  incoming: Pick<PersistedChatSession, 'runtimeContext'>
): ActivePlanProjection | undefined => {
  const projection = current.activePlanProjection
  const incomingPlan = incoming.runtimeContext?.plan
  const incomingRevision = incoming.runtimeContext?.revision
  if (!projection || incomingRevision === undefined) return undefined
  if (projection.revision > incomingRevision) return projection
  if (!planProjectionMatchesRuntimePlan(projection, incomingPlan)) return undefined
  return projection.revision === incomingRevision
    ? projection
    : { ...projection, revision: incomingRevision }
}

export const mergePersistedRuntimeIdentityProjection = (
  current: Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'>,
  incoming: Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'>,
  options: Readonly<{
    incomingOwnsFrameConflicts: boolean
    incomingOwnsRuntimeContext?: boolean
  }>
): Pick<PersistedChatSession, 'conversationGraph' | 'runtimeContext'> => ({
  runtimeContext:
    options.incomingOwnsRuntimeContext === false
      ? mergeDelegatedRuntimeAuthority(current.runtimeContext, incoming.runtimeContext)
      : mergeRuntimeContextByOwner(current.runtimeContext, incoming.runtimeContext),
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

export const mergeDelegatedWorkAuthorityProjection = (
  current: PersistedIdentityState,
  incoming: PersistedChatSession
): Pick<
  PersistedChatSession,
  'artifacts' | 'conversationGraph' | 'filesRevision' | 'runtimeContext'
> => {
  const incomingGraph = incoming.conversationGraph
  const childFrameIds = incomingGraph
    ? collectDirectDelegateFrameIds(incomingGraph)
    : new Set<string>()
  const childArtifactIds = new Set(
    incomingGraph?.messages
      .filter(({ agentFrameId }) => childFrameIds.has(agentFrameId))
      .flatMap(({ artifactIds }) => artifactIds ?? []) ?? []
  )
  const childArtifacts = (incoming.artifacts ?? []).filter(({ id }) => childArtifactIds.has(id))

  return {
    runtimeContext: mergeDelegatedRuntimeAuthority(current.runtimeContext, incoming.runtimeContext),
    ...(incomingGraph
      ? {
          conversationGraph: current.conversationGraph
            ? mergeDelegatedConversationAuthority(current.conversationGraph, incomingGraph)
            : structuredClone(incomingGraph)
        }
      : current.conversationGraph
        ? { conversationGraph: structuredClone(current.conversationGraph) }
        : {}),
    artifacts: mergeCollectionByIdentity(
      current.artifacts ?? [],
      childArtifacts,
      ({ id }) => id,
      (_currentArtifact, incomingArtifact) => incomingArtifact
    ),
    filesRevision: Math.max(
      current.filesRevision ?? 0,
      childArtifacts.length > 0 ? (incoming.filesRevision ?? 0) : 0
    )
  }
}

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
