import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectorApprovalRequest } from '../../shared/settings'
import type { TaskNotificationService } from './task-notifications'
import { buildConnectorApprovalBroadcast, buildTaskNotificationShow } from './electron-wiring'

// Minimal stand-in for Electron's Notification class: exposes the static isSupported check the
// helper consults, plus the `once(event, cb)` / `show()` surface it drives. Production
// implementations also retain handlers across GC; this fake only models the wire-up.
class FakeNotification {
  static isSupported = vi.fn(() => true)
  static reset(): void {
    FakeNotification.isSupported.mockReset()
    FakeNotification.isSupported.mockReturnValue(true)
  }

  readonly once = vi.fn((event: 'click' | 'close', _cb: () => void) => {
    this.handlers[event] = _cb
  })

  readonly show = vi.fn()
  private readonly handlers: Partial<Record<'click' | 'close', () => void>> = {}

  fire(event: 'click' | 'close'): void {
    this.handlers[event]?.()
  }
}

const createLog = (): { info: (message: string, data?: unknown) => void } => ({
  info: vi.fn() as unknown as (message: string, data?: unknown) => void
})

afterEach(() => {
  FakeNotification.reset()
})

describe('buildTaskNotificationShow', () => {
  it('does nothing when headless is true (the web-serve contract)', () => {
    const log = createLog()
    const notifications = new Set<FakeNotification>()
    const show = buildTaskNotificationShow({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: true
    })

    show({ title: 't', body: 'b', onClick: vi.fn() })

    expect(notifications.size).toBe(0)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('delivers the notification when not headless and the OS supports it', () => {
    const log = createLog()
    const notifications = new Set<FakeNotification>()
    const onClick = vi.fn()
    const show = buildTaskNotificationShow({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: false
    })

    show({ title: 'Task completed', body: 'b', onClick })

    const [notification] = Array.from(notifications)
    expect(notification?.show).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      'delivering task notification',
      expect.objectContaining({ title: 'Task completed' })
    )

    // The click handler stays live across the lifetime of the banner (not GC'd).
    notification?.fire('click')
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(notifications.has(notification)).toBe(false)
  })

  it('skips delivery when Notification.isSupported() reports no daemon', () => {
    const log = createLog()
    FakeNotification.isSupported.mockReturnValue(false)
    const notifications = new Set<FakeNotification>()
    const show = buildTaskNotificationShow({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: false
    })

    show({ title: 't', body: 'b', onClick: vi.fn() })

    expect(notifications.size).toBe(0)
    expect(log.info).not.toHaveBeenCalled()
  })
})

describe('buildConnectorApprovalBroadcast', () => {
  it('passes the triggering sessionId through to handleConnectorApproval', () => {
    const broadcastToRenderers = vi.fn()
    const handleConnectorApproval = vi.fn().mockResolvedValue(undefined)
    const broadcast = buildConnectorApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications: { handleConnectorApproval } as Pick<
        TaskNotificationService,
        'handleConnectorApproval'
      >
    })

    const request = {
      id: 'req-1',
      connector: 'pubchem',
      method: 'search_compound',
      argsPreview: '{}',
      sessionId: 'session-42'
    } satisfies ConnectorApprovalRequest

    broadcast(request)

    expect(broadcastToRenderers).toHaveBeenCalledWith('connectors:approval-request', request)
    expect(handleConnectorApproval).toHaveBeenCalledWith(request, 'session-42')
  })

  it('omits the sessionId argument when none is on the request (notebook path)', () => {
    const broadcastToRenderers = vi.fn()
    const handleConnectorApproval = vi.fn().mockResolvedValue(undefined)
    const broadcast = buildConnectorApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications: { handleConnectorApproval } as Pick<
        TaskNotificationService,
        'handleConnectorApproval'
      >
    })

    const request = {
      id: 'req-2',
      connector: 'pubchem',
      method: 'search_compound',
      argsPreview: '{}'
    } satisfies ConnectorApprovalRequest

    broadcast(request)

    expect(handleConnectorApproval).toHaveBeenCalledWith(request, undefined)
  })
})
