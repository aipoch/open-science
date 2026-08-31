import { describe, expect, it, vi } from 'vitest'

import { createNotificationInboxController } from './notification-inbox-controller'
import type { NotificationInboxDbRepository } from './notification-inbox-repository'

const repository = (
  overrides: Partial<NotificationInboxDbRepository> = {}
): NotificationInboxDbRepository =>
  ({
    migrateLegacyUnread: vi.fn(async () => ({
      changed: false,
      unreadCount: 0,
      latestSequence: 0
    })),
    expireTransientPendingAuthorizations: vi.fn(async () => ({
      changed: false,
      unreadCount: 0,
      latestSequence: 0
    })),
    snapshot: vi.fn(async () => ({ unreadCount: 0, latestSequence: 0, items: [] })),
    record: vi.fn(async () => ({ changed: true, unreadCount: 1, latestSequence: 1 })),
    settle: vi.fn(async () => ({ changed: true, unreadCount: 1, latestSequence: 1 })),
    markRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    markAllRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    markSessionsRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    markSessionTaskOutcomesRead: vi.fn(async () => ({
      changed: true,
      unreadCount: 0,
      latestSequence: 1
    })),
    markSessionCompletionsRead: vi.fn(async () => ({
      changed: true,
      unreadCount: 0,
      latestSequence: 1
    })),
    markSessionUnread: vi.fn(async () => ({
      changed: true,
      unreadCount: 1,
      latestSequence: 2
    })),
    invalidateSessions: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 0 })),
    reconcileSessionCatalog: vi.fn(async () => ({
      changed: false,
      unreadCount: 0,
      latestSequence: 0
    })),
    ...overrides
  }) as unknown as NotificationInboxDbRepository

