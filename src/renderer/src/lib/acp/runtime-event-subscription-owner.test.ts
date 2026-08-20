import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeEventSubscriptionOwner } from './runtime-event-subscription-owner'

const runtimeEvent = (index: number): AcpRuntimeEvent => ({
  id: `runtime-1:acp-event-${index}`,
  timestamp: index,
  kind: 'message',
  level: 'info',
  role: 'assistant',
  sessionId: 'session-1',
  text: String(index)
})

describe('runtime event subscription owner', () => {
  it('delivers a synchronous pre-subscription burst before bounding retained history', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    const events = Array.from({ length: 600 }, (_, index) => runtimeEvent(index + 1))
    for (const event of events) owner.observeEvent(event)

    const delivered: AcpRuntimeEvent[] = []
    owner.subscribe((batch) => delivered.push(...batch))
    owner.observeInitialSnapshot(events.slice(100))

    expect(delivered.map((event) => event.id)).toEqual(events.map((event) => event.id))
    expect(owner.currentEvents()).toHaveLength(500)
    expect(owner.currentEvents()[0]?.id).toBe('runtime-1:acp-event-101')
  })

  it('reconciles an initial snapshot with events that arrived while the pull was pending', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    const listener = vi.fn<(events: readonly AcpRuntimeEvent[]) => void>()
    const first = runtimeEvent(1)
    const second = runtimeEvent(2)
    owner.subscribe(listener)

    owner.observeEvent(second)
    owner.observeInitialSnapshot([first, second])

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toEqual([first, second])
  })

  it('keeps snapshot-only events that follow the first pending overlap', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    const delivered: AcpRuntimeEvent[] = []
    const first = runtimeEvent(1)
    const second = runtimeEvent(2)
    const third = runtimeEvent(3)
    owner.subscribe((events) => delivered.push(...events))

    owner.observeEvent(second)
    owner.observeInitialSnapshot([first, second, third])

    expect(delivered).toEqual([first, second, third])
  })

  it('deduplicates delayed snapshots without suppressing newer incremental events', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    const delivered: AcpRuntimeEvent[] = []
    owner.subscribe((batch) => delivered.push(...batch))
    owner.observeInitialSnapshot([])

    const events = Array.from({ length: 600 }, (_, index) => runtimeEvent(index + 1))
    for (const event of events) owner.observeEvent(event)
    owner.observeSnapshot(events.slice(0, 500))
    owner.observeEvent(runtimeEvent(601))
    owner.observeSnapshot(events.slice(100))

    expect(delivered.map((event) => event.id)).toEqual([
      ...events.map((event) => event.id),
      'runtime-1:acp-event-601'
    ])
  })

  it('unsubscribes listeners and replays only the retained window on remount', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    owner.observeInitialSnapshot([])
    const firstListener = vi.fn()
    const remove = owner.subscribe(firstListener)
    for (let index = 1; index <= 600; index += 1) owner.observeEvent(runtimeEvent(index))

    remove()
    owner.observeEvent(runtimeEvent(601))
    const replayed: AcpRuntimeEvent[] = []
    owner.subscribe((batch) => replayed.push(...batch))

    expect(firstListener).toHaveBeenCalledTimes(600)
    expect(replayed).toHaveLength(500)
    expect(replayed[0]?.id).toBe('runtime-1:acp-event-102')
    expect(replayed.at(-1)?.id).toBe('runtime-1:acp-event-601')
  })

  it('bounds rolling snapshot history without an incremental subscriber', () => {
    const owner = createRuntimeEventSubscriptionOwner()
    const events = Array.from({ length: 600 }, (_, index) => runtimeEvent(index + 1))

    owner.observeInitialSnapshot(events.slice(0, 500))
    owner.observeSnapshot(events.slice(100))

    expect(owner.currentEvents()).toHaveLength(500)
    expect(owner.currentEvents()[0]?.id).toBe('runtime-1:acp-event-101')
    expect(owner.currentEvents().at(-1)?.id).toBe('runtime-1:acp-event-600')
  })
})
