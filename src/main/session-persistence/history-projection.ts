import { pathToFileURL } from 'node:url'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  sanitizeMessage,
  sanitizeArtifact,
  retainRecentSessionEventIds,
  sanitizeActivityGroup,
  sanitizeToolActivity
} from '../../shared/session-persistence'
import type { RuntimeSessionChanges } from '../../shared/runtime-session-projection'
import {
  loadSessionHistoryPageRequestSchema,
  SESSION_HISTORY_PAGE_SIZE,
  SessionHistoryCursorStaleError,
  type LoadSessionHistoryPageRequest,
  type SessionHistoryPage
} from '../../shared/session-history'
import type {
  PersistedActivityGroup,
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'

type ItemKind = 'message' | 'activity' | 'group' | 'artifact'
type HistoryItem = {
  kind: ItemKind
  itemId: string
  ordinal: number | null
  promptMessageId: string | null
  groupId: string | null
  payload: PersistedChatMessage | PersistedToolActivity | PersistedActivityGroup | PersistedArtifact
}
type Header = Omit<
  PersistedChatSession,
  'messages' | 'activities' | 'activityGroups' | 'artifacts' | 'conversationGraph'
>
type Cursor = { projectId: string; sessionId: string; revision: number; before: number }

const itemKey = (kind: string, id: string): string => JSON.stringify([kind, id])

const parseCursor = (
  request: LoadSessionHistoryPageRequest,
  revision: number
): Cursor | undefined => {
  if (!request.beforeCursor) return undefined
  try {
    const cursor: Cursor = JSON.parse(
      Buffer.from(request.beforeCursor, 'base64url').toString('utf8')
    )
    if (
      cursor.projectId !== request.projectId ||
      cursor.sessionId !== request.sessionId ||
      cursor.revision !== revision ||
      !Number.isSafeInteger(cursor.before) ||
      cursor.before < 0
    )
      throw new SessionHistoryCursorStaleError()
    return cursor
  } catch {
    throw new SessionHistoryCursorStaleError()
  }
}

// Resolve the canonical active path; stale flat compatibility arrays must not leak another branch.
const historyItems = (
  session: PersistedChatSession
): { items: HistoryItem[]; scopeKey: string } => {
  const graph = session.conversationGraph
  const messages = graph
    ? resolveActiveConversationMessages(graph).map(projectConversationMessage)
    : session.messages
  const projected = graph ? resolveActiveConversationActivities(graph) : session
  const graphActivities = new Map(graph?.activities.map((item) => [item.id, item]))
  // The graph selects visibility; preserve optional compatibility prompt fields exactly as the
  // complete decoder does. The separate index column always carries the canonical prompt link.
  const flatActivities = new Map(session.activities?.map((item) => [item.id, item]))
  const flatGroups = new Map(session.activityGroups?.map((item) => [item.id, item]))
  const groups = (projected.activityGroups ?? []).map((group) => ({
    ...group,
    ...(flatGroups.get(group.id)?.promptMessageId
      ? { promptMessageId: flatGroups.get(group.id)!.promptMessageId }
      : {})
  }))
  const groupByActivity = new Map(
    groups.flatMap((group) => group.activityIds.map((id) => [id, group.id] as const))
  )
  let promptMessageId: string | undefined
  const messagePrompts = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'user') promptMessageId = message.id
    else if (message.responseToMessageId ?? promptMessageId) {
      messagePrompts.set(message.id, (message.responseToMessageId ?? promptMessageId)!)
    }
  }
  const ordered = [
    ...messages.map((message, index) => ({
      kind: 'message' as const,
      payload: message,
      promptMessageId: messagePrompts.get(message.id) ?? null,
      groupId: null,
      sortIndex: index
    })),
    ...(projected.activities ?? []).map((activity) => ({
      kind: 'activity' as const,
      payload: {
        ...activity,
        ...(flatActivities.get(activity.id)?.promptMessageId
          ? { promptMessageId: flatActivities.get(activity.id)!.promptMessageId }
          : {})
      },
      promptMessageId:
        graphActivities.get(activity.id)?.promptMessageId ?? activity.promptMessageId ?? null,
      groupId: activity.activityGroupId ?? groupByActivity.get(activity.id) ?? null,
      sortIndex: activity.sortIndex
    }))
  ].sort(
    (left, right) =>
      left.payload.createdAt - right.payload.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.payload.id.localeCompare(right.payload.id)
  )
  let latestPrompt: string | null = null
  const items: HistoryItem[] = ordered.map((entry, ordinal) => {
    if (entry.kind === 'message' && (entry.payload as PersistedChatMessage).role === 'user') {
      latestPrompt = entry.payload.id
    }
    return {
      kind: entry.kind,
      itemId: entry.payload.id,
      ordinal,
      promptMessageId: entry.promptMessageId ?? (entry.kind === 'activity' ? latestPrompt : null),
      groupId: entry.groupId,
      payload: entry.payload
    }
  })
  for (const group of groups)
    items.push({
      kind: 'group',
      itemId: group.id,
      ordinal: null,
      promptMessageId: group.promptMessageId ?? null,
      groupId: null,
      payload: group
    })
  for (const artifact of session.artifacts ?? [])
    items.push({
      kind: 'artifact',
      itemId: artifact.id,
      ordinal: null,
      promptMessageId: null,
      groupId: null,
      payload: artifact
    })
  if (new Set(items.map((item) => itemKey(item.kind, item.itemId))).size !== items.length) {
    throw new Error('Session history contains duplicate record identities.')
  }
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  return {
    items,
    scopeKey: JSON.stringify([
      graph?.activeFrameId,
      frame?.activeBranchId,
      !graph || (graph.frames.length === 1 && graph.branches.length === 1)
    ])
  }
}

