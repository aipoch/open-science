import { ipcMainHandle } from '../ipc-handler-registry'
import type { NotificationInboxController } from './notification-inbox-controller'
import {
  requireNotificationMarkAllReadRequest,
  requireNotificationMarkReadRequest,
  requireNotificationMarkSessionCompletionsReadRequest,
  requireNotificationMarkSessionUnreadRequest
} from './notification-inbox-requests'

type NotificationInboxIpcOwner = Pick<
  NotificationInboxController,
  'getSnapshot' | 'markAllRead' | 'markRead' | 'markSessionCompletionsRead' | 'markSessionUnread'
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
  ipcMainHandle('notifications:mark-session-completions-read', (_event, input: unknown) => {
    const request = requireNotificationMarkSessionCompletionsReadRequest(input)
    return owner.markSessionCompletionsRead(request.sessionIds)
  })
  ipcMainHandle('notifications:mark-session-unread', (_event, input: unknown) => {
    const request = requireNotificationMarkSessionUnreadRequest(input)
    return owner.markSessionUnread(request.sessionIds)
  })
}

export { registerNotificationInboxIpcAdapter }
export type { NotificationInboxIpcOwner }
