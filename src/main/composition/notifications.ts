import { BrowserWindow, Notification } from 'electron'
import { createNotificationElectronSurface } from '../ipc-surfaces/notifications'
import { createLogger, errorLogFields } from '../logger'
import { buildTaskNotificationShow } from '../notifications/electron-wiring'
import { TaskNotificationService } from '../notifications/task-notifications'
import type { composeSessionAuthority } from './session-authority'
import type { composeSettingsBootstrap } from './settings-bootstrap'
import type { composeStorageStartup } from './storage-startup'

export function composeNotifications({
  surfaceAdapters,
  settingsBootstrap,
  storageStartup,
  sessionAuthority,
  headless,
  translate
}: {
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  settingsBootstrap: Awaited<ReturnType<typeof composeSettingsBootstrap>>
  storageStartup: Awaited<ReturnType<typeof composeStorageStartup>>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  headless: boolean
  translate: import('../locale/main-process-messages').NativeTranslator
}): {
  notificationsLog: ReturnType<typeof createLogger>
  taskNotifications: TaskNotificationService
} {
  // Desktop notifications for finished/failed agent tasks and approval waits. Delivery is
  // Electron's Notification (Notification Center on macOS, toasts on Windows, libnotify on Linux);
  // the service itself stays Electron-free so its filtering rules are unit-testable. The click
  // handler is bound later, in index.ts, where showMainWindow exists. Constructed before the
  // connector approval broker, which nudges through it.
  //
  // The wiring is extracted into electron-wiring helpers so the headless gate and the broker→service
  // sessionId pass-through have a unit-level home — inline closures were untestable, and a
  // regression on either of those contracts would not be caught by TaskNotificationService tests.
  const notificationsLog = createLogger('notifications')
  const liveNotifications = new Set<Notification>()
  const taskNotificationDeliveryDeps = {
    notificationCtor: Notification,
    liveNotifications,
    log: notificationsLog,
    headless,
    translate
  }
  const taskNotifications = new TaskNotificationService({
    isEnabled: () => settingsBootstrap.settingsService.getNotificationsEnabled(),
    showContent: () => settingsBootstrap.settingsService.getShowNotificationContent(),
    isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    translate,
    show: buildTaskNotificationShow(taskNotificationDeliveryDeps),
    onDeliveryError: (error) =>
      notificationsLog.warn('task notification delivery failed', errorLogFields(error)),
    onAttentionError: (error) =>
      notificationsLog.warn('desktop attention handler failed', errorLogFields(error)),
    hasNonTerminalComputeJobs: async (sessionId) => {
      const computeJobs = sessionAuthority.computeJobActivityRef.current
      if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
      return (await computeJobs.countNonTerminalBySession(sessionId)) > 0
    },
    inbox: storageStartup.notificationInbox,
    onInboxError: (error) =>
      notificationsLog.warn('message center recording failed', errorLogFields(error))
  })
  surfaceAdapters.push(
    createNotificationElectronSurface(
      storageStartup.notificationInbox,
      taskNotifications,
      taskNotificationDeliveryDeps
    )
  )
  return { notificationsLog, taskNotifications }
}
