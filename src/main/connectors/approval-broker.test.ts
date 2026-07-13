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
      argsPreview: '{}'
    })

    broker.respond('id-1', 'allow')
    await expect(decision).resolves.toBe('allow')
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
    broker.respond('id-1', 'allow') // no-op: already settled
    await expect(decision).resolves.toBe('deny')
    expect(() => broker.respond('nope', 'allow')).not.toThrow()
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
    broker.respond('id-2', 'allow')
    broker.respond('id-1', 'deny')
    await expect(a).resolves.toBe('deny')
    await expect(b).resolves.toBe('allow')
    expect(vi.isMockFunction(broker.request)).toBe(false)
  })
})
