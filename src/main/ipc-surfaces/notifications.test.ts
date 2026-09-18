import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, Notification } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  }
}))

import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import type { BuildTaskNotificationShowDeps } from '../notifications/electron-wiring'
import type { NotificationInboxIpcOwner } from '../notifications/notification-inbox-ipc'
import { TaskNotificationService } from '../notifications/task-notifications'
import { createNotificationElectronSurface } from './notifications'

class FakeNotification extends EventEmitter {
  static isSupported = vi.fn(() => true)
  static constructed: FakeNotification[] = []
  constructor(readonly options: { title?: string; body?: string }) {
    super()
    FakeNotification.constructed.push(this)
  }
  show(): void {
    this.emit('show')
  }
}

const fixture = (): {
  inbox: NotificationInboxIpcOwner
  tasks: TaskNotificationService
  delivery: BuildTaskNotificationShowDeps
} => ({
  inbox: {
    getSnapshot: vi.fn(async () => ({ revision: 1, latestSequence: 0, unreadCount: 0, items: [] })),
    markRead: vi.fn(async () => undefined),
    markAllRead: vi.fn(async () => undefined),
    markSessionCompletionsRead: vi.fn(async () => undefined)
  },
  tasks: new TaskNotificationService({
    isEnabled: async () => true,
    isAppFocused: () => false,
    show: vi.fn(),
    translate: (key) => key
  }),
  delivery: {
    notificationCtor: FakeNotification as unknown as typeof Notification,
    liveNotifications: new Set(),
    log: { info: vi.fn(), warn: vi.fn() },
    headless: false
  }
})
const invoke = (channel: string, request?: unknown): unknown =>
  native.handlers.get(channel)!({ sender: { id: 42 } } as IpcMainInvokeEvent, request)

beforeEach(() => {
  FakeNotification.isSupported.mockReset().mockReturnValue(true)
  FakeNotification.constructed = []
})
afterEach(() => {
  disposeIpcHandlerRegistry()
  native.failAt = undefined
  expect(native.handlers.size).toBe(0)
})

describe('notification Electron production surface', () => {
  it('lazily installs eight channels, routes to the supplied inbox and uninstalls only its channels', async () => {
    const { inbox, tasks, delivery } = fixture()
    const surface = createNotificationElectronSurface(inbox, tasks, delivery)
    expect(surface.name).toBe('task-notifications')
    expect(native.handlers.size).toBe(0)
    ipcMainHandle('test:external', () => undefined)
    const installed = await surface.install()
    expect([...native.handlers.keys()]).toEqual([
      'test:external',
      'notifications:get-snapshot',
      'notifications:mark-read',
      'notifications:mark-all-read',
      'notifications:mark-session-completions-read',
      'notifications:get-desktop-availability',
      'notifications:send-test',
      'notifications:peek-pending-open-session',
      'notifications:take-pending-open-session'
    ])
    await expect(invoke('notifications:get-snapshot')).resolves.toEqual({
      revision: 1,
      latestSequence: 0,
      unreadCount: 0,
      items: []
    })
    await invoke('notifications:mark-read', { ids: ['message'] })
    await invoke('notifications:mark-all-read', { throughSequence: 7 })
    await invoke('notifications:mark-session-completions-read', { sessionIds: ['session'] })
    expect(inbox.markRead).toHaveBeenCalledExactlyOnceWith(['message'])
    expect(inbox.markAllRead).toHaveBeenCalledExactlyOnceWith(7)
    expect(inbox.markSessionCompletionsRead).toHaveBeenCalledExactlyOnceWith(['session'])
    expect(() => invoke('notifications:mark-read', { ids: [1] })).toThrow(
      'Invalid notifications:mark-read request.'
    )
    expect(inbox.markRead).toHaveBeenCalledOnce()
    await installed.uninstall()
    await installed.uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
  })

  it('uses the supplied native delivery dependencies for availability and test delivery', async () => {
    const { inbox, tasks, delivery } = fixture()
    delivery.translate = (key) => `translated: ${key}`
    await createNotificationElectronSurface(inbox, tasks, delivery).install()
    expect(invoke('notifications:get-desktop-availability')).toBe('supported')
    await expect(invoke('notifications:send-test')).resolves.toBe('shown')
    expect(FakeNotification.constructed).toHaveLength(1)
    expect(FakeNotification.constructed[0].options.title).toBe('translated: Test notification')
    expect(
      delivery.liveNotifications.has(FakeNotification.constructed[0] as unknown as Notification)
    ).toBe(true)
    FakeNotification.constructed[0].emit('close')
    expect(delivery.liveNotifications.size).toBe(0)
  })

  it.each(['headless', 'unsupported'] as const)(
    'preserves the %s desktop gate through IPC',
    async (mode) => {
      const { inbox, tasks, delivery } = fixture()
      delivery.headless = mode === 'headless'
      FakeNotification.isSupported.mockReturnValue(mode !== 'unsupported')
      await createNotificationElectronSurface(inbox, tasks, delivery).install()
      expect(invoke('notifications:get-desktop-availability')).toBe('unavailable')
      await expect(invoke('notifications:send-test')).resolves.toBe('unavailable')
      expect(FakeNotification.constructed).toHaveLength(0)
      if (mode === 'headless') expect(FakeNotification.isSupported).not.toHaveBeenCalled()
    }
  )

  it('validates take tokens and preserves a newer target against an older IPC request', async () => {
    const { inbox, tasks, delivery } = fixture()
    await createNotificationElectronSurface(inbox, tasks, delivery).install()
    tasks.setPendingOpenSession('first')
    const first = tasks.peekPendingOpenSession()!
    expect(invoke('notifications:peek-pending-open-session')).toBe(first)
    const take = vi.spyOn(tasks, 'takePendingOpenSession')
    for (const token of [
      undefined,
      null,
      '1',
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      expect(invoke('notifications:take-pending-open-session', token)).toBeNull()
    }
    expect(take).not.toHaveBeenCalled()
    tasks.setPendingOpenSession('second')
    const second = tasks.peekPendingOpenSession()!
    expect(invoke('notifications:take-pending-open-session', first.token)).toBeNull()
    expect(invoke('notifications:peek-pending-open-session')).toBe(second)
    expect(invoke('notifications:take-pending-open-session', second.token)).toBe(second)
    expect(invoke('notifications:peek-pending-open-session')).toBeNull()
  })

  it.each(['notifications:mark-all-read', 'notifications:send-test'])(
    'rolls back partial registration at %s and permits a clean retry',
    async (channel) => {
      const { inbox, tasks, delivery } = fixture()
      ipcMainHandle('test:external', () => undefined)
      const surface = createNotificationElectronSurface(inbox, tasks, delivery)
      native.failAt = channel
      expect(() => surface.install()).toThrow(`install failed: ${channel}`)
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      native.failAt = undefined
      await (await surface.install()).uninstall()
      expect([...native.handlers.keys()]).toEqual(['test:external'])
    }
  )
})