const sessionHeader = (session: PersistedChatSession): Header => {
  const { messages, activities, activityGroups, artifacts, conversationGraph, ...header } = session
  void messages
  void activities
  void activityGroups
  void artifacts
  void conversationGraph
  return header
}

// Match file decoding per changed row; do not decode the entire conversation on each save.
const serializePayload = (item: HistoryItem): string => {
  let payload: HistoryItem['payload'] | undefined
  switch (item.kind) {
    case 'message': {
      const message = sanitizeMessage(item.payload, { preserveLegacyUploadPaths: true })
      payload =
        message && message.status !== 'streaming'
          ? { ...message, eventIds: retainRecentSessionEventIds(message.eventIds) }
          : message
      break
    }
    case 'activity': {
      const activity = sanitizeToolActivity(item.payload)
      payload =
        activity && (activity.status === 'completed' || activity.status === 'failed')
          ? { ...activity, eventIds: retainRecentSessionEventIds(activity.eventIds) }
          : activity
      break
    }
    case 'group':
      payload = sanitizeActivityGroup(item.payload)
      break
    case 'artifact': {
      const artifact = sanitizeArtifact(item.payload)
      payload = artifact && { ...artifact, fileUrl: pathToFileURL(artifact.path).href }
      break
    }
  }
  if (!payload) throw new Error('Session history contains an invalid display record.')
  return JSON.stringify(payload)
}

export class SessionHistoryProjectionRepository {
  constructor(private readonly prisma: () => Promise<PrismaClient>) {}

