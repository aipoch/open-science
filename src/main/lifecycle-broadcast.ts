import { ipcMainHandle } from './ipc-handler-registry'

import { LIFECYCLE_CHANNELS } from '../shared/lifecycle-events'
import { callerLeaseForEvent } from './caller-lifecycle'
import { callerContextForEvent } from './caller-context'
import { createLogger } from './logger'
import type { ApplicationEventChannel, ApplicationEventMap } from './application-events'
import { broadcastToRenderers } from './renderer-broadcast'

const log = createLogger('lifecycle-broadcast')

// Lifecycle notifications keep first-party clients fresh, but a disconnected renderer must never
// turn an already-committed repository mutation into a failed RPC.
const broadcastLifecycleEvent = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  try {
    broadcastToRenderers(channel, payload)
  } catch (error) {
    log.warn('Renderer lifecycle broadcast failed (non-fatal)', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

const getLifecycleClientId = (event: { sender: { id: number } }): string => {
  const context = callerContextForEvent(event)
  const lease = callerLeaseForEvent(event)
  if (lease.leaseId !== context.leaseId || !lease.isCurrent()) {
    throw new Error('Application caller lease is no longer current.')
  }
  return context.lifecycleClientId
}

const registerLifecycleIpcHandlers = (): void => {
  ipcMainHandle(LIFECYCLE_CHANNELS.clientId, (event) => getLifecycleClientId(event))
}

export { broadcastLifecycleEvent, getLifecycleClientId, registerLifecycleIpcHandlers }
