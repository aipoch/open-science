import { randomUUID } from 'node:crypto'

import {
  SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  type SessionPersistenceFlushAbortReason,
  type SessionPersistenceFlushResponse
} from '../../shared/session-persistence-flush'
import type { ApplicationEventPublisher } from '../application-events'

type RendererSessionPersistenceFlushDeps = {
  isRendererAvailable: () => boolean
  sendRequest: (requestId: string) => void
  onResponse: (listener: (response: SessionPersistenceFlushResponse) => void) => () => void
  onRendererGone: (listener: () => void) => () => void
  createRequestId: () => string
  timeoutMs: number
}

export const DEFAULT_RENDERER_FLUSH_TIMEOUT_MS = 5_000

export type RendererSessionPersistenceFlushOutcome =
  | 'completed'
  | 'conflict'
  | 'renderer-failed'
  | 'unavailable'
  | 'renderer-gone'
  | 'send-failed'
  | 'timeout'

export type RendererSessionPersistenceFlushPolicy = 'ordinary-shutdown' | 'data-root-handoff'
export type RendererSessionPersistenceSurface = 'electron-renderer' | 'web-renderer'
export type RendererSessionPersistenceTarget =
  | Readonly<{ surface: 'electron-renderer' }>
  | Readonly<{ surface: 'web-renderer'; lifecycleClientId: string }>

export const rendererSessionPersistenceFlushBlocksShutdown = (
  outcome: RendererSessionPersistenceFlushOutcome,
  policy: RendererSessionPersistenceFlushPolicy = 'ordinary-shutdown'
): boolean => {
  if (policy === 'data-root-handoff') {
    return outcome !== 'completed'
  }
  return outcome !== 'completed' && outcome !== 'unavailable' && outcome !== 'renderer-gone'
}

export const createWebSessionPersistenceFlush = (
  events: ApplicationEventPublisher,
  timeoutMs = DEFAULT_RENDERER_FLUSH_TIMEOUT_MS
): Readonly<{
  flush: (targetLifecycleClientId: string) => Promise<RendererSessionPersistenceFlushOutcome>
  acknowledge: (response: SessionPersistenceFlushResponse, lifecycleClientId: string) => void
  notifyAborted: (reason?: SessionPersistenceFlushAbortReason) => void
}> => {
  const responseListeners = new Set<
    (response: SessionPersistenceFlushResponse, lifecycleClientId: string) => void
  >()

  return Object.freeze({
    flush: (targetLifecycleClientId) =>
      requestRendererSessionPersistenceFlush({
        // A local Web command can only reach this gate from a live renderer. If its event stream is
        // unavailable, the bounded acknowledgement wait fails closed instead of switching roots.
        isRendererAvailable: () => true,
        sendRequest: (requestId) =>
          events.publish(SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL, {
            requestId,
            targetLifecycleClientId
          }),
        onResponse: (listener) => {
          const scopedListener = (
            response: SessionPersistenceFlushResponse,
            lifecycleClientId: string
          ): void => {
            if (lifecycleClientId === targetLifecycleClientId) listener(response)
          }
          responseListeners.add(scopedListener)
          return () => responseListeners.delete(scopedListener)
        },
        onRendererGone: () => () => undefined,
        createRequestId: randomUUID,
        timeoutMs
      }),
    acknowledge: (response, lifecycleClientId) => {
      for (const listener of responseListeners) listener(response, lifecycleClientId)
    },
    notifyAborted: (reason) =>
      events.publish(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL, reason ? { reason } : undefined)
  })
}

export const requestRendererSessionPersistenceFlush = async (
  deps: RendererSessionPersistenceFlushDeps
): Promise<RendererSessionPersistenceFlushOutcome> => {
  if (!deps.isRendererAvailable()) return 'unavailable'

  const requestId = deps.createRequestId()
  return new Promise<RendererSessionPersistenceFlushOutcome>((resolve) => {
    let settled = false
    let removeResponse = (): void => undefined
    let removeRendererGone = (): void => undefined
    const finish = (outcome: RendererSessionPersistenceFlushOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeResponse()
      removeRendererGone()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), deps.timeoutMs)
    removeResponse = deps.onResponse((response) => {
      if (response.requestId !== requestId) return
      if (response.status === 'completed' || response.status === 'conflict') {
        finish(response.status)
        return
      }
      finish('renderer-failed')
    })
    removeRendererGone = deps.onRendererGone(() => finish('renderer-gone'))

    try {
      deps.sendRequest(requestId)
    } catch {
      finish(deps.isRendererAvailable() ? 'send-failed' : 'renderer-gone')
    }
  })
}