describe('createNotificationInboxController', () => {
  it('persists and broadcasts in headless mode while leaving native badges disabled', async () => {
    const db = repository()
    const onChanged = vi.fn()
    const setCount = vi.fn()
    const inbox = createNotificationInboxController({
      headless: true,
      repository: db,
      onChanged,
      createId: () => 'message-1',
      now: () => 1000
    })
    inbox.configureDesktop({ isAppFocused: () => false, badge: { setCount } })

    await inbox.restore()
    await inbox.record({
      dedupeKey: 'task:event-1',
      kind: 'task.completed',
      sessionId: 'session-1',
      originId: 'event-1',
      title: 'Task completed',
      summary: 'The task finished.'
    })

    expect(db.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message-1', sessionId: 'session-1' })
    )
    expect(onChanged).toHaveBeenCalledWith({
      revision: 2,
      unreadCount: 1,
      latestSequence: 1
    })
    expect(setCount).not.toHaveBeenCalled()
  })

  it('expires only transient authorization requests during startup restore', async () => {
    const db = repository()
    const inbox = createNotificationInboxController({
      headless: true,
      repository: db,
      onChanged: vi.fn(),
      createId: () => 'message-1',
      now: () => 1500
    })

    await inbox.restore()

    expect(db.migrateLegacyUnread).toHaveBeenCalledWith(expect.any(Function), 1500)
    expect(db.expireTransientPendingAuthorizations).toHaveBeenCalledWith(1500)
    expect(db.snapshot).toHaveBeenCalledWith(1)
  })

  it('reports restore failures without aborting application startup', async () => {
    const error = new Error('temporary inbox failure')
    const db = repository({ migrateLegacyUnread: vi.fn().mockRejectedValue(error) } as never)
    const onError = vi.fn()
    const inbox = createNotificationInboxController({
      headless: true,
      repository: db,
      onChanged: vi.fn(),
      onError
    })

    await expect(inbox.restore()).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(error)
  })

  it('records focused visible session notifications as read and leaves background tasks unread', async () => {
    const record = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, unreadCount: 0, latestSequence: 1 })
      .mockResolvedValueOnce({ changed: true, unreadCount: 0, latestSequence: 2 })
      .mockResolvedValueOnce({ changed: true, unreadCount: 1, latestSequence: 3 })
    const db = repository({ record } as never)
    let focused = true
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn(),
      createId: () => 'message',
      now: () => 2000
    })
    inbox.configureDesktop({
      isAppFocused: () => focused,
      confirmSessionVisible: async (sessionId) => sessionId === 'session-visible',
      badge: { setCount: vi.fn() }
    })

    await inbox.record({
      dedupeKey: 'task:visible',
      kind: 'task.completed',
      sessionId: 'session-visible',
      originId: 'visible',
      title: 'Task completed',
      summary: 'Visible task finished.'
    })
    await inbox.record({
      dedupeKey: 'authorization:agent-tool:visible',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-visible',
      originId: 'visible-approval',
      title: 'Approval needed',
      summary: 'A visible task needs approval.',
      actionState: 'pending'
    })
    focused = false
    await inbox.record({
      dedupeKey: 'task:background',
      kind: 'task.completed',
      sessionId: 'session-background',
      originId: 'background',
      title: 'Task completed',
      summary: 'Background task finished.'
    })

    expect(record.mock.calls[0]?.[0]).toMatchObject({ readAt: 2000 })
    expect(record.mock.calls[1]?.[0]).toMatchObject({ actionState: 'pending', readAt: 2000 })
    expect(record.mock.calls[2]?.[0]).not.toHaveProperty('readAt')
  })

  it('uses the snapshot sequence when a client explicitly marks all read', async () => {
    const db = repository()
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn(),
      now: () => 3000
    })

    await inbox.markAllRead(42)

    expect(db.markAllRead).toHaveBeenCalledWith(42, 3000)
  })

  it('marks every completion for an explicitly dismissed session', async () => {
    const db = repository()
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn(),
      now: () => 3500
    })

    await inbox.markSessionCompletionsRead(['session-1'])

    expect(db.markSessionCompletionsRead).toHaveBeenCalledWith(['session-1'], 3500)
  })

  it('marks a session unread without applying an acknowledgement timestamp', async () => {
    const db = repository()
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn()
    })

    await inbox.markSessionUnread(['session-1'])

    expect(db.markSessionUnread).toHaveBeenCalledWith(['session-1'])
  })

  it('waits for an in-flight authorization record before settling it', async () => {
    let releaseAvailability: ((available: boolean) => void) | undefined
    const order: string[] = []
    const record = vi.fn(async () => {
      order.push('record')
      return { changed: true, unreadCount: 1, latestSequence: 1 }
    })
    const settle = vi.fn(async () => {
      order.push('settle')
      return { changed: true, unreadCount: 1, latestSequence: 1 }
    })
    const db = repository({ record, settle } as never)
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn(),
      createId: () => 'approval-1',
      now: () => 4000
    })
    inbox.setSessionAvailability(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAvailability = resolve
        })
    )

    const recording = inbox.record({
      dedupeKey: 'authorization:agent-tool:request-1',
      kind: 'authorization.required',
      source: 'agent-tool',
      sessionId: 'session-1',
      originId: 'request-1',
      title: 'Approval needed',
      summary: 'A tool request needs your approval.',
      actionState: 'pending'
    })
    const settling = inbox.settleAuthorization('agent-tool', 'request-1', 'rejected')
    await Promise.resolve()

    expect(settle).not.toHaveBeenCalled()
    releaseAvailability?.(true)
    await Promise.all([recording, settling])

    expect(order).toEqual(['record', 'settle'])
    expect(settle).toHaveBeenCalledWith('authorization:agent-tool:request-1', 'rejected', 4000)
  })

  it('waits for an in-flight question record before settling its action', async () => {
    let finishRecord:
      | ((state: { changed: boolean; unreadCount: number; latestSequence: number }) => void)
      | undefined
    const record = vi.fn(
      () =>
        new Promise<{ changed: boolean; unreadCount: number; latestSequence: number }>(
          (resolve) => {
            finishRecord = resolve
          }
        )
    )
    const settle = vi.fn(async () => ({ changed: true, unreadCount: 1, latestSequence: 1 }))
    const db = repository({ record, settle } as never)
    const inbox = createNotificationInboxController({
      headless: true,
      repository: db,
      onChanged: vi.fn(),
      createId: () => 'question-1',
      now: () => 4500
    })

    const recording = inbox.record({
      dedupeKey: 'input:agent-question:choice-1',
      kind: 'task.needs-attention',
      source: 'agent-question',
      sessionId: 'session-1',
      originId: 'choice-1',
      title: 'Response needed',
      summary: 'The agent is waiting for your response.',
      actionState: 'pending'
    })
    const settling = inbox.settleAction('input:agent-question:choice-1', 'resolved')
    await Promise.resolve()

    expect(settle).not.toHaveBeenCalled()
    finishRecord?.({ changed: true, unreadCount: 1, latestSequence: 1 })
    await Promise.all([recording, settling])

    expect(settle).toHaveBeenCalledWith('input:agent-question:choice-1', 'resolved', 4500)
  })

  it('auto-acknowledges all session notifications when a conversation becomes visible', async () => {
    const db = repository()
    const inbox = createNotificationInboxController({
      headless: false,
      repository: db,
      onChanged: vi.fn(),
      now: () => 5000
    })
    inbox.configureDesktop({ isAppFocused: () => true, badge: { setCount: vi.fn() } })

    await inbox.syncViewState({ visibleSessionId: 'session-1' })

    expect(db.markSessionsRead).toHaveBeenCalledWith(['session-1'], 5000)
    expect(db.markSessionTaskOutcomesRead).not.toHaveBeenCalled()
  })
})
