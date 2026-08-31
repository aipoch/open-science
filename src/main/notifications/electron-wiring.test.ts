import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { TaskNotificationService } from './task-notifications'
import {
  buildComputeApprovalBroadcast,
  buildConnectorApprovalBroadcast,
  buildConnectorCredentialRequestBroadcast,
  getTaskNotificationAvailability,
  showTestTaskNotification,
  buildSkillImportApprovalBroadcast,
  buildTaskNotificationShow
} from './electron-wiring'

// Minimal stand-in for Electron's Notification class: exposes the static isSupported check the
// helper consults, plus the `once(event, cb)` / `show()` surface it drives. Production
// implementations also retain handlers across GC; this fake only models the wire-up.
class FakeNotification {
  static isSupported = vi.fn(() => true)
  static reset(): void {
    FakeNotification.isSupported.mockReset()
    FakeNotification.isSupported.mockReturnValue(true)
  }

  readonly once = vi.fn(
    (event: 'show' | 'click' | 'close' | 'failed', _cb: (...args: unknown[]) => void) => {
      this.handlers[event] = _cb
    }
  )

  readonly show = vi.fn()
  private readonly handlers: Partial<
    Record<'show' | 'click' | 'close' | 'failed', (...args: unknown[]) => void>
  > = {}

  fire(event: 'show' | 'click' | 'close' | 'failed', ...args: unknown[]): void {
    this.handlers[event]?.(...args)
  }
}

const createLog = (): {
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
} => ({
  info: vi.fn() as unknown as (message: string, data?: unknown) => void,
  warn: vi.fn() as unknown as (message: string, data?: unknown) => void
})

afterEach(() => {
  vi.useRealTimers()
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

    show({ title: 't', body: 'b', attention: true, onClick: vi.fn() })

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

    show({ title: 'Task completed', body: 'b', attention: true, onClick })

    const [notification] = Array.from(notifications)
    expect(notification?.show).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      'task notification delivery attempted',
      expect.objectContaining({ title: 'Task completed' })
    )

    // The click handler stays live across the lifetime of the banner (not GC'd).
    notification?.fire('click')
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(notifications.has(notification)).toBe(false)
  })

  it('distinguishes a delivery attempt from Electron confirming the notification was shown', () => {
    const log = createLog()
    const notifications = new Set<FakeNotification>()
    const show = buildTaskNotificationShow({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: false
    })

    show({ title: 'Task completed', body: 'A task completed.', onClick: vi.fn() })

    expect(log.info).toHaveBeenCalledWith('task notification delivery attempted', {
      title: 'Task completed',
      supported: true
    })
    expect(log.info).not.toHaveBeenCalledWith('task notification shown', expect.anything())

    Array.from(notifications)[0]?.fire('show')

    expect(log.info).toHaveBeenCalledWith('task notification shown', {
      title: 'Task completed'
    })
  })

  it('records Electron native delivery failures without claiming the notification was shown', () => {
    const log = createLog()
    const notifications = new Set<FakeNotification>()
    const show = buildTaskNotificationShow({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: false
    })

    show({ title: 'Task failed', body: 'A task failed.', onClick: vi.fn() })
    Array.from(notifications)[0]?.fire('failed', {}, 'Notifications are blocked')

    expect(log.warn).toHaveBeenCalledWith('task notification delivery failed', {
      title: 'Task failed',
      error: 'Notifications are blocked'
    })
    expect(log.info).not.toHaveBeenCalledWith('task notification shown', expect.anything())
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

    show({ title: 't', body: 'b', attention: true, onClick: vi.fn() })

    expect(notifications.size).toBe(0)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('still requests native attention for an approval when the daemon is unavailable', async () => {
    const log = createLog()
    FakeNotification.isSupported.mockReturnValue(false)
    const notifications = new Set<FakeNotification>()
    const requestAttention = vi.fn()
    const service = new TaskNotificationService({
      isEnabled: () => Promise.resolve(true),
      isAppFocused: () => false,
      translate: englishNativeTranslator,
      show: buildTaskNotificationShow({
        notificationCtor: FakeNotification as never,
        liveNotifications: notifications as never,
        log,
        headless: false
      })
    })
    service.setAttentionHandlers({ request: requestAttention, clear: vi.fn() })
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    const request = {
      requestId: 'request-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: []
    }

    await service.handlePermissionRequest(request)

    expect(notifications.size).toBe(0)
    expect(requestAttention).toHaveBeenCalledOnce()
  })
})

