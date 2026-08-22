import { MAX_ACP_RUNTIME_EVENTS, type AcpRuntimeEvent } from '../../shared/acp'

const EVENT_BROADCAST_INTERVAL_MS = 33
// A fast provider can emit more than one retained window before the 33 ms timer runs. Publish
// midway through that window so every prefix chunk reaches subscribers before bounded history can
// evict it, while ordinary streams still receive the same frame-level coalescing.
const MAX_COALESCED_BROADCAST_EVENTS = Math.floor(MAX_ACP_RUNTIME_EVENTS / 2)

type AcpRuntimeEventBroadcastCoalescerOptions = Readonly<{
  publish: (events: readonly AcpRuntimeEvent[]) => void
  schedule?: (flush: () => void) => () => void
}>

const scheduleBroadcast = (flush: () => void): (() => void) => {
  const timer = setTimeout(flush, EVENT_BROADCAST_INTERVAL_MS)
  return () => clearTimeout(timer)
}

const isCoalescibleAssistantStreamEvent = (event: AcpRuntimeEvent): boolean =>
  (event.kind === 'message' || event.kind === 'thought') &&
  event.role === 'assistant' &&
  typeof event.text === 'string' &&
  event.text.length > 0 &&
  !event.image

// Owns one IPC batch for incremental renderer events. Stop, error, permission, and tool
// start/end flush immediately so the UI is not delayed; streamed text and in-progress tool
// content share the 33 ms presentation cadence.
const createAcpRuntimeEventBroadcastCoalescer = (
  options: AcpRuntimeEventBroadcastCoalescerOptions
): {
  enqueue: (event: AcpRuntimeEvent) => void
  flush: () => void
} => {
  const pending: AcpRuntimeEvent[] = []
  const activeToolCallIdsBySession = new Map<string | undefined, Set<string>>()
  let cancelScheduled: (() => void) | undefined

  const isCoalescible = (event: AcpRuntimeEvent): boolean => {
    if (isCoalescibleAssistantStreamEvent(event)) return true
    if (event.kind === 'stop' || event.kind === 'error') {
      activeToolCallIdsBySession.delete(event.sessionId)
      return false
    }
    if (event.kind !== 'tool' || !event.toolCallId) return false

    const activeToolCallIds = activeToolCallIdsBySession.get(event.sessionId)
    const wasActive = activeToolCallIds?.has(event.toolCallId) === true
    if (event.status === 'completed' || event.status === 'failed') {
      activeToolCallIds?.delete(event.toolCallId)
      if (activeToolCallIds?.size === 0) {
        activeToolCallIdsBySession.delete(event.sessionId)
      }
      return false
    }
    if (activeToolCallIds) {
      activeToolCallIds.add(event.toolCallId)
    } else {
      activeToolCallIdsBySession.set(event.sessionId, new Set([event.toolCallId]))
    }

    return (
      wasActive &&
      (event.toolContent !== undefined ||
        event.terminalOutput !== undefined ||
        event.rawOutput !== undefined)
    )
  }

  const flush = (): void => {
    cancelScheduled?.()
    cancelScheduled = undefined
    if (pending.length === 0) return
    const events = pending.splice(0, pending.length)
    options.publish(events)
  }

  const schedule = (): void => {
    if (cancelScheduled) return
    const scheduleFlush = options.schedule ?? scheduleBroadcast
    cancelScheduled = scheduleFlush(flush)
  }

  return {
    enqueue(event) {
      pending.push(event)
      if (!isCoalescible(event) || pending.length >= MAX_COALESCED_BROADCAST_EVENTS) {
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
  createAcpRuntimeEventBroadcastCoalescer
}
export type { AcpRuntimeEventBroadcastCoalescerOptions }
