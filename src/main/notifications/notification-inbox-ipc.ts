import { ipcMainHandle } from '../ipc-handler-registry'
import type { NotificationInboxController } from './notification-inbox-controller'
import {
  requireNotificationMarkAllReadRequest,
  requireNotificationMarkReadRequest
} from './notification-inbox-requests'

type NotificationInboxIpcOwner = Pick<
  NotificationInboxController,
  'getSnapshot' | 'markAllRead' | 'markRead'
>

// Electron retains direct IPC adapters while local/remote Web dispatch through the application
// command router. Both adapters share request validation and the same backend-owned inbox.
const registerNotificationInboxIpcAdapter = (owner: NotificationInboxIpcOwner): void => {
  ipcMainHandle('notifications:get-snapshot', () => owner.getSnapshot())
  ipcMainHandle('notifications:mark-read', (_event, input: unknown) => {
    const request = requireNotificationMarkReadRequest(input)
    return owner.markRead(request.ids)
  })
  ipcMainHandle('notifications:mark-all-read', (_event, input: unknown) => {
    const request = requireNotificationMarkAllReadRequest(input)
    return owner.markAllRead(request.throughSequence)
  })
}

export { registerNotificationInboxIpcAdapter }
export type { NotificationInboxIpcOwner }