  async sync(
    session: PersistedChatSession,
    sourceFingerprint: string,
    runtime?: { changes: RuntimeSessionChanges; sourceFingerprint: string },
    transaction?: Prisma.TransactionClient
  ): Promise<void> {
    const operation = async (tx: Prisma.TransactionClient): Promise<void> => {
      const graph = session.conversationGraph
      if (graph && (graph.frames.length !== 1 || graph.branches.length !== 1)) {
        // These conversations use the complete reader for branch/Frame navigation. Remove
        // any older display projection instead of maintaining rows that cannot be paginated.
        await this.delete(session.id, tx)
        return
      }
      const { items, scopeKey } = historyItems(session)
      const revision = session.revision ?? 0
      const previous = await tx.sessionHistoryIndex.findUnique({ where: { sessionId: session.id } })
      const runtimeChanges = runtime?.changes
      // Revision alone cannot detect an externally replaced file at the same revision. Hints
      // apply only when the indexed source is the exact authority the reducer started from.
      const incremental =
        runtimeChanges &&
        previous?.projectId === session.projectId &&
        previous.revision + 1n === BigInt(revision) &&
        previous.scopeKey === scopeKey &&
        previous.sourceFingerprint === runtime.sourceFingerprint
      const changed = incremental
        ? new Set([
            ...runtimeChanges.messages.map(({ id }) => itemKey('message', id)),
            ...runtimeChanges.activities.map(({ id }) => itemKey('activity', id)),
            ...runtimeChanges.activityGroups.map(({ id }) => itemKey('group', id))
          ])
        : undefined
      const existing = await tx.sessionHistoryItem.findMany({
        where: { sessionId: session.id },
        select: {
          kind: true,
          itemId: true,
          ordinal: true,
          promptMessageId: true,
          groupId: true,
          payloadJson: !incremental
        }
      })
      const byId = new Map(existing.map((item) => [itemKey(item.kind, item.itemId), item]))
      await tx.sessionHistoryIndex.upsert({
        where: { sessionId: session.id },
        create: {
          sessionId: session.id,
          projectId: session.projectId,
          revision: BigInt(revision),
          sourceFingerprint,
          scopeKey,
          headerJson: JSON.stringify(sessionHeader(session)),
          totalItems: items.filter(({ ordinal }) => ordinal !== null).length
        },
        update: {
          projectId: session.projectId,
          revision: BigInt(revision),
          sourceFingerprint,
          scopeKey,
          headerJson: JSON.stringify(sessionHeader(session)),
          totalItems: items.filter(({ ordinal }) => ordinal !== null).length
        }
      })
      const additions: Prisma.SessionHistoryItemCreateManyInput[] = []
      for (const item of items) {
        const key = itemKey(item.kind, item.itemId)
        const old = byId.get(key)
        byId.delete(key)
        const payloadJson =
          !old || !changed || changed.has(key) ? serializePayload(item) : undefined
        const data = {
          ordinal: item.ordinal,
          promptMessageId: item.promptMessageId,
          groupId: item.groupId,
          ...(payloadJson === undefined ? {} : { payloadJson })
        }
        if (!old) {
          additions.push({
            sessionId: session.id,
            kind: item.kind,
            itemId: item.itemId,
            ...data,
            payloadJson: payloadJson!
          })
        } else if (
          old.ordinal !== item.ordinal ||
          old.promptMessageId !== item.promptMessageId ||
          old.groupId !== item.groupId ||
          (payloadJson !== undefined && old.payloadJson !== payloadJson)
        ) {
          await tx.sessionHistoryItem.update({
            where: {
              sessionId_kind_itemId: { sessionId: session.id, kind: item.kind, itemId: item.itemId }
            },
            data
          })
        }
      }
      for (let start = 0; start < additions.length; start += 200) {
        await tx.sessionHistoryItem.createMany({ data: additions.slice(start, start + 200) })
      }
      // Removed records alone are deleted; ordinary saves never rebuild the entire item table.
      const removed = [...byId.values()]
      for (let start = 0; start < removed.length; start += 200) {
        await tx.sessionHistoryItem.deleteMany({
          where: {
            sessionId: session.id,
            OR: removed.slice(start, start + 200).map(({ kind, itemId }) => ({ kind, itemId }))
          }
        })
      }
    }
    if (transaction) await operation(transaction)
    else await (await this.prisma()).$transaction(operation, { maxWait: 30_000 })
  }

