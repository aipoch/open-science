import type { Prisma, PrismaClient } from '@prisma/client'

export const MAX_UNREAD_TASK_SESSIONS = 1000
const SQLITE_MUTATION_CHUNK_SIZE = 400

type UnreadTaskClient = Pick<PrismaClient, '$transaction' | 'unreadTaskSession'>
type UnreadTaskClientProvider = () => Promise<UnreadTaskClient>

// Preserves insertion order while deduplicating; snapshots additionally bound database growth.
const normalizeSessionIds = (values: string[], limit?: number): string[] => {
  const unique = new Set<string>()

  for (const value of values) {
    const sessionId = value.trim()
    if (sessionId) unique.add(sessionId)
  }

  const normalized = [...unique]
  return limit === undefined ? normalized : normalized.slice(-limit)
}

const normalizeUnreadSessionIds = (values: string[]): string[] =>
  normalizeSessionIds(values, MAX_UNREAD_TASK_SESSIONS)

// Bounds each delete statement independently of the SQLite build's maximum bind-variable count.
const chunkValues = <T>(values: T[]): T[][] => {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += SQLITE_MUTATION_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + SQLITE_MUTATION_CHUNK_SIZE))
  }

  return chunks
}

// Owns the durable unread projection while the controller remains responsible for live policy state.
export class UnreadTaskDbRepository {
  private operationTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly getClient: UnreadTaskClientProvider) {}

  // Reads only the newest bounded rows while returning them in controller insertion order.
  async load(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.unreadTaskSession.findMany({
      orderBy: { id: 'desc' },
      take: MAX_UNREAD_TASK_SESSIONS
    })

    // Query newest-first for a bounded read, then restore the controller's oldest-to-newest Set order.
    return normalizeUnreadSessionIds(rows.reverse().map((row) => row.sessionId))
  }

  // Copies the caller's snapshot before queueing so later mutations cannot change scheduled work.
  save(sessionIds: string[]): Promise<void> {
    const snapshot = normalizeUnreadSessionIds(sessionIds)
    return this.enqueue(() => this.reconcile(snapshot))
  }

  // Reconciles unread metadata only after a complete authoritative Session JSON scan. The caller
  // supplies Sessions still eligible for attention, repairing interrupted archive cleanup and
  // headless deletions without introducing another durable workflow.
  reconcileSessionCatalog(attentionEligibleSessionIds: string[]): Promise<string[]> {
    const eligible = new Set(normalizeSessionIds(attentionEligibleSessionIds))

    return this.enqueue(async () => {
      const client = await this.getClient()

      return client.$transaction(async (transaction) => {
        const unreadRows = await transaction.unreadTaskSession.findMany({
          orderBy: { id: 'asc' },
          select: { sessionId: true }
        })
        const removedSessionIds = unreadRows
          .map((row) => row.sessionId)
          .filter((sessionId) => !eligible.has(sessionId))

        for (const ids of chunkValues(removedSessionIds)) {
          await transaction.unreadTaskSession.deleteMany({ where: { sessionId: { in: ids } } })
        }

        return removedSessionIds
      })
    })
  }

  // Applies one complete controller snapshot without rewriting rows that remain unread.
  private async reconcile(snapshot: string[]): Promise<void> {
    const client = await this.getClient()

    // Reconcile inside one transaction so retained rows keep their ordering IDs and a crash cannot
    // expose a partially applied snapshot. Chunk deletes stay below conservative SQLite bind limits.
    await client.$transaction(async (transaction: Prisma.TransactionClient) => {
      const rows = await transaction.unreadTaskSession.findMany({ orderBy: { id: 'asc' } })
      const desiredSessionIds = new Set(snapshot)
      const existingSessionIds = new Set(rows.map((row) => row.sessionId))
      const deletedRowIds = rows
        .filter((row) => !desiredSessionIds.has(row.sessionId))
        .map((row) => row.id)

      for (const rowIds of chunkValues(deletedRowIds)) {
        await transaction.unreadTaskSession.deleteMany({ where: { id: { in: rowIds } } })
      }

      for (const sessionId of snapshot) {
        if (existingSessionIds.has(sessionId)) continue
        await transaction.unreadTaskSession.create({ data: { sessionId } })
      }
    })
  }

  // Snapshot and catalog operations share one queue so stale full-state writes cannot overtake a
  // newer authoritative catalog reconciliation.
  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

export type { UnreadTaskClient, UnreadTaskClientProvider }
