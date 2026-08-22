import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { AcpAgentRuntimeUpdate, AcpRuntimeEvent } from '../shared/acp'
import { AGENT_RUNTIME_UPDATE_FIXTURE } from '../../test/fixtures/renderer-contract-certification'
import type { SideChatRuntimeEvent } from '../shared/side-chat'
import {
  ApplicationEventHub,
  type ApplicationEvent,
  type ApplicationEventMap
} from './application-events'

describe('ApplicationEventHub', () => {
  it('binds known channels to their payload types', () => {
    expectTypeOf<ApplicationEventMap['acp:event']>().toEqualTypeOf<readonly AcpRuntimeEvent[]>()
    expectTypeOf<
      ApplicationEventMap['acp:agent-runtime-update']
    >().toEqualTypeOf<AcpAgentRuntimeUpdate>()
    expectTypeOf<AcpAgentRuntimeUpdate['event']['sessionId']>().toEqualTypeOf<undefined>()
    expectTypeOf<AcpAgentRuntimeUpdate['event']['promptMessageId']>().toEqualTypeOf<undefined>()
    expectTypeOf<ApplicationEventMap['side-chat:event']>().toEqualTypeOf<SideChatRuntimeEvent>()
    expectTypeOf<ApplicationEvent<'specialist:catalog-changed'>>().toEqualTypeOf<
      Readonly<{ channel: 'specialist:catalog-changed'; payload: undefined }>
    >()
  })

  it('publishes an Agent Runtime Segment update without changing its scoped owner', () => {
    const hub = new ApplicationEventHub()
    const listener = vi.fn()
    hub.subscribe(listener)

    hub.publish('acp:agent-runtime-update', AGENT_RUNTIME_UPDATE_FIXTURE)

    expect(listener).toHaveBeenCalledWith({
      channel: 'acp:agent-runtime-update',
      payload: AGENT_RUNTIME_UPDATE_FIXTURE
    })
  })

  it('publishes one immutable event to subscribers in registration order', () => {
    const hub = new ApplicationEventHub()
    const deliveries: string[] = []
    const first = vi.fn((event: ApplicationEvent) => {
      deliveries.push(`first:${event.channel}`)
      expect(Object.isFrozen(event)).toBe(true)
    })
    const second = vi.fn((event: ApplicationEvent) => deliveries.push(`second:${event.channel}`))
    hub.subscribe(first)
    hub.subscribe(second)

    const event: AcpRuntimeEvent = {
      id: 'event-1',
      timestamp: 10,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1'
    }
    hub.publish('acp:event', [event])

    expect(deliveries).toEqual(['first:acp:event', 'second:acp:event'])
    expect(first).toHaveBeenCalledWith({ channel: 'acp:event', payload: [event] })
    expect(second).toHaveBeenCalledWith({ channel: 'acp:event', payload: [event] })
  })

  it('preserves live Set cancellation and failure propagation semantics', () => {
    const hub = new ApplicationEventHub()
    const skipped = vi.fn()
    const removeSkipped = hub.subscribe(skipped)
    const failure = new Error('listener failed')
    const afterFailure = vi.fn()
    hub.subscribe(() => {
      removeSkipped()
      throw failure
    })
    hub.subscribe(afterFailure)

    // Move the cancelling listener before the listener it removes while keeping the test explicit.
    removeSkipped()
    hub.subscribe(skipped)

    expect(() => hub.publish('specialist:catalog-changed', undefined)).toThrow(failure)
    expect(skipped).not.toHaveBeenCalled()
    expect(afterFailure).not.toHaveBeenCalled()
  })

  it('clears subscriptions and ignores late work after disposal', () => {
    const hub = new ApplicationEventHub()
    const listener = vi.fn()
    const unsubscribe = hub.subscribe(listener)

    hub.dispose()
    hub.dispose()
    unsubscribe()
    hub.publish('specialist:catalog-changed', undefined)
    hub.subscribe(listener)
    hub.publish('specialist:catalog-changed', undefined)

    expect(listener).not.toHaveBeenCalled()
  })
})
