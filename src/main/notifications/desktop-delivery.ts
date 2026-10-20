import type { NotificationInboxDesktopRuntime } from './notification-inbox-controller'
import { randomUUID } from 'node:crypto'
import type {
  NotificationDesktopAvailability,
  NotificationTestResult
} from '../../shared/notifications'
import type { DesktopNativeOperation } from '../desktop-native-contract'
import type { TaskNotificationRequest } from './task-notifications'
import type { NativeTranslator } from '../locale/main-process-messages'

// Filtering, privacy preferences and durable inbox state stay in TaskNotificationService.
// Only OS delivery and fresh native focus cross the desktop connection.
export type DesktopNotificationDelivery = {
  isAppFocused(): boolean | Promise<boolean>
  show(request: TaskNotificationRequest): void
  getAvailability(): NotificationDesktopAvailability | Promise<NotificationDesktopAvailability>
  sendTest(): Promise<NotificationTestResult>
}

export function createRemoteNotificationDelivery(
  requestNative: (request: DesktopNativeOperation) => Promise<unknown>,
  translate: NativeTranslator,
  onError: (error: unknown) => void
): DesktopNotificationDelivery & {
  inbox: NotificationInboxDesktopRuntime
  handleAction(token: string, action: 'clicked' | 'closed'): void
  disconnect(): void
  requestAttention(): void
  clearAttention(): void
  activate(sessionId?: string): void
} {
  const clicks = new Map<string, () => void>()
  const send = (request: DesktopNativeOperation): void => {
    void requestNative(request).catch(onError)
  }
  return {
    inbox: {
      isAppFocused: async () =>
        (await requestNative({ operation: 'notification-main-focus' })) as boolean,
      confirmSessionVisible: async (sessionId) =>
        (await requestNative({ operation: 'notification-visible', sessionId })) as boolean,
      badge: { setCount: (count) => send({ operation: 'notification-badge', count }) }
    },
    isAppFocused: async () => (await requestNative({ operation: 'notification-focus' })) as boolean,
    getAvailability: async () =>
      (await requestNative({
        operation: 'notification-availability'
      })) as NotificationDesktopAvailability,
    sendTest: async () =>
      (await requestNative({
        operation: 'notification-test',
        title: translate('Test notification'),
        body: translate('System notifications from Open-Science are working.')
      })) as NotificationTestResult,
    show: ({ title, body, onClick }) => {
      // Keep callback retention bounded even if an OS never reports that a banner closed.
      if (clicks.size >= 512) throw new Error('Too many outstanding desktop notifications.')
      const token = randomUUID()
      clicks.set(token, onClick)
      void requestNative({ operation: 'notification-show', token, title, body }).catch((error) => {
        clicks.delete(token)
        onError(error)
      })
    },
    handleAction: (token, action) => {
      const click = clicks.get(token)
      clicks.delete(token)
      if (action === 'clicked') {
        try {
          click?.()
        } catch (error) {
          onError(error)
        }
      }
    },
    disconnect: () => clicks.clear(),
    requestAttention: () => send({ operation: 'notification-attention', action: 'request' }),
    clearAttention: () => send({ operation: 'notification-attention', action: 'clear' }),
    activate: (sessionId) => send({ operation: 'notification-activate', sessionId })
  }
}
