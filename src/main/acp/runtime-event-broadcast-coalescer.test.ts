import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  EVENT_BROADCAST_INTERVAL_MS,
  MAX_COALESCED_BROADCAST_EVENTS,
  createAcpRuntimeEventBroadcastCoalescer
} from './runtime-event-broadcast-coalescer'

const thought = (id: string, text: string): AcpRuntimeEvent => ({
  id,
  timestamp: 1,
  kind: 'thought',
  level: 'info',
  role: 'assistant',
  sessionId: 'session-1',
  text
})

describe('AcpRuntimeEventBroadcastCoalescer', () => {
  it('coalesces streamed assistant thoughts into one IPC batch', () => {
    vi.useFakeTimers()
    try {
      const publish = vi.fn()
      const coalescer = createAcpRuntimeEventBroadcastCoalescer({ publish })

      coalescer.enqueue(thought('thought-1', 'one'))
      coalescer.enqueue(thought('thought-2', 'two'))
      expect(publish).not.toHaveBeenCalled()

      vi.advanceTimersByTime(EVENT_BROADCAST_INTERVAL_MS - 1)
      expect(publish).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(publish).toHaveBeenCalledOnce()
      expect(publish).toHaveBeenCalledWith([
        thought('thought-1', 'one'),
        thought('thought-2', 'two')
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes the pending prefix together with a terminal stop', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const stop: AcpRuntimeEvent = {
      id: 'stop-1',
      timestamp: 2,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1'
    }

    coalescer.enqueue(thought('thought-1', 'one'))
    coalescer.enqueue(stop)

    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0]).toEqual([thought('thought-1', 'one'), stop])
  })

  it('publishes a burst before retained history can evict an unaccepted prefix', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const events = Array.from({ length: MAX_COALESCED_BROADCAST_EVENTS }, (_, index) =>
      thought(`thought-${index + 1}`, String(index))
    )

    for (const event of events) coalescer.enqueue(event)

    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0]).toHaveLength(MAX_COALESCED_BROADCAST_EVENTS)
  })
})
