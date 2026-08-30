import type {
  NotificationInboxItem as DbNotificationInboxItem,
  Prisma,
  PrismaClient
} from '@prisma/client'

import type {
  NotificationActionState,
  NotificationAttentionReason,
  NotificationInboxItem,
  NotificationKind,
  NotificationSource
} from '../../shared/notifications'

export const MAX_NOTIFICATION_INBOX_ITEMS = 1000
const DEFAULT_SNAPSHOT_LIMIT = 50
const MAX_SNAPSHOT_LIMIT = 200
const SQLITE_IN_CHUNK_SIZE = 500

const ACTIVE_PENDING_WHERE = {
  actionState: 'pending',
  targetInvalidatedAt: null
} satisfies Prisma.NotificationInboxItemWhereInput
const NOTIFICATION_HISTORY_WHERE = {
  OR: [
    { actionState: null },
    { actionState: { not: 'pending' } },
    { targetInvalidatedAt: { not: null } }
  ]
} satisfies Prisma.NotificationInboxItemWhereInput

type NotificationInboxClient = Pick<
  PrismaClient,
  '$transaction' | 'notificationInboxItem' | 'unreadTaskSession'
>
type NotificationInboxClientProvider = () => Promise<NotificationInboxClient>

type NotificationRecordInput = Readonly<{
  id: string
  dedupeKey: string
  kind: NotificationKind
  source?: NotificationSource
  attentionReason?: NotificationAttentionReason
  projectId?: string
  sessionId?: string
  originId: string
  title: string
  summary: string
  createdAt?: number
  readAt?: number
  actionState?: NotificationActionState
}>

type NotificationRepositoryState = Readonly<{
  changed: boolean
  unreadCount: number
  latestSequence: number
}>

type NotificationRepositorySnapshot = Readonly<{
  unreadCount: number
  latestSequence: number
  items: readonly NotificationInboxItem[]
}>

const normalizeIds = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
]

const mutateInChunks = async <Value>(
  values: readonly Value[],
  mutate: (chunk: Value[]) => Promise<{ count: number }>
): Promise<number> => {
  let count = 0
  for (let offset = 0; offset < values.length; offset += SQLITE_IN_CHUNK_SIZE) {
    count += (await mutate(values.slice(offset, offset + SQLITE_IN_CHUNK_SIZE))).count
  }
  return count
}

const invalidateSessionRows = async (
  client: Pick<NotificationInboxClient, 'notificationInboxItem'>,
  sessionIds: readonly string[],
  invalidatedAt: Date
): Promise<number> => {
  const acknowledged = await mutateInChunks(sessionIds, (sessionIdsChunk) =>
    client.notificationInboxItem.updateMany({
      where: { sessionId: { in: sessionIdsChunk }, readAt: null },
      data: { readAt: invalidatedAt }
    })
  )
  const invalidated = await mutateInChunks(sessionIds, (sessionIdsChunk) =>
    client.notificationInboxItem.updateMany({
      where: { sessionId: { in: sessionIdsChunk }, targetInvalidatedAt: null },
      data: { targetInvalidatedAt: invalidatedAt }
    })
  )
  return invalidated + acknowledged
}

const toInboxItem = (row: DbNotificationInboxItem): NotificationInboxItem => ({
  id: row.id,
  sequence: row.sequence,
  dedupeKey: row.dedupeKey,
  kind: row.kind as NotificationKind,
  ...(row.source ? { source: row.source as NotificationSource } : {}),
  ...(row.attentionReason
    ? { attentionReason: row.attentionReason as NotificationAttentionReason }
    : {}),
  ...(row.projectId ? { projectId: row.projectId } : {}),
  ...(row.sessionId ? { sessionId: row.sessionId } : {}),
  originId: row.originId,
  title: row.title,
  summary: row.summary,
  createdAt: row.createdAt.getTime(),
  ...(row.readAt ? { readAt: row.readAt.getTime() } : {}),
  ...(row.actionState ? { actionState: row.actionState as NotificationActionState } : {}),
  ...(row.settledAt ? { settledAt: row.settledAt.getTime() } : {}),
  ...(row.targetInvalidatedAt ? { targetInvalidatedAt: row.targetInvalidatedAt.getTime() } : {})
})

const stateFor = async (
  client: Pick<NotificationInboxClient, 'notificationInboxItem'>,
  changed: boolean
): Promise<NotificationRepositoryState> => {
  const [unreadCount, latest] = await Promise.all([
    client.notificationInboxItem.count({ where: { readAt: null } }),
    client.notificationInboxItem.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true }
    })
  ])
  return { changed, unreadCount, latestSequence: latest?.sequence ?? 0 }
}

