import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import { TaskNotificationService } from './task-notifications'
import {
  buildComputeApprovalBroadcast,
  buildConnectorApprovalBroadcast,
  buildConnectorCredentialRequestBroadcast,
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
      provider_id: 'ssh:cluster',
      provider_name: 'Research Cluster',
      shape: 'scheduler_cluster',
      intent: 'Run molecular dynamics'
    }
    const context = {
      sessionId: 'session-42',
      projectId: 'project-1',
      operation: 'call_command'
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
