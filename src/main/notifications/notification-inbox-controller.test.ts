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
    snapshot: vi.fn(async () => ({ unreadCount: 0, latestSequence: 0, items: [] })),
    record: vi.fn(async () => ({ changed: true, unreadCount: 1, latestSequence: 1 })),
    settle: vi.fn(async () => ({ changed: true, unreadCount: 1, latestSequence: 1 })),
    markRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    markAllRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    markSessionsRead: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 1 })),
    deleteSessions: vi.fn(async () => ({ changed: true, unreadCount: 0, latestSequence: 0 })),
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

  it('records a focused visible task as read and leaves background tasks unread', async () => {
    const record = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, unreadCount: 0, latestSequence: 1 })
      .mockResolvedValueOnce({ changed: true, unreadCount: 1, latestSequence: 2 })
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
    expect(record.mock.calls[1]?.[0]).not.toHaveProperty('readAt')
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
})