const pruneNotificationHistory = async (
  client: Pick<NotificationInboxClient, 'notificationInboxItem'>
): Promise<void> => {
  const expired = await client.notificationInboxItem.findMany({
    where: NOTIFICATION_HISTORY_WHERE,
    orderBy: { sequence: 'desc' },
    skip: MAX_NOTIFICATION_INBOX_ITEMS,
    select: { sequence: true }
  })
  if (expired.length === 0) return
  await mutateInChunks(
    expired.map((row) => row.sequence),
    (sequences) =>
      client.notificationInboxItem.deleteMany({ where: { sequence: { in: sequences } } })
  )
}

// Serializes every read and mutation through one queue so mark-all boundaries, retention, and
// snapshots observe one database order even when desktop and Web clients act concurrently.
export class NotificationInboxDbRepository {
  private operationTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly getClient: NotificationInboxClientProvider) {}

  snapshot(rawLimit = DEFAULT_SNAPSHOT_LIMIT): Promise<NotificationRepositorySnapshot> {
    const limit = Math.min(
      MAX_SNAPSHOT_LIMIT,
      Math.max(1, Number.isSafeInteger(rawLimit) ? rawLimit : DEFAULT_SNAPSHOT_LIMIT)
    )
    return this.enqueue(async () => {
      const client = await this.getClient()
      const [pendingRows, historyRows, metadata] = await Promise.all([
        client.notificationInboxItem.findMany({
          where: ACTIVE_PENDING_WHERE,
          orderBy: { sequence: 'desc' }
        }),
        client.notificationInboxItem.findMany({
          where: NOTIFICATION_HISTORY_WHERE,
          orderBy: { sequence: 'desc' },
          take: limit
        }),
        stateFor(client, false)
      ])
      const rows = [...pendingRows, ...historyRows].sort(
        (left, right) => right.sequence - left.sequence
      )
      return { ...metadata, items: rows.map(toInboxItem) }
    })
  }

  record(input: NotificationRecordInput): Promise<NotificationRepositoryState> {
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const existing = await transaction.notificationInboxItem.findUnique({
          where: { dedupeKey: input.dedupeKey },
          select: { sequence: true }
        })
        if (existing) return stateFor(transaction, false)

        await transaction.notificationInboxItem.create({
          data: {
            id: input.id,
            dedupeKey: input.dedupeKey,
            kind: input.kind,
            source: input.source,
            attentionReason: input.attentionReason,
            projectId: input.projectId,
            sessionId: input.sessionId,
            originId: input.originId,
            title: input.title,
            summary: input.summary,
            ...(input.createdAt === undefined ? {} : { createdAt: new Date(input.createdAt) }),
            ...(input.readAt === undefined ? {} : { readAt: new Date(input.readAt) }),
            actionState: input.actionState
          }
        })

        await pruneNotificationHistory(transaction)
        return stateFor(transaction, true)
      })
    })
  }

  settle(
    dedupeKey: string,
    actionState: NotificationActionState,
    settledAt: number
  ): Promise<NotificationRepositoryState> {
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const result = await transaction.notificationInboxItem.updateMany({
          where: { dedupeKey, actionState: 'pending' },
          data: { actionState, settledAt: new Date(settledAt) }
        })
        if (result.count > 0) await pruneNotificationHistory(transaction)
        return stateFor(transaction, result.count > 0)
      })
    })
  }

  expireTransientPendingAuthorizations(settledAt: number): Promise<NotificationRepositoryState> {
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const result = await transaction.notificationInboxItem.updateMany({
          where: {
            kind: 'authorization.required',
            actionState: 'pending',
            source: { not: 'session-plan' }
          },
          data: { actionState: 'expired', settledAt: new Date(settledAt) }
        })
        if (result.count > 0) await pruneNotificationHistory(transaction)
        return stateFor(transaction, result.count > 0)
      })
    })
  }

  markRead(ids: readonly string[], readAt: number): Promise<NotificationRepositoryState> {
    const normalized = normalizeIds(ids).slice(0, MAX_NOTIFICATION_INBOX_ITEMS)
    return this.updateReadStateForValues('id', normalized, readAt)
  }

  markAllRead(throughSequence: number, readAt: number): Promise<NotificationRepositoryState> {
    const boundary = Number.isSafeInteger(throughSequence) ? Math.max(0, throughSequence) : 0
    return this.updateReadState({ sequence: { lte: boundary } }, readAt)
  }

  markSessionsRead(
    sessionIds: readonly string[],
    readAt: number
  ): Promise<NotificationRepositoryState> {
    const normalized = normalizeIds(sessionIds)
    return this.updateReadStateForValues('sessionId', normalized, readAt)
  }

  markSessionTaskOutcomesRead(
    sessionIds: readonly string[],
    readAt: number
  ): Promise<NotificationRepositoryState> {
    const normalized = normalizeIds(sessionIds)
    return this.updateReadStateForValues('sessionId', normalized, readAt, {
      kind: { startsWith: 'task.' }
    })
  }

  markSessionCompletionsRead(
    sessionIds: readonly string[],
    readAt: number
  ): Promise<NotificationRepositoryState> {
    const normalized = normalizeIds(sessionIds)
    return this.updateReadStateForValues('sessionId', normalized, readAt, {
      kind: 'task.completed'
    })
  }

  invalidateSessions(
    sessionIds: readonly string[],
    invalidatedAt: number
  ): Promise<NotificationRepositoryState> {
    const normalized = normalizeIds(sessionIds)
    if (normalized.length === 0) return this.currentState()
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const changed = await invalidateSessionRows(
          transaction,
          normalized,
          new Date(invalidatedAt)
        )
        if (changed > 0) await pruneNotificationHistory(transaction)
        return stateFor(transaction, changed > 0)
      })
    })
  }

  reconcileSessionCatalog(
    existingSessionIds: readonly string[],
    invalidatedAt: number
  ): Promise<NotificationRepositoryState> {
    const existing = new Set(normalizeIds(existingSessionIds))
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const rows = await transaction.notificationInboxItem.findMany({
          where: { sessionId: { not: null }, targetInvalidatedAt: null },
          select: { sessionId: true }
        })
        const removed = normalizeIds(
          rows.flatMap((row) =>
            row.sessionId && !existing.has(row.sessionId) ? [row.sessionId] : []
          )
        )
        const changed = await invalidateSessionRows(transaction, removed, new Date(invalidatedAt))
        if (changed > 0) await pruneNotificationHistory(transaction)
        return stateFor(transaction, changed > 0)
      })
    })
  }

  migrateLegacyUnread(createId: () => string, now: number): Promise<NotificationRepositoryState> {
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const legacy = await transaction.unreadTaskSession.findMany({ orderBy: { id: 'asc' } })
        let changed = false
        for (const row of legacy) {
          const dedupeKey = `legacy-unread:${row.sessionId}`
          const existing = await transaction.notificationInboxItem.findUnique({
            where: { dedupeKey },
            select: { sequence: true }
          })
          if (existing) continue
          changed = true
          await transaction.notificationInboxItem.create({
            data: {
              id: createId(),
              dedupeKey,
              kind: 'task.needs-attention',
              sessionId: row.sessionId,
              originId: row.sessionId,
              title: 'Previous task update',
              summary: 'A task update was waiting before the message center upgrade.',
              createdAt: new Date(now)
            }
          })
        }
        if (legacy.length > 0) await transaction.unreadTaskSession.deleteMany()
        await pruneNotificationHistory(transaction)
        return stateFor(transaction, changed)
      })
    })
  }

  private updateReadState(
    where: Record<string, unknown> | undefined,
    readAt: number
  ): Promise<NotificationRepositoryState> {
    if (!where) return this.currentState()
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const result = await transaction.notificationInboxItem.updateMany({
          where: { ...where, readAt: null },
          data: { readAt: new Date(readAt) }
        })
        return stateFor(transaction, result.count > 0)
      })
    })
  }

  private updateReadStateForValues(
    field: 'id' | 'sessionId',
    values: readonly string[],
    readAt: number,
    where: Record<string, unknown> = {}
  ): Promise<NotificationRepositoryState> {
    if (values.length === 0) return this.currentState()
    return this.enqueue(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const count = await mutateInChunks(values, (chunk) =>
          transaction.notificationInboxItem.updateMany({
            where: { ...where, [field]: { in: chunk }, readAt: null },
            data: { readAt: new Date(readAt) }
          })
        )
        return stateFor(transaction, count > 0)
      })
    })
  }

  private currentState(): Promise<NotificationRepositoryState> {
    return this.enqueue(async () => stateFor(await this.getClient(), false))
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

export type {
  NotificationInboxClient,
  NotificationInboxClientProvider,
  NotificationRecordInput,
  NotificationRepositorySnapshot,
  NotificationRepositoryState
}