  async readPage(
    input: LoadSessionHistoryPageRequest,
    sourceFingerprint: string
  ): Promise<SessionHistoryPage | undefined> {
    const request = loadSessionHistoryPageRequestSchema.parse(input)
    return (await this.prisma()).$transaction(
      async (tx) => {
        const index = await tx.sessionHistoryIndex.findUnique({
          where: { sessionId: request.sessionId }
        })
        if (
          !index ||
          index.projectId !== request.projectId ||
          index.sourceFingerprint !== sourceFingerprint
        )
          return undefined
        const [, messageBranchId, linear] = JSON.parse(index.scopeKey) as [
          string | null,
          string | null,
          boolean?
        ]
        // Display pages omit the graph required for revision and Frame navigation. Older
        // indexes lack this proof and must first pass through the complete file decoder.
        if (linear !== true) return undefined
        const revision = Number(index.revision)
        const cursor = parseCursor(request, revision)
        if (cursor && cursor.before >= index.totalItems) throw new SessionHistoryCursorStaleError()
        const limit = request.limit ?? SESSION_HISTORY_PAGE_SIZE
        const rows = await tx.sessionHistoryItem.findMany({
          where: {
            sessionId: request.sessionId,
            ordinal: { not: null, ...(cursor ? { lt: cursor.before } : {}) }
          },
          orderBy: { ordinal: 'desc' },
          take: limit + 1
        })
        const hasMore = rows.length > limit
        const selected = rows.slice(0, limit).reverse()
        const messageIds = new Set(
          selected.filter(({ kind }) => kind === 'message').map(({ itemId }) => itemId)
        )
        const promptIds = [
          ...new Set(
            selected.flatMap(({ promptMessageId }) =>
              promptMessageId && !messageIds.has(promptMessageId) ? [promptMessageId] : []
            )
          )
        ]
        const prompts = promptIds.length
          ? await tx.sessionHistoryItem.findMany({
              where: { sessionId: request.sessionId, kind: 'message', itemId: { in: promptIds } },
              orderBy: { ordinal: 'asc' }
            })
          : []
        const messages = [...prompts, ...selected.filter(({ kind }) => kind === 'message')]
          .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
          .map(({ payloadJson }) => JSON.parse(payloadJson) as PersistedChatMessage)
        const activities = selected
          .filter(({ kind }) => kind === 'activity')
          .map(({ payloadJson }) => JSON.parse(payloadJson) as PersistedToolActivity)
        const activityIds = new Set(activities.map(({ id }) => id))
        const groupIds = [...new Set(selected.flatMap(({ groupId }) => (groupId ? [groupId] : [])))]
        const groupRows = groupIds.length
          ? await tx.sessionHistoryItem.findMany({
              where: { sessionId: request.sessionId, kind: 'group', itemId: { in: groupIds } }
            })
          : []
        const activityGroups = groupRows
          .map(({ payloadJson }) => {
            const group = JSON.parse(payloadJson) as PersistedActivityGroup
            return { ...group, activityIds: group.activityIds.filter((id) => activityIds.has(id)) }
          })
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.sortIndex - right.sortIndex ||
              left.id.localeCompare(right.id)
          )
        const artifactIds = [...new Set(messages.flatMap((message) => message.artifactIds ?? []))]
        const artifactRows = artifactIds.length
          ? await tx.sessionHistoryItem.findMany({
              where: { sessionId: request.sessionId, kind: 'artifact', itemId: { in: artifactIds } }
            })
          : []
        const artifacts = artifactRows.map(
          ({ payloadJson }) => JSON.parse(payloadJson) as PersistedArtifact
        )
        return {
          projectId: request.projectId,
          sessionId: request.sessionId,
          revision,
          ...(messageBranchId ? { messageBranchId } : {}),
          session: {
            ...(JSON.parse(index.headerJson) as Header),
            messages,
            activities,
            activityGroups,
            artifacts
          },
          hasMore,
          ...(hasMore
            ? {
                beforeCursor: Buffer.from(
                  JSON.stringify({
                    projectId: request.projectId,
                    sessionId: request.sessionId,
                    revision,
                    before: selected[0]!.ordinal
                  })
                ).toString('base64url')
              }
            : {}),
          totalItems: index.totalItems
        }
      },
      { maxWait: 30_000 }
    )
  }

  async delete(sessionId: string, transaction?: Prisma.TransactionClient): Promise<void> {
    await (transaction ?? (await this.prisma())).sessionHistoryIndex.deleteMany({
      where: { sessionId }
    })
  }
}
