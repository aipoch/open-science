import { describe, expect, it, vi } from 'vitest'
import type { DesktopNativeOperation } from '../desktop-native-contract'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { createRemoteNotificationDelivery } from './desktop-delivery'

// The callback token is a transient capability issued by this connection, never a Session ID
// accepted from Electron or a renderer. Closing/detaching consumes it without activating work.
describe('remote notification delivery', () => {
  it('consumes each issued click once, rejects unknown tokens and revokes old connections', async () => {
    const requests: DesktopNativeOperation[] = []
    const native = vi.fn(async (request: DesktopNativeOperation) => {
      requests.push(request)
      return null
    })
    const onError = vi.fn()
    const delivery = createRemoteNotificationDelivery(native, englishNativeTranslator, onError)
    const click = vi.fn()
    const show = (): string => {
      delivery.show({ title: 'Task completed', body: 'Open the app for details.', onClick: click })
      const request = requests.at(-1)!
      if (request.operation !== 'notification-show') throw new Error('Expected notification')
      return request.token
    }
    delivery.handleAction('unknown', 'clicked')
    const first = show()
    delivery.handleAction(first, 'clicked')
    delivery.handleAction(first, 'clicked')
    expect(click).toHaveBeenCalledTimes(1)
    const closed = show()
    delivery.handleAction(closed, 'closed')
    delivery.handleAction(closed, 'clicked')
    const disconnected = show()
    delivery.disconnect()
    delivery.handleAction(disconnected, 'clicked')
    expect(click).toHaveBeenCalledTimes(1)
    native.mockRejectedValueOnce(new Error('lost connection'))
    const failed = show()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    delivery.handleAction(failed, 'clicked')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('queries fresh native focus and preserves availability and test results', async () => {
    const native = vi.fn(async (request: DesktopNativeOperation): Promise<unknown> => {
      if (request.operation === 'notification-focus') return true
      if (request.operation === 'notification-availability') return 'unavailable'
      if (request.operation === 'notification-test') return 'unconfirmed'
      return null
    })
    const delivery = createRemoteNotificationDelivery(native, englishNativeTranslator, vi.fn())
    expect(await delivery.isAppFocused()).toBe(true)
    expect(await delivery.getAvailability()).toBe('unavailable')
    expect(await delivery.sendTest()).toBe('unconfirmed')
    expect(native).toHaveBeenCalledWith({
      operation: 'notification-test',
      title: 'Test notification',
      body: 'System notifications from Open-Science are working.'
    })
  })
})
