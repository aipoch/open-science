import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerNotificationInboxIpcAdapter } from './notification-inbox-ipc'

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
    handlers.set(channel, handler)
}))

describe('notification inbox Electron IPC adapter', () => {
  beforeEach(() => handlers.clear())

  it('registers snapshot and read mutations against the shared owner', async () => {
    const snapshot = { revision: 1, unreadCount: 0, latestSequence: 0, items: [] }
    const owner = {
      getSnapshot: vi.fn(async () => snapshot),
      markRead: vi.fn(async () => undefined),
      markAllRead: vi.fn(async () => undefined)
    }
    registerNotificationInboxIpcAdapter(owner)

    await expect(handlers.get('notifications:get-snapshot')?.(undefined)).resolves.toBe(snapshot)
    await handlers.get('notifications:mark-read')?.(undefined, { ids: ['message-1'] })
    await handlers.get('notifications:mark-all-read')?.(undefined, { throughSequence: 7 })

    expect(owner.markRead).toHaveBeenCalledWith(['message-1'])
    expect(owner.markAllRead).toHaveBeenCalledWith(7)
  })

  it('rejects malformed read requests before calling the owner', () => {
    const owner = {
      getSnapshot: vi.fn(async () => ({
        revision: 1,
        unreadCount: 0,
        latestSequence: 0,
        items: []
      })),
      markRead: vi.fn(async () => undefined),
      markAllRead: vi.fn(async () => undefined)
    }
    registerNotificationInboxIpcAdapter(owner)

    expect(() => handlers.get('notifications:mark-read')?.(undefined, { ids: [1] })).toThrow(
      'Invalid notifications:mark-read request.'
    )
    expect(() =>
      handlers.get('notifications:mark-all-read')?.(undefined, { throughSequence: -1 })
    ).toThrow('Invalid notifications:mark-all-read request.')
    expect(owner.markRead).not.toHaveBeenCalled()
    expect(owner.markAllRead).not.toHaveBeenCalled()
  })
})
