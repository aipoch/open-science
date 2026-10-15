import { createSessionEventHydrator } from '../shared/session-event-hydrator'
import { projectSessionEventPayload } from './session-event-payload'
import { stringifyRpcJson } from './rpc-json'

type Event = { channel: string; payload: unknown }

// Reconciliation retains small invalidations; complete Session objects are loaded only for replay.
export function createDesktopRecoveryEventBuffer(): {
  push(event: Event): void
  drain(options: {
    load(request: { projectId: string; sessionId: string }): Promise<unknown>
    deliver(event: Event): void
    signal: AbortSignal
  }): Promise<void>
  clear(): void
} {
  let events: { event: Event; bytes: number }[] = []
  let bytes = 0
  let failure: Error | undefined
  let hydrator: ReturnType<typeof createSessionEventHydrator> | undefined
  let cancelDrain: (() => void) | undefined
  return {
    push(event) {
      if (failure) throw failure
      const projected = { ...event, payload: projectSessionEventPayload(event) }
      const size = Buffer.byteLength(stringifyRpcJson(projected))
      if (hydrator) {
        hydrator.receive(projected, size)
        return
      }
      if (events.length >= 2048 || bytes + size > 16 * 1024 * 1024) {
        failure = new Error('Desktop recovery event budget exceeded.')
        throw failure
      }
      bytes += size
      events.push({ event: projected, bytes: size })
    },
    async drain(options) {
      if (failure) throw failure
      options.signal.throwIfAborted()
      let current: typeof hydrator
      const aborted = (): void => cancelDrain?.()
      try {
        await new Promise<void>((resolve, reject) => {
          cancelDrain = () => {
            current?.dispose()
            reject(new Error('Desktop recovery canceled.'))
          }
          options.signal.addEventListener('abort', aborted, { once: true })
          current = createSessionEventHydrator({
            load: options.load,
            deliver: (event) => {
              options.signal.throwIfAborted()
              options.deliver(event)
            },
            onFailure: () => {
              failure = new Error('Desktop recovery event replay failed.')
              reject(failure)
            }
          })
          hydrator = current
          const pending = events
          events = []
          bytes = 0
          for (const entry of pending) current.receive(entry.event, entry.bytes)
          current.whenIdle(resolve)
        })
      } finally {
        options.signal.removeEventListener('abort', aborted)
        current?.dispose()
        if (hydrator === current) {
          hydrator = undefined
          cancelDrain = undefined
        }
      }
    },
    clear() {
      cancelDrain?.()
      hydrator = undefined
      cancelDrain = undefined
      events = []
      bytes = 0
      failure = undefined
    }
  }
}
