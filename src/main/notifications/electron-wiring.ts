import type { Notification } from 'electron'

import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  NotificationDesktopAvailability,
  NotificationTestResult
} from '../../shared/notifications'
import type {
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import type { ComputeApprovalContext } from '../compute/compute-approval-broker'
import type { Logger } from '../logger'
import type { NativeTranslator } from '../locale/main-process-messages'
import {
  runTaskNotificationInBackground,
  type TaskNotificationRequest,
  type TaskNotificationService
} from './task-notifications'

// Builds the `show` callback the task-notification service hands notifications to. Extracted from
// registerIpcHandlers so the headless and Notification.isSupported gates have a unit-level home —
// inline closures were untestable, and a future regression on the headless contract would be invisible
// to the existing TaskNotificationService tests (which only see the primitive filter rules).
export type BuildTaskNotificationShowDeps = {
  notificationCtor: typeof Notification
  liveNotifications: Set<Notification>
  log: Pick<Logger, 'info' | 'warn'>
  headless: boolean
  translate?: NativeTranslator
}

type TaskNotificationAvailabilityDeps = Pick<
  BuildTaskNotificationShowDeps,
  'notificationCtor' | 'headless'
>

export const getTaskNotificationAvailability = (
  deps: TaskNotificationAvailabilityDeps
): NotificationDesktopAvailability => {
  if (deps.headless) return 'unavailable'
  try {
    return deps.notificationCtor.isSupported() ? 'supported' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const deliverTaskNotification = (
  deps: BuildTaskNotificationShowDeps,
  request: TaskNotificationRequest,
  onResult?: (result: NotificationTestResult) => void
): Notification | undefined => {
  const { title, body, onClick } = request
  if (getTaskNotificationAvailability(deps) === 'unavailable') {
    onResult?.('unavailable')
    return undefined
  }

  let notification: Notification
  try {
    notification = new deps.notificationCtor({ title, body })
  } catch (error) {
    deps.log.warn('task notification delivery failed', { title, error: errorMessage(error) })
    onResult?.('failed')
    return undefined
  }

  let resultReported = false
  const reportResult = (result: NotificationTestResult): void => {
    if (resultReported) return
    resultReported = true
    onResult?.(result)
  }

  deps.log.info('task notification delivery attempted', { title, supported: true })
  deps.liveNotifications.add(notification)
  notification.once('show', () => {
    deps.log.info('task notification shown', { title })
    reportResult('shown')
  })
  notification.once('failed', (_event, error) => {
    deps.liveNotifications.delete(notification)
    deps.log.warn('task notification delivery failed', { title, error })
    reportResult('failed')
  })
  notification.once('click', () => {
    deps.liveNotifications.delete(notification)
    onClick()
  })
  notification.once('close', () => {
    deps.liveNotifications.delete(notification)
    reportResult('unconfirmed')
  })
  try {
    notification.show()
  } catch (error) {
    deps.liveNotifications.delete(notification)
    deps.log.warn('task notification delivery failed', { title, error: errorMessage(error) })
    reportResult('failed')
    return undefined
  }
  return notification
}

export const buildTaskNotificationShow =
  (deps: BuildTaskNotificationShowDeps) =>
  (request: TaskNotificationRequest): void => {
    deliverTaskNotification(deps, request)
  }

export const showTestTaskNotification = (
  deps: BuildTaskNotificationShowDeps,
  timeoutMs = 2_000
): Promise<NotificationTestResult> =>
  new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: NotificationTestResult): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(result)
    }

    const notification = deliverTaskNotification(
      deps,
      {
        title: deps.translate?.('Test notification') ?? 'Test notification',
        body:
          deps.translate?.('System notifications from Open Science are working.') ??
          'System notifications from Open Science are working.',
        onClick: () => undefined
      },
      finish
    )
    if (!settled) {
      timeout = setTimeout(() => {
        if (notification) deps.liveNotifications.delete(notification)
        finish('unconfirmed')
      }, timeoutMs)
    }
  })

// Builds the ApprovalBroker broadcast callback. The wire-up is the exact seam that the previous
// spec review flagged: a wrong implementation (e.g. forgetting to pass sessionId through, or routing
// to the wrong broadcast channel) would break notification click-to-open without TaskNotificationService
// tests catching it.
export type BuildConnectorApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'connectors:approval-request',
    payload: ConnectorApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleConnectorApproval'>
  onNotificationError?: (error: unknown) => void
}

export const buildConnectorApprovalBroadcast =
  (deps: BuildConnectorApprovalBroadcastDeps) =>
  (request: ConnectorApprovalRequest): void => {
    deps.broadcastToRenderers('connectors:approval-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleConnectorApproval(request, request.sessionId),
      deps.onNotificationError
    )
  }

export type BuildConnectorCredentialRequestBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'connectors:credential-request',
    payload: ConnectorCredentialRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleConnectorCredentialRequest'>
  onNotificationError?: (error: unknown) => void
}

export const buildConnectorCredentialRequestBroadcast =
  (deps: BuildConnectorCredentialRequestBroadcastDeps) =>
  (request: ConnectorCredentialRequest): void => {
    deps.broadcastToRenderers('connectors:credential-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleConnectorCredentialRequest(request),
      deps.onNotificationError
    )
  }

export type BuildComputeApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'compute:approval-request',
    payload: ComputeApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleComputeApproval'>
  onNotificationError?: (error: unknown) => void
}

// Compute's grant check owns the session context. Add it only to the renderer projection so the UI
// can defer a Session-owned modal without changing the broker's authoritative pending request.
export const buildComputeApprovalBroadcast =
  (deps: BuildComputeApprovalBroadcastDeps) =>
  (request: ComputeApprovalRequest, context?: ComputeApprovalContext): void => {
    deps.broadcastToRenderers('compute:approval-request', {
      ...request,
      ...(context?.sessionId ? { session_id: context.sessionId } : {})
    })
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleComputeApproval(request, context?.sessionId),
      deps.onNotificationError
    )
  }

export type BuildSkillImportApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'skills:conversation-import-request',
    payload: ConversationSkillImportApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleSkillImportApproval'>
  onNotificationError?: (error: unknown) => void
}

// A Skill import already carries its session id, so one callback can deliver both the renderer card
// and the background desktop signal.
export const buildSkillImportApprovalBroadcast =
  (deps: BuildSkillImportApprovalBroadcastDeps) =>
  (request: ConversationSkillImportApprovalRequest): void => {
    deps.broadcastToRenderers('skills:conversation-import-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleSkillImportApproval(request),
      deps.onNotificationError
    )
  }
