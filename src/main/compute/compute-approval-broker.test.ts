import { describe, it, expect } from 'vitest'
import { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeApprovalRequest } from '../../shared/compute'

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

// Minimal approval request payload for tests.
const makeRequest = (
  overrides: Partial<Omit<ComputeApprovalRequest, 'id'>> = {}
): Omit<ComputeApprovalRequest, 'id'> => ({
  provider_id: 'ssh:biowulf',
  provider_name: 'biowulf',
  shape: 'direct_ssh',
  intent: 'Check module availability',
  command_preview: 'module avail',
  command_full: 'module avail 2>&1 | head -50',
  ...overrides
})

describe('ComputeApprovalBroker', () => {
  it('broadcasts request and resolves with once decision', async () => {
    const timer = makeTimer()
    let broadcast: ComputeApprovalRequest | undefined
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: (r) => {
        broadcast = r
      },
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const req = makeRequest()
    const decision = broker.request(req)
    expect(broadcast).toEqual({ id: 'id-1', ...req })

    broker.respond('id-1', 'once')
    await expect(decision).resolves.toBe('once')
  })

  it('resolves with deny when user denies', async () => {
    const timer = makeTimer()
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request(makeRequest())
    broker.respond('id-1', 'deny')
    await expect(decision).resolves.toBe('deny')
  })

  it('auto-denies when the request times out', async () => {
    const timer = makeTimer()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request(makeRequest())
    timer.fire()
    await expect(decision).resolves.toBe('deny')
  })

  it('ignores a response for an unknown or already-settled id', async () => {
    const timer = makeTimer()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    const decision = broker.request(makeRequest())
    broker.respond('id-1', 'deny')
    broker.respond('id-1', 'once') // no-op: already settled
    await expect(decision).resolves.toBe('deny')
    expect(() => broker.respond('nope', 'once')).not.toThrow()
  })
})
