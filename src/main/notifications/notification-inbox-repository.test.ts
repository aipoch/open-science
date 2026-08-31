import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  MAX_NOTIFICATION_INBOX_ITEMS,
  NotificationInboxDbRepository,
  type NotificationInboxClient
} from './notification-inbox-repository'

let storageRoot: string | undefined
let client: PrismaClient | undefined

const createRepository = async (): Promise<NotificationInboxDbRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notification-inbox-'))
  client = createProjectDbClient(storageRoot)
  await migrateApplicationDatabase(client)
  return new NotificationInboxDbRepository(() => Promise.resolve(client!))
}

const record = (
  repository: NotificationInboxDbRepository,
  originId: string
): ReturnType<NotificationInboxDbRepository['record']> =>
  repository.record({
    id: `item-${originId}`,
    dedupeKey: `task:${originId}`,
    kind: 'task.completed',
    sessionId: `session-${originId}`,
    originId,
    title: 'Task completed',
    summary: `Task ${originId} finished.`
  })

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('NotificationInboxDbRepository', () => {
  it('records each dedupe key once and returns newest-first snapshots', async () => {
    const repository = await createRepository()

    await record(repository, 'one')
    const duplicate = await record(repository, 'one')
    await record(repository, 'two')

    expect(duplicate.changed).toBe(false)
    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 2,
      latestSequence: 2,
      items: [
        { originId: 'two', sequence: 2 },
        { originId: 'one', sequence: 1 }
      ]
    })
    expect((await repository.snapshot()).items.every((item) => item.readAt === undefined)).toBe(
      true
    )
    expect((await repository.snapshot()).unreadSessionIds).toEqual(['session-one', 'session-two'])
  })

  it('returns every active pending action in addition to recent history', async () => {
    const repository = await createRepository()
    await repository.record({
      id: 'approval-oldest',
      dedupeKey: 'authorization:agent-tool:oldest',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-oldest',
      originId: 'oldest',
      title: 'Approval needed',
      summary: 'A tool request needs approval.',
      actionState: 'pending'
    })
    for (let index = 0; index < 50; index += 1) {
      await record(repository, `history-${index}`)
    }

    const snapshot = await repository.snapshot()

    expect(snapshot.items).toHaveLength(51)
    expect(snapshot.items.find((item) => item.originId === 'oldest')).toMatchObject({
      actionState: 'pending'
    })
  })

  it('marks all only through the caller snapshot boundary', async () => {
    const repository = await createRepository()
    await record(repository, 'before')
    const boundary = (await repository.snapshot()).latestSequence
    await record(repository, 'after')

    await repository.markAllRead(boundary, 1000)

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(1)
    expect(snapshot.unreadSessionIds).toEqual(['session-after'])
    expect(snapshot.items.find((item) => item.originId === 'before')?.readAt).toBe(1000)
    expect(snapshot.items.find((item) => item.originId === 'after')?.readAt).toBeUndefined()
  })

  it('persists a rejected approval without silently acknowledging its unread message', async () => {
    const repository = await createRepository()
    await repository.record({
      id: 'approval-1',
      dedupeKey: 'authorization:connector:request-1',
      kind: 'authorization.required',
      source: 'connector',
      originId: 'request-1',
      title: 'Approval needed',
      summary: 'A connector needs approval.',
      actionState: 'pending'
    })

    await repository.settle('authorization:connector:request-1', 'rejected', 2000)

    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 1,
      items: [{ actionState: 'rejected', settledAt: 2000 }]
    })
    expect((await repository.snapshot()).items[0]).not.toHaveProperty('readAt')
  })

  it('expires only transient pending authorizations during startup restore', async () => {
    const repository = await createRepository()
    for (const [originId, actionState] of [
      ['stale', 'pending'],
      ['settled', 'pending']
    ] as const) {
      await repository.record({
        id: `approval-${originId}`,
        dedupeKey: `authorization:connector:${originId}`,
        kind: 'authorization.required',
        source: 'connector',
        originId,
        title: 'Approval needed',
        summary: 'A connector needs approval.',
        actionState
      })
    }
    await repository.settle('authorization:connector:settled', 'resolved', 2000)
    await repository.record({
      id: 'approval-plan',
      dedupeKey: 'authorization:session-plan:plan-1',
      kind: 'authorization.required',
      source: 'session-plan',
      sessionId: 'session-1',
      originId: 'plan-1',
      title: 'Plan approval needed',
      summary: 'A plan needs approval.',
      actionState: 'pending'
    })
    await record(repository, 'task')

    await repository.expireTransientPendingAuthorizations(2250)

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(4)
    expect(snapshot.items.find((item) => item.originId === 'stale')).toMatchObject({
      actionState: 'expired',
      settledAt: 2250
    })
    expect(snapshot.items.find((item) => item.originId === 'settled')).toMatchObject({
      actionState: 'resolved'
    })
    expect(snapshot.items.find((item) => item.originId === 'plan-1')).toMatchObject({
      actionState: 'pending'
    })
    expect(snapshot.items.find((item) => item.originId === 'plan-1')).not.toHaveProperty(
      'settledAt'
    )
    expect(snapshot.items.find((item) => item.originId === 'task')).not.toHaveProperty(
      'actionState'
    )
  })

  it('acknowledges visible task outcomes without marking authorization messages read', async () => {
    const repository = await createRepository()
    await record(repository, 'visible')
    await repository.record({
      id: 'approval-visible',
      dedupeKey: 'authorization:agent-tool:request-visible',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-visible',
      originId: 'request-visible',
      title: 'Approval needed',
      summary: 'A tool request needs approval.',
      actionState: 'pending'
    })

    await repository.markSessionTaskOutcomesRead(['session-visible'], 2500)

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(1)
    expect(snapshot.items.find((item) => item.kind === 'task.completed')?.readAt).toBe(2500)
    expect(
      snapshot.items.find((item) => item.kind === 'authorization.required')?.readAt
    ).toBeUndefined()
  })

  it('acknowledges session completions without marking other task outcomes read', async () => {
    const repository = await createRepository()
    await record(repository, 'visible')
    await repository.record({
      id: 'failed-visible',
      dedupeKey: 'task:failed:visible',
      kind: 'task.failed',
      sessionId: 'session-visible',
      originId: 'failed-visible',
      title: 'Task failed',
      summary: 'The task failed.'
    })

    await repository.markSessionCompletionsRead(['session-visible'], 2750)

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(1)
    expect(snapshot.items.find((item) => item.kind === 'task.completed')?.readAt).toBe(2750)
    expect(snapshot.items.find((item) => item.kind === 'task.failed')?.readAt).toBeUndefined()
  })

  it('restores only the latest notification per session without advancing its sequence', async () => {
    const repository = await createRepository()
    for (const originId of ['older', 'latest']) {
      await repository.record({
        id: `item-${originId}`,
        dedupeKey: `task:${originId}`,
        kind: 'task.completed',
        sessionId: 'session-shared',
        originId,
        title: 'Task completed',
        summary: `Task ${originId} finished.`
      })
    }
    await repository.markSessionsRead(['session-shared'], 2800)
    for (let index = 0; index < 50; index += 1) await record(repository, `newer-${index}`)

    expect((await repository.snapshot()).items.some((item) => item.id === 'item-latest')).toBe(
      false
    )
    const latestSequence = (await repository.snapshot()).latestSequence

    await repository.markSessionUnread(['session-shared'])

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(51)
    expect(snapshot.latestSequence).toBe(latestSequence)
    expect(snapshot.unreadSessionIds).toContain('session-shared')
    expect(snapshot.items.find((item) => item.id === 'item-latest')).toMatchObject({
      id: 'item-latest',
      sessionId: 'session-shared'
    })
    expect(snapshot.items.find((item) => item.id === 'item-latest')).not.toHaveProperty('readAt')
    expect(
      await client!.notificationInboxItem.findUnique({ where: { id: 'item-older' } })
    ).toMatchObject({
      readAt: new Date(2800)
    })
  })

  it('migrates legacy unread sessions exactly once and clears the old projection', async () => {
    const repository = await createRepository()
    await client!.unreadTaskSession.create({ data: { sessionId: 'legacy-session' } })
    let nextId = 0

    await repository.migrateLegacyUnread(() => `legacy-item-${++nextId}`, 3000)
    await repository.migrateLegacyUnread(() => `legacy-item-${++nextId}`, 4000)

    await expect(client!.unreadTaskSession.count()).resolves.toBe(0)
    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 1,
      items: [
        {
          id: 'legacy-item-1',
          sessionId: 'legacy-session',
          title: 'Previous task update',
          createdAt: 3000
        }
      ]
    })
  })

  it('retains only the newest one thousand messages', async () => {
    const repository = await createRepository()
    await client!.notificationInboxItem.createMany({
      data: Array.from({ length: MAX_NOTIFICATION_INBOX_ITEMS }, (_, index) => ({
        id: `item-${index}`,
        dedupeKey: `task:${index}`,
        kind: 'task.completed',
        sessionId: `session-${index}`,
        originId: String(index),
        title: 'Task completed',
        summary: `Task ${index} finished.`
      }))
    })
    await record(repository, String(MAX_NOTIFICATION_INBOX_ITEMS))

    const snapshot = await repository.snapshot(MAX_NOTIFICATION_INBOX_ITEMS)
    await expect(client!.notificationInboxItem.count()).resolves.toBe(MAX_NOTIFICATION_INBOX_ITEMS)
    expect(snapshot.items).toHaveLength(200)
    expect(snapshot.items.at(-1)?.originId).toBe('801')
    expect(snapshot.items[0]?.originId).toBe(String(MAX_NOTIFICATION_INBOX_ITEMS))
  })

  it('allows active pending actions to exceed the retained history limit', async () => {
    const repository = await createRepository()
    await repository.record({
      id: 'approval-protected',
      dedupeKey: 'authorization:agent-tool:protected',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-protected',
      originId: 'protected',
      title: 'Approval needed',
      summary: 'A tool request needs approval.',
      actionState: 'pending'
    })
    await client!.notificationInboxItem.createMany({
      data: Array.from({ length: MAX_NOTIFICATION_INBOX_ITEMS - 1 }, (_, index) => ({
        id: `history-${index}`,
        dedupeKey: `history:${index}`,
        kind: 'task.completed',
        sessionId: `session-history-${index}`,
        originId: `history-${index}`,
        title: 'Task completed',
        summary: 'A task completed.'
      }))
    })

    await record(repository, 'new-history')

    expect(
      (await repository.snapshot()).items.find((item) => item.originId === 'protected')
    ).toMatchObject({
      actionState: 'pending'
    })
    await expect(client!.notificationInboxItem.count()).resolves.toBe(
      MAX_NOTIFICATION_INBOX_ITEMS + 1
    )

    await repository.settle('authorization:agent-tool:protected', 'resolved', 5_000)
    await expect(client!.notificationInboxItem.count()).resolves.toBe(MAX_NOTIFICATION_INBOX_ITEMS)
  })

  it('acknowledges archive history and retains deleted targets as invalidated', async () => {
    const repository = await createRepository()
    await record(repository, 'archive')
    await record(repository, 'delete')
    await repository.record({
      id: 'approval-archive',
      dedupeKey: 'authorization:agent-tool:request-archive',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-archive',
      originId: 'request-archive',
      title: 'Approval needed',
      summary: 'A tool request needs approval.',
      actionState: 'pending'
    })

    await repository.markSessionsRead(['session-archive'], 5000)
    await repository.invalidateSessions(['session-delete'], 5500)

    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 0,
      items: [
        { sessionId: 'session-archive', readAt: 5000 },
        { sessionId: 'session-delete', readAt: 5500, targetInvalidatedAt: 5500 },
        { sessionId: 'session-archive', readAt: 5000 }
      ]
    })
  })

  it('invalidates once without settling a pending request', async () => {
    const repository = await createRepository()
    await repository.record({
      id: 'approval-deleted',
      dedupeKey: 'authorization:connector:deleted',
      kind: 'authorization.required',
      source: 'connector',
      attentionReason: 'waiting-permission',
      sessionId: 'session-deleted',
      originId: 'deleted',
      title: 'Approval needed',
      summary: 'A connector request needs your approval.',
      actionState: 'pending'
    })

    await repository.invalidateSessions(['session-deleted'], 5500)
    await repository.invalidateSessions(['session-deleted'], 6500)

    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 0,
      items: [
        {
          actionState: 'pending',
          attentionReason: 'waiting-permission',
          readAt: 5500,
          targetInvalidatedAt: 5500
        }
      ]
    })
  })

  it('chunks multi-id read and invalidation mutations inside transactions', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const deleteMany = vi.fn(async () => ({ count: 1 }))
    const sessionIds = Array.from({ length: 501 }, (_, index) => `session-${index}`)
    const fakeClient = {
      $transaction: async (operation: (transaction: NotificationInboxClient) => Promise<unknown>) =>
        operation(fakeClient),
      notificationInboxItem: {
        updateMany,
        deleteMany,
        count: vi.fn(async () => 0),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async (args?: { select?: { sequence?: boolean } }) =>
          args?.select?.sequence ? [] : sessionIds.map((sessionId) => ({ sessionId }))
        )
      }
    } as unknown as NotificationInboxClient
    const repository = new NotificationInboxDbRepository(() => Promise.resolve(fakeClient))

    await repository.markRead(sessionIds, 6000)
    await repository.markSessionsRead(sessionIds, 6000)
    await repository.markSessionTaskOutcomesRead(sessionIds, 6000)
    await repository.markSessionCompletionsRead(sessionIds, 6000)
    await repository.invalidateSessions(sessionIds, 6000)
    await repository.reconcileSessionCatalog([], 6000)

    expect(updateMany).toHaveBeenCalledTimes(16)
    expect(deleteMany).not.toHaveBeenCalled()
  })
})
