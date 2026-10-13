import type { BrowserWindow } from 'electron'
import { createLogger } from '@aipoch/diagnostics/node'

const logger = createLogger('desktop-event-delivery')

export function deliverDesktopEvent(
  windows: readonly BrowserWindow[],
  isMainWindow: (window: BrowserWindow) => boolean,
  channel: string,
  payload: unknown,
  onFailure?: (window: BrowserWindow) => void
): void {
  for (const window of windows) {
    try {
      if (!window.isDestroyed() && isMainWindow(window) && !window.webContents.isDestroyed())
        window.webContents.send(channel, payload)
    } catch {
      // Window destruction can race delivery. Preserve the shared backend connection and peers.
      logger.warn('desktop event delivery failed', { reason: 'event-delivery-failed' })
      try {
        onFailure?.(window)
      } catch {
        logger.warn('desktop event invalidation failed', { reason: 'event-delivery-failed' })
      }
    }
  }
}
