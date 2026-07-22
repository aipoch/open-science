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

export { broadcastLifecycleEvent }
