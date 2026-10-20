import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  EVENT_BROADCAST_INTERVAL_MS,
  MAX_COALESCED_BROADCAST_BYTES,
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

const inProgressTool = (id: string, toolCallId: string): AcpRuntimeEvent => ({
  id,
  timestamp: 1,
  kind: 'tool',
  level: 'info',
  sessionId: 'session-1',
  toolCallId,
  status: 'in_progress',
  title: 'Read'
})

describe('AcpRuntimeEventBroadcastCoalescer', () => {
  it('splits encoded UTF-8 bytes, including escaping and raw payloads, without losing order', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const events = Array.from({ length: 16 }, (_, index) => ({
      ...thought(`thought-${index}`, '\u0000界'.repeat(64 * 1024)),
      raw: { text: '\u0000界'.repeat(64 * 1024) }
    }))

    for (const event of events) coalescer.enqueue(event)
    coalescer.flush()

    const batches = publish.mock.calls.map(([batch]) => batch)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(events)
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
        MAX_COALESCED_BROADCAST_BYTES
      )
    }
  })

  it('flushes a full byte prefix before a priority event and cancels obsolete timers', () => {
    vi.useFakeTimers()
    try {
      const publish = vi.fn()
      const coalescer = createAcpRuntimeEventBroadcastCoalescer({ publish })
      const prefix = thought('prefix', 'x'.repeat(MAX_COALESCED_BROADCAST_BYTES - 1024))
      const permission: AcpRuntimeEvent = {
        id: 'permission',
        timestamp: 1,
        kind: 'permission',
        level: 'warning',
        sessionId: 'session-1',
        permissionRequestId: 'request-1',
        text: 'x'.repeat(2048)
      }
      coalescer.enqueue(prefix)
      coalescer.enqueue(permission)
      expect(publish.mock.calls.map(([batch]) => batch)).toEqual([[prefix], [permission]])
      vi.advanceTimersByTime(EVENT_BROADCAST_INTERVAL_MS)
      expect(publish).toHaveBeenCalledTimes(2)

      coalescer.enqueue(thought('next', 'small'))
      expect(publish).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(EVENT_BROADCAST_INTERVAL_MS)
      expect(publish).toHaveBeenLastCalledWith([thought('next', 'small')])
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes a single event over the batch budget intact and separately', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const prefix = thought('prefix', 'small')
    const large = thought('large', 'x'.repeat(MAX_COALESCED_BROADCAST_BYTES))
    const suffix = thought('suffix', 'small')
    coalescer.enqueue(prefix)
    coalescer.enqueue(large)
    coalescer.enqueue(suffix)
    coalescer.flush()
    expect(publish.mock.calls.map(([batch]) => batch)).toEqual([[prefix], [large], [suffix]])
  })

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

  it('does not publish one renderer IPC per in-progress tool start during a burst', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const events = Array.from({ length: 1_200 }, (_, index) =>
      inProgressTool(`tool-${index + 1}`, `call-${index + 1}`)
    )

    for (const event of events) coalescer.enqueue(event)

    const publishedBatches = publish.mock.calls.map(([batch]) => batch)
    const publishedCount = publishedBatches.reduce((count, batch) => count + batch.length, 0)

    expect(publish).toHaveBeenCalledTimes(
      Math.floor(events.length / MAX_COALESCED_BROADCAST_EVENTS)
    )
    expect(publishedCount).toBe(
      MAX_COALESCED_BROADCAST_EVENTS * Math.floor(events.length / MAX_COALESCED_BROADCAST_EVENTS)
    )
    expect(publishedBatches.flat().map((event) => event.id)).toEqual(
      events.slice(0, publishedCount).map((event) => event.id)
    )
  })

  it('keeps a mixed thought and new-tool burst on the presentation cadence until the batch cap', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const events = Array.from({ length: 1_200 }, (_, index) =>
      index % 2 === 0
        ? thought(`thought-${index + 1}`, 'x')
        : inProgressTool(`tool-${index + 1}`, `call-${index + 1}`)
    )

    for (const event of events) coalescer.enqueue(event)

    expect(publish).toHaveBeenCalledTimes(
      Math.floor(events.length / MAX_COALESCED_BROADCAST_EVENTS)
    )
    expect(
      publish.mock.calls.every(([batch]) => batch.length === MAX_COALESCED_BROADCAST_EVENTS)
    ).toBe(true)
  })

  it('holds an in-progress tool start until the 33 ms presentation cadence', () => {
    vi.useFakeTimers()
    try {
      const publish = vi.fn()
      const coalescer = createAcpRuntimeEventBroadcastCoalescer({ publish })
      const tool = inProgressTool('tool-1', 'call-1')

      coalescer.enqueue(tool)
      vi.advanceTimersByTime(EVENT_BROADCAST_INTERVAL_MS - 1)
      expect(publish).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(publish).toHaveBeenCalledOnce()
      expect(publish).toHaveBeenCalledWith([tool])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes the pending prefix together with a permission request', () => {
    const publish = vi.fn()
    const coalescer = createAcpRuntimeEventBroadcastCoalescer({
      publish,
      schedule: () => () => undefined
    })
    const permission: AcpRuntimeEvent = {
      id: 'permission-1',
      timestamp: 2,
      kind: 'permission',
      level: 'warning',
      sessionId: 'session-1',
      permissionRequestId: 'permission-1',
      title: 'Permission requested'
    }
    const tool = inProgressTool('tool-1', 'call-1')

    coalescer.enqueue(tool)
    coalescer.enqueue(permission)

    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0]).toEqual([tool, permission])
  })
})
