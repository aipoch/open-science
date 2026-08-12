import { describe, it, expect, vi } from 'vitest'
import { ApprovalBroker } from './approval-broker'
import type { ConnectorApprovalRequest } from '../../shared/settings'

// A synchronous fake timer so timeout behavior is deterministic without real time passing.
const makeTimer = (): {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  fire: () => void
  clear: (h: ReturnType<typeof setTimeout>) => void
} => {
  let pending: (() => void) | undefined
  return {
    set: (fn) => {
      pending = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    fire: () => pending?.(),
    clear: () => {
      pending = undefined
    }
  }
}

describe('ApprovalBroker', () => {
  it('broadcasts a request and resolves with the renderer decision', async () => {
    const timer = makeTimer()
    let broadcast: ConnectorApprovalRequest | undefined
    let n = 0
    const broker = new ApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: (r) => {
        broadcast = r
      },
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request({ connector: 'biomart', method: 'get_data', argsPreview: '{}' })
    expect(broadcast).toEqual({
      id: 'id-1',
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{}',
      availableScopes: ['once']
    })

    broker.respond('id-1', 'once')
    await expect(decision).resolves.toBe('once')
  })

  it('auto-denies when the request times out', async () => {
    const timer = makeTimer()
    const broker = new ApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request({ connector: 'biomart', method: 'get_data', argsPreview: '{}' })
    timer.fire()
    await expect(decision).resolves.toBe('deny')
  })

  it('pauses a Session timeout while Side chat owns the composer', async () => {
    let now = 0
    const timers: Array<{ fn: () => void; ms: number }> = []
    const clearTimer = vi.fn()
    const broker = new ApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      timeoutMs: 1_000,
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer
    })

    const decision = broker.request({
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{}',
      sessionId: 'session-1'
    })
    now = 250
    broker.pauseSession('session-1')
    now = 5_000
    broker.resumeSession('session-1')

    expect(clearTimer).toHaveBeenCalledWith(1)
    expect(timers.map(({ ms }) => ms)).toEqual([1_000, 750])
    timers[1]?.fn()
    await expect(decision).resolves.toBe('deny')
  })

  it('ignores a response for an unknown or already-settled id', async () => {
    const timer = makeTimer()
    const broker = new ApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request({ connector: 'biomart', method: 'get_data', argsPreview: '{}' })
    broker.respond('id-1', 'deny')
    broker.respond('id-1', 'once') // no-op: already settled
    await expect(decision).resolves.toBe('deny')
    expect(() => broker.respond('nope', 'once')).not.toThrow()
  })

  it('exposes a pending request until it settles', async () => {
    const timer = makeTimer()
    const broker = new ApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request({ connector: 'biomart', method: 'get_data', argsPreview: '{}' })
    expect(broker.getPending('id-1')).toEqual({
      id: 'id-1',
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{}',
      availableScopes: ['once']
    })

    broker.respond('id-1', 'deny')
    await decision
    expect(broker.getPending('id-1')).toBeNull()
  })

  it('runs concurrent requests independently', async () => {
    const timers: Array<() => void> = []
    let n = 0
    const broker = new ApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => undefined,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined
    })

    const a = broker.request({ connector: 'x', method: 'm', argsPreview: '{}' })
    const b = broker.request({ connector: 'y', method: 'm', argsPreview: '{}' })
    broker.respond('id-2', 'once')
    broker.respond('id-1', 'deny')
    await expect(a).resolves.toBe('deny')
    await expect(b).resolves.toBe('once')
    expect(vi.isMockFunction(broker.request)).toBe(false)
  })

  it('preserves sessionId from ApprovalInfo into the broadcast', async () => {
    const timer = makeTimer()
    let broadcast: ConnectorApprovalRequest | undefined
    const broker = new ApprovalBroker({
      generateId: () => 'id-1',
      broadcast: (r) => {
        broadcast = r
      },
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request({
      connector: 'pubchem',
      method: 'search_compound',
      argsPreview: '{}',
      sessionId: 'session-42',
      availableScopes: ['once', 'session', 'project', 'global']
    })

    expect(broadcast).toEqual({
      id: 'id-1',
      connector: 'pubchem',
      method: 'search_compound',
      argsPreview: '{}',
      sessionId: 'session-42',
      availableScopes: ['once', 'session', 'project', 'global']
    })

    broker.respond('id-1', 'global')
    await expect(decision).resolves.toBe('global')
  })

  it('reports allowed, denied, and timeout settlement states to durable notification adapters', async () => {
    const timer = makeTimer()
    const onSettled = vi.fn()
    let sequence = 0
    const broker = new ApprovalBroker({
      generateId: () => `id-${++sequence}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onSettled
    })

    const responded = broker.request({ connector: 'x', method: 'one', argsPreview: '{}' })
    broker.respond('id-1', 'once')
    await responded
    const denied = broker.request({ connector: 'x', method: 'two', argsPreview: '{}' })
    broker.respond('id-2', 'deny')
    await denied
    const expired = broker.request({ connector: 'x', method: 'three', argsPreview: '{}' })
    timer.fire()
    await expired

    expect(onSettled).toHaveBeenNthCalledWith(1, 'id-1', 'resolved')
    expect(onSettled).toHaveBeenNthCalledWith(2, 'id-2', 'rejected')
    expect(onSettled).toHaveBeenNthCalledWith(3, 'id-3', 'expired')
  })
})
