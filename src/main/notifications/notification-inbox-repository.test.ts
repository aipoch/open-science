import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { CredentialRequestBroker } from '../connectors/credential-request-broker'
import { createNotificationInboxController } from './notification-inbox-controller'
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
  it('N01: exposes an unread failure behind 50 read outcomes through the default controller snapshot', async () => {
    const repository = await createRepository()
    const inbox = createNotificationInboxController({
      headless: false,
      repository,
      onChanged: vi.fn()
    })
    inbox.configureDesktop({
      isAppFocused: () => true,
      confirmSessionVisible: async (sessionId) => sessionId === 'visible-session',
      badge: { setCount: vi.fn() }
    })
    await inbox.record({
      dedupeKey: 'task:old-failure',
      kind: 'task.failed',
      sessionId: 'background-session',
      originId: 'old-failure',
      title: 'Task failed',
      summary: 'The background task failed.'
    })
    for (let index = 0; index < 50; index += 1) {
      await inbox.record({
        dedupeKey: `task:new-${index}`,
        kind: 'task.completed',
        sessionId: 'visible-session',
        originId: `new-${index}`,
        title: 'Task completed',
        summary: 'The visible task finished.'
      })
    }

    const stored = await client!.notificationInboxItem.findUnique({
      where: { dedupeKey: 'task:old-failure' }
    })
    expect(stored).toMatchObject({ kind: 'task.failed', readAt: null })
    const snapshot = await inbox.getSnapshot()
    expect(snapshot.unreadCount).toBe(1)
    expect(snapshot.items.filter((item) => item.readAt !== undefined)).toHaveLength(50)
    expect(snapshot.items.filter((item) => item.readAt === undefined)).toEqual([
      expect.objectContaining({ originId: 'old-failure', kind: 'task.failed' })
    ])
  })

  it('N02: expires an orphaned credential request after reopening SQLite while retaining a plan approval', async () => {
    const repository = await createRepository()
    await repository.record({
      id: 'credential-1',
      dedupeKey: 'input:connector-credential:credential-1',
      kind: 'task.needs-attention',
      source: 'connector',
      attentionReason: 'waiting-for-user',
      sessionId: 'existing-session',
      originId: 'credential-1',
      title: 'Response needed',
      summary: 'A task needs your response.',
      actionState: 'pending'
    })
    for (const source of ['connector', 'session-plan'] as const) {
      await repository.record({
        id: `approval-${source}`,
        dedupeKey: `authorization:${source}:approval-${source}`,
        kind: 'authorization.required',
        source,
        sessionId: 'existing-session',
        originId: `approval-${source}`,
        title: 'Approval needed',
        summary: 'A request needs approval.',
        actionState: 'pending'
      })
    }

    // Model an unclean exit: persisted rows survive, but no broker settlement runs.
    await client!.$disconnect()
    client = createProjectDbClient(storageRoot!)
    const restored = createNotificationInboxController({
      headless: true,
      repository: new NotificationInboxDbRepository(() => Promise.resolve(client!)),
      onChanged: vi.fn(),
      now: () => 3000
    })
    const broker = new CredentialRequestBroker({ broadcast: vi.fn(), generateId: () => 'new-id' })
    await restored.restore()
    await restored.reconcileSessionCatalog(['existing-session'])

    expect(broker.getPending('credential-1')).toBeNull()
    const snapshot = await restored.getSnapshot()
    expect(snapshot.items.find((item) => item.id === 'approval-connector')).toMatchObject({
      actionState: 'expired',
      settledAt: 3000
    })
    expect(snapshot.items.find((item) => item.id === 'approval-session-plan')).toMatchObject({
      actionState: 'pending'
    })
    const credential = snapshot.items.find((item) => item.id === 'credential-1')
    expect(credential).not.toHaveProperty('targetInvalidatedAt')
    expect(credential).not.toHaveProperty('readAt')
    expect(credential?.actionState).toBe('expired')
    expect(credential?.settledAt).toBe(3000)
  })

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

  it('includes every unread outcome and read pending action without duplicate rows', async () => {
    const repository = await createRepository()
    for (const kind of ['task.failed', 'task.completed', 'task.needs-attention'] as const) {
      await repository.record({
        id: kind,
        dedupeKey: kind,
        kind,
        originId: kind,
        title: 'Task update',
        summary: 'A task needs attention.'
      })
    }
    await repository.record({
      id: 'read-pending',
      dedupeKey: 'authorization:connector:pending',
      kind: 'authorization.required',
      source: 'connector',
      originId: 'pending',
      title: 'Approval needed',
      summary: 'Approval needed',
      actionState: 'pending',
      readAt: 1000
    })
    for (let index = 0; index < 50; index += 1) {
      await record(repository, `recent-${index}`)
    }
    const snapshot = await repository.snapshot()
    expect(snapshot.items).toHaveLength(54)
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(54)
    expect(snapshot.unreadCount).toBe(53)
    for (const kind of ['task.failed', 'task.completed', 'task.needs-attention']) {
      expect(snapshot.items.find((item) => item.id === kind)).toMatchObject({ kind })
    }
    expect(snapshot.items.find((item) => item.id === 'read-pending')).toMatchObject({
      actionState: 'pending',
      readAt: 1000
    })
  })

  it('leaves unrelated input requests and settled credentials unchanged during restore', async () => {
    const repository = await createRepository()
    for (const [id, source, dedupeKey, actionState] of [
      ['other-connector', 'connector', 'input:other:1', 'pending'],
      ['agent-question', 'agent-question', 'input:agent-question:1', 'pending'],
      ['settled-credential', 'connector', 'input:connector-credential:1', 'resolved']
    ] as const) {
      await repository.record({
        id,
        source,
        dedupeKey,
        actionState: 'pending',
        kind: 'task.needs-attention',
        attentionReason: 'waiting-for-user',
        originId: id,
        title: 'Response needed',
        summary: 'A task needs your response.'
      })
      if (actionState !== 'pending') await repository.settle(dedupeKey, actionState, 1000)
    }
    const result = await repository.expireTransientPendingActions(3000)
    expect(result.changed).toBe(false)
    const snapshot = await repository.snapshot()
    expect(snapshot.items.find((item) => item.id === 'other-connector')?.actionState).toBe(
      'pending'
    )
    expect(snapshot.items.find((item) => item.id === 'agent-question')?.actionState).toBe('pending')
    expect(snapshot.items.find((item) => item.id === 'settled-credential')?.actionState).toBe(
      'resolved'
    )
    expect(snapshot.items.find((item) => item.id === 'settled-credential')?.settledAt).toBe(1000)
    expect(
      snapshot.items
        .filter((item) => item.actionState === 'pending')
        .every((item) => item.settledAt === undefined)
    ).toBe(true)
  })

  it('marks all only through the caller snapshot boundary', async () => {
    const repository = await createRepository()
    await record(repository, 'before')
    const boundary = (await repository.snapshot()).latestSequence
    await record(repository, 'after')

    await repository.markAllRead(boundary, 1000)

    const snapshot = await repository.snapshot()
    expect(snapshot.unreadCount).toBe(1)
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

    await repository.expireTransientPendingActions(2250)

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
    expect(snapshot.items).toHaveLength(MAX_NOTIFICATION_INBOX_ITEMS)
    expect(snapshot.items.at(-1)?.originId).toBe('1')
    expect(snapshot.items[0]?.originId).toBe(String(MAX_NOTIFICATION_INBOX_ITEMS))

    await repository.markAllRead(snapshot.latestSequence, 3000)
    const readHistory = await repository.snapshot(MAX_NOTIFICATION_INBOX_ITEMS)
    expect(readHistory.items).toHaveLength(200)
    expect(readHistory.items.at(-1)?.originId).toBe('801')
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
