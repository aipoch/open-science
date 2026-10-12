import { MAX_ACP_RUNTIME_EVENTS, type AcpRuntimeEvent } from '../../shared/acp'

const EVENT_BROADCAST_INTERVAL_MS = 33
// A fast provider can emit more than one retained window before the 33 ms timer runs. Publish
// midway through that window so every prefix chunk reaches subscribers before bounded history can
// evict it, while ordinary streams still receive the same frame-level coalescing.
const MAX_COALESCED_BROADCAST_EVENTS = Math.floor(MAX_ACP_RUNTIME_EVENTS / 2)
// Leave room for the event envelope in the 16 MiB desktop/Web transport frame.
const MAX_COALESCED_BROADCAST_BYTES = 8 * 1024 * 1024

type AcpRuntimeEventBroadcastCoalescerOptions = Readonly<{
  publish: (events: readonly AcpRuntimeEvent[]) => void
  schedule?: (flush: () => void) => () => void
}>

const scheduleBroadcast = (flush: () => void): (() => void) => {
  const timer = setTimeout(flush, EVENT_BROADCAST_INTERVAL_MS)
  return () => clearTimeout(timer)
}

// Stop, error, and permission must not wait for the presentation cadence. Image-bearing
// messages flush with the pending prefix so a 250-event batch cannot accumulate binary
// payloads. Everything else, including tool starts, shares the 33 ms IPC batch.
const isImmediateBroadcastEvent = (event: AcpRuntimeEvent): boolean =>
  event.kind === 'stop' ||
  event.kind === 'error' ||
  event.kind === 'permission' ||
  Boolean(event.image)

// Owns one IPC batch for incremental renderer events. A thinking-model or tool-call storm
// must not structured-clone one payload per provider notification.
const createAcpRuntimeEventBroadcastCoalescer = (
  options: AcpRuntimeEventBroadcastCoalescerOptions
): {
  enqueue: (event: AcpRuntimeEvent) => void
  flush: () => void
} => {
  const pending: AcpRuntimeEvent[] = []
  let pendingBytes = 2 // JSON array brackets
  let cancelScheduled: (() => void) | undefined

  const flush = (): void => {
    cancelScheduled?.()
    cancelScheduled = undefined
    if (pending.length === 0) return
    const events = pending.splice(0, pending.length)
    pendingBytes = 2
    options.publish(events)
  }

  const schedule = (): void => {
    if (cancelScheduled) return
    const scheduleFlush = options.schedule ?? scheduleBroadcast
    cancelScheduled = scheduleFlush(flush)
  }

  return {
    enqueue(event) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (pendingBytes + eventBytes + 1 > MAX_COALESCED_BROADCAST_BYTES) flush()
      pending.push(event)
      pendingBytes += eventBytes + (pending.length > 1 ? 1 : 0)
      if (
        isImmediateBroadcastEvent(event) ||
        pending.length >= MAX_COALESCED_BROADCAST_EVENTS ||
        pendingBytes >= MAX_COALESCED_BROADCAST_BYTES
      ) {
        flush()
        return
      }
      schedule()
    },
    flush
  }
}

export {
  EVENT_BROADCAST_INTERVAL_MS,
  MAX_COALESCED_BROADCAST_EVENTS,
  MAX_COALESCED_BROADCAST_BYTES,
  createAcpRuntimeEventBroadcastCoalescer
}
export type { AcpRuntimeEventBroadcastCoalescerOptions }
