import { ipcMain } from 'electron'

import { LIFECYCLE_CHANNELS } from '../shared/lifecycle-events'
import { createLogger } from './logger'
import { broadcastToRenderers } from './renderer-broadcast'

const log = createLogger('lifecycle-broadcast')

// Lifecycle notifications keep first-party clients fresh, but a disconnected renderer must never
// turn an already-committed repository mutation into a failed RPC.
const broadcastLifecycleEvent = <Payload>(channel: string, payload: Payload): void => {
  try {
    broadcastToRenderers(channel, payload)
  } catch (error) {
    log.warn('Renderer lifecycle broadcast failed (non-fatal)', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

const getLifecycleClientId = (event: {
  sender: { id: number; lifecycleClientId?: string }
}): string => event.sender.lifecycleClientId ?? `electron:${event.sender.id}`

const registerLifecycleIpcHandlers = (): void => {
  ipcMain.handle(LIFECYCLE_CHANNELS.clientId, (event) => getLifecycleClientId(event))
}

export { broadcastLifecycleEvent, getLifecycleClientId, registerLifecycleIpcHandlers }
