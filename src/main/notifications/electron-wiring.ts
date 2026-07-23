import type { Notification } from 'electron'

import type { ConnectorApprovalRequest } from '../../shared/settings'
import type { Logger } from '../logger'
import type { TaskNotificationRequest, TaskNotificationService } from './task-notifications'

// Builds the `show` callback the task-notification service hands notifications to. Extracted from
// registerIpcHandlers so the headless and Notification.isSupported gates have a unit-level home —
// inline closures were untestable, and a future regression on the headless contract would be invisible
// to the existing TaskNotificationService tests (which only see the primitive filter rules).
export type BuildTaskNotificationShowDeps = {
  notificationCtor: typeof Notification
  liveNotifications: Set<Notification>
  log: Pick<Logger, 'info'>
  headless: boolean
}

export const buildTaskNotificationShow =
  (deps: BuildTaskNotificationShowDeps) =>
  (request: TaskNotificationRequest): void => {
    const { title, body, onClick } = request

    // Headless --serve launches never notify by contract: there is no local desktop user to see the
    // banner, and a click here would create a main window where none belongs.
    if (deps.headless) return
    // Daemon-less Linux hosts degrade the same way.
    if (!deps.notificationCtor.isSupported()) return

    const notification = new deps.notificationCtor({ title, body })

    // Logged so a silently-swallowed banner (OS permission, Focus mode) is distinguishable from a
    // gate that stopped delivery upstream.
    deps.log.info('delivering task notification', { title, supported: true })
    // Retain the instance until the banner resolves; a GC before click would silently drop the
    // handler on some platforms.
    deps.liveNotifications.add(notification)
    notification.once('click', () => {
      deps.liveNotifications.delete(notification)
      onClick()
    })
    notification.once('close', () => deps.liveNotifications.delete(notification))
    notification.show()
  }

// Builds the ApprovalBroker broadcast callback. The wire-up is the exact seam that the previous
// spec review flagged: a wrong implementation (e.g. forgetting to pass sessionId through, or routing
// to the wrong broadcast channel) would break notification click-to-open without TaskNotificationService
// tests catching it.
export type BuildConnectorApprovalBroadcastDeps = {
  broadcastToRenderers: (channel: string, payload: ConnectorApprovalRequest) => void
  taskNotifications: Pick<TaskNotificationService, 'handleConnectorApproval'>
}

export const buildConnectorApprovalBroadcast =
  (deps: BuildConnectorApprovalBroadcastDeps) =>
  (request: ConnectorApprovalRequest): void => {
    deps.broadcastToRenderers('connectors:approval-request', request)
    void deps.taskNotifications.handleConnectorApproval(request, request.sessionId)
  }
