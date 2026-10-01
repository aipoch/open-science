import type {
  NotificationInboxChanged,
  NotificationInboxSnapshot,
  NotificationDesktopAvailability,
  NotificationMarkAllReadRequest,
  NotificationMarkReadRequest,
  NotificationMarkSessionCompletionsReadRequest,
  NotificationTestResult,
  OpenSessionFromNotificationRequest,
  UnreadTaskViewState
} from '../notifications'

import {
  callable,
  ELECTRON,
  type AcpListener,
  type RemoveListener,
  EVENT,
  ELECTRON_EVENT,
  SEND
} from './definition'

export const contracts = {
  'notifications.getSnapshot': callable<() => Promise<NotificationInboxSnapshot>>()(
    'notifications',
    ['notifications:get-snapshot']
  ),
  'notifications.getDesktopAvailability': callable<
    () => Promise<NotificationDesktopAvailability>
  >()('notifications', ['notifications:get-desktop-availability', ELECTRON], {
    optionalMember: true
  }),
  'notifications.markAllRead': callable<
    (request: NotificationMarkAllReadRequest) => Promise<void>
  >()('notifications', ['notifications:mark-all-read']),
  'notifications.markRead': callable<(request: NotificationMarkReadRequest) => Promise<void>>()(
    'notifications',
    ['notifications:mark-read']
  ),
  'notifications.markSessionCompletionsRead': callable<
    (request: NotificationMarkSessionCompletionsReadRequest) => Promise<void>
  >()('notifications', ['notifications:mark-session-completions-read']),
  'notifications.sendTest': callable<() => Promise<NotificationTestResult>>()(
    'notifications',
    ['notifications:send-test', ELECTRON],
    { optionalMember: true }
  ),
  'notifications.onChanged': callable<
    (listener: AcpListener<NotificationInboxChanged>) => RemoveListener
  >()('notifications', ['notifications:changed', EVENT]),
  'notifications.onOpenSession': callable<(listener: () => void) => RemoveListener>()(
    'notifications',
    ['notifications:open-session', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'notifications.onViewProbe': callable<(listener: AcpListener<number>) => RemoveListener>()(
    'notifications',
    ['notifications:probe-unread-view', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'notifications.peekPendingOpenSession': callable<
    () => Promise<OpenSessionFromNotificationRequest | null>
  >()('notifications', ['notifications:peek-pending-open-session']),
  'notifications.syncViewState': callable<(state: UnreadTaskViewState) => void>()(
    'notifications',
    ['notifications:sync-unread-view', SEND],
    { optionalMember: true }
  ),
  'notifications.takePendingOpenSession': callable<
    (expectedToken: number) => Promise<OpenSessionFromNotificationRequest | null>
  >()('notifications', ['notifications:take-pending-open-session'])
} as const