describe('native task notification diagnostics', () => {
  it('reports only portable supported or unavailable availability', () => {
    expect(
      getTaskNotificationAvailability({
        notificationCtor: FakeNotification as never,
        headless: false
      })
    ).toBe('supported')

    FakeNotification.isSupported.mockReturnValue(false)
    expect(
      getTaskNotificationAvailability({
        notificationCtor: FakeNotification as never,
        headless: false
      })
    ).toBe('unavailable')
    expect(
      getTaskNotificationAvailability({
        notificationCtor: FakeNotification as never,
        headless: true
      })
    ).toBe('unavailable')
  })

  it('returns shown only after Electron confirms an explicit test notification', async () => {
    const log = createLog()
    const notifications = new Set<FakeNotification>()
    const translate = vi.fn((key: string) => `translated: ${key}`)
    const result = showTestTaskNotification({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log,
      headless: false,
      translate
    })

    expect(notifications.size).toBe(1)
    expect(translate).toHaveBeenCalledWith('Test notification')
    expect(translate).toHaveBeenCalledWith('System notifications from Open Science are working.')
    Array.from(notifications)[0]?.fire('show')

    await expect(result).resolves.toBe('shown')
  })

  it.each([
    ['failed', 'failed'],
    ['close', 'unconfirmed']
  ] as const)('reports %s test delivery as %s', async (event, expected) => {
    const notifications = new Set<FakeNotification>()
    const result = showTestTaskNotification({
      notificationCtor: FakeNotification as never,
      liveNotifications: notifications as never,
      log: createLog(),
      headless: false
    })

    Array.from(notifications)[0]?.fire(event, {}, 'blocked')

    await expect(result).resolves.toBe(expected)
  })

  it('reports an unsupported test notification as unavailable', async () => {
    FakeNotification.isSupported.mockReturnValue(false)

    await expect(
      showTestTaskNotification({
        notificationCtor: FakeNotification as never,
        liveNotifications: new Set() as never,
        log: createLog(),
        headless: false
      })
    ).resolves.toBe('unavailable')
  })

  it('releases an unconfirmed test notification after the confirmation timeout', async () => {
    vi.useFakeTimers()
    const notifications = new Set<FakeNotification>()
    const result = showTestTaskNotification(
      {
        notificationCtor: FakeNotification as never,
        liveNotifications: notifications as never,
        log: createLog(),
        headless: false
      },
      10
    )

    await vi.advanceTimersByTimeAsync(10)

    await expect(result).resolves.toBe('unconfirmed')
    expect(notifications.size).toBe(0)
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

  it('reports a rejected notification operation without interrupting the approval broadcast', async () => {
    const error = new Error('notification delivery escaped')
    const rejected = Promise.reject(error)
    // The assertion targets the broadcast error channel; keep the test process from also treating
    // the deliberately rejected fixture as a global unhandled rejection.
    void rejected.catch(() => undefined)
    const onNotificationError = vi.fn()
    const request = {
      id: 'req-3',
      connector: 'pubchem',
      method: 'search_compound',
      argsPreview: '{}',
      sessionId: 'session-42'
    } satisfies ConnectorApprovalRequest
    const broadcastToRenderers = vi.fn()
    const broadcast = buildConnectorApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications: {
        handleConnectorApproval: vi.fn().mockReturnValue(rejected)
      } as Pick<TaskNotificationService, 'handleConnectorApproval'>,
      onNotificationError
    })

    broadcast(request)
    await Promise.resolve()

    expect(broadcastToRenderers).toHaveBeenCalledWith('connectors:approval-request', request)
    expect(onNotificationError).toHaveBeenCalledWith(error)
  })
})

describe('buildConnectorCredentialRequestBroadcast', () => {
  it('broadcasts the Composer request and records its global attention path', () => {
    const broadcastToRenderers = vi.fn()
    const handleConnectorCredentialRequest = vi.fn().mockResolvedValue(undefined)
    const broadcast = buildConnectorCredentialRequestBroadcast({
      broadcastToRenderers,
      taskNotifications: { handleConnectorCredentialRequest } as Pick<
        TaskNotificationService,
        'handleConnectorCredentialRequest'
      >
    })
    const request = {
      id: 'credential-1',
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-42'
    } satisfies ConnectorCredentialRequest

    broadcast(request)

    expect(broadcastToRenderers).toHaveBeenCalledWith('connectors:credential-request', request)
    expect(handleConnectorCredentialRequest).toHaveBeenCalledWith(request)
  })
})

describe('approval notification broadcasts', () => {
  it('forwards Compute approval context to the notification service', () => {
    const broadcastToRenderers = vi.fn()
    const handleComputeApproval = vi.fn().mockResolvedValue(undefined)
    const broadcast = buildComputeApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications: { handleComputeApproval } as Pick<
        TaskNotificationService,
        'handleComputeApproval'
      >
    })
    const request: ComputeApprovalRequest = {
      id: 'compute-1',
      operation: 'call_command',
      provider_id: 'ssh:cluster',
      provider_name: 'Research Cluster',
      shape: 'scheduler_cluster',
      intent: 'Run molecular dynamics',
      command_preview: 'run-md',
      command_full: 'run-md'
    }
    const context = {
      sessionId: 'session-42',
      projectId: 'project-1',
      operation: 'call_command' as const
    }

    broadcast(request, context)

    expect(broadcastToRenderers).toHaveBeenCalledWith('compute:approval-request', {
      ...request,
      session_id: 'session-42'
    })
    expect(handleComputeApproval).toHaveBeenCalledWith(request, 'session-42')
  })

  it('forwards Skill import approval requests to the notification service', () => {
    const broadcastToRenderers = vi.fn()
    const handleSkillImportApproval = vi.fn().mockResolvedValue(undefined)
    const broadcast = buildSkillImportApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications: { handleSkillImportApproval } as Pick<
        TaskNotificationService,
        'handleSkillImportApproval'
      >
    })
    const request: ConversationSkillImportApprovalRequest = {
      id: 'skill-1',
      sessionId: 'session-42',
      source: { kind: 'attachment', label: 'analysis-tools.skill' },
      previews: [],
      skipped: []
    }

    broadcast(request)

    expect(broadcastToRenderers).toHaveBeenCalledWith('skills:conversation-import-request', request)
    expect(handleSkillImportApproval).toHaveBeenCalledWith(request)
  })
})
