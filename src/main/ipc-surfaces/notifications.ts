import { ipcMainHandle } from '../ipc-handler-registry'
import {
  getTaskNotificationAvailability,
  showTestTaskNotification,
  type BuildTaskNotificationShowDeps
} from '../notifications/electron-wiring'
import {
  registerNotificationInboxIpcAdapter,
  type NotificationInboxIpcOwner
} from '../notifications/notification-inbox-ipc'
import type { TaskNotificationService } from '../notifications/task-notifications'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { createElectronSurfaceAdapter } from './adapter'

export const createNotificationElectronSurface = (
  inbox: NotificationInboxIpcOwner,
  taskNotifications: Pick<
    TaskNotificationService,
    'peekPendingOpenSession' | 'takePendingOpenSession'
  >,
  delivery: BuildTaskNotificationShowDeps
): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('task-notifications', () => {
    registerNotificationInboxIpcAdapter(inbox)
    ipcMainHandle('notifications:get-desktop-availability', () =>
      getTaskNotificationAvailability(delivery)
    )
    ipcMainHandle('notifications:send-test', () => showTestTaskNotification(delivery))
    // Peek after hydration, then consume only the inspected target. An older IPC round trip
    // must not clear a newer click target; the shared task owner checks token identity.
    ipcMainHandle('notifications:peek-pending-open-session', () =>
      taskNotifications.peekPendingOpenSession()
    )
    ipcMainHandle('notifications:take-pending-open-session', (_event, expectedToken: unknown) =>
      typeof expectedToken === 'number' && Number.isSafeInteger(expectedToken) && expectedToken > 0
        ? taskNotifications.takePendingOpenSession(expectedToken)
        : null
    )
  })
