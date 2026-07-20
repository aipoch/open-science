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

  // ── conversation scope ────────────────────────────────────────────────────────────
  it('records a conversation grant and skips the card on a matching second request', async () => {
    const timer = makeTimer()
    let broadcastCount = 0
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })

    const req = makeRequest({ provider_id: 'ssh:biowulf' })
    const ctx = { sessionId: 'session-A', projectId: 'proj-1', operation: 'call_command' }

    // First request: user approves with 'conversation' scope.
    const firstPromise = broker.requestWithContext(req, ctx)
    // requestWithContext calls checkProjectGrant (async), then request(). We must wait for the
    // broadcast before responding. Use setImmediate to let the microtask queue drain.
    await Promise.resolve()
    broker.respond('id-1', 'conversation')
    const first = await firstPromise
    expect(first).toBe('conversation')
    expect(broadcastCount).toBe(1)

    // Second request: same (operation, provider_id) → conversation grant hits, no broadcast.
    const second = await broker.requestWithContext(req, ctx)
    expect(second).toBe('conversation')
    expect(broadcastCount).toBe(1) // still only 1 broadcast
  })

  it('does NOT persist conversation grants across broker instances (session boundary)', async () => {
    // A new ComputeApprovalBroker has no in-memory grants → must show card again.
    const timer = makeTimer()
    let broadcastCount = 0
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear
    })

    // No prior grants on a fresh broker → request goes to card.
    const decision = broker.requestWithContext(makeRequest({ provider_id: 'ssh:biowulf' }), {
      sessionId: 'session-B',
      projectId: 'proj-1',
      operation: 'call_command'
    })
    broker.respond('id-1', 'once')
    await expect(decision).resolves.toBe('once')
    expect(broadcastCount).toBe(1)
  })

  it('once scope does not record a grant', async () => {
    const timer = makeTimer()
    let broadcastCount = 0
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })

    const req = makeRequest({ provider_id: 'ssh:biowulf' })
    const ctx = { sessionId: 'session-C', projectId: 'proj-1', operation: 'call_command' }

    const firstPromise = broker.requestWithContext(req, ctx)
    await Promise.resolve()
    broker.respond('id-1', 'once')
    const first = await firstPromise
    expect(first).toBe('once')

    // Second request: once does not persist → card shown again.
    const secondPromise = broker.requestWithContext(req, ctx)
    await Promise.resolve()
    broker.respond('id-2', 'once')
    const second = await secondPromise
    expect(second).toBe('once')
    expect(broadcastCount).toBe(2)
  })

  it('project grant check resolves without broadcast when callback returns true', async () => {
    const timer = makeTimer()
    let broadcastCount = 0
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      // Simulates a persisted project grant that matches.
      checkProjectGrant: () => Promise.resolve(true)
    })

    const req = makeRequest({ provider_id: 'ssh:biowulf' })
    const decision = broker.requestWithContext(req, {
      sessionId: 'session-D',
      projectId: 'proj-1',
      operation: 'call_command'
    })
    await expect(decision).resolves.toBe('project')
    expect(broadcastCount).toBe(0)
  })

  it('project grant check does not skip when callback returns false', async () => {
    const timer = makeTimer()
    let broadcastCount = 0
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })

    const req = makeRequest({ provider_id: 'ssh:biowulf' })
    const decisionPromise = broker.requestWithContext(req, {
      sessionId: 'session-E',
      projectId: 'proj-2',
      operation: 'call_command'
    })
    // Let the async checkProjectGrant microtask complete before responding.
    await Promise.resolve()
    broker.respond('id-1', 'once')
    const decision = await decisionPromise
    expect(decision).toBe('once')
    expect(broadcastCount).toBe(1)
  })

  it('records a project grant callback when user chooses project scope', async () => {
    const timer = makeTimer()
    let n = 0
    let savedGrant: { projectId: string; operation: string; providerId: string } | undefined

    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false),
      saveProjectGrant: (g) => {
        savedGrant = g
        return Promise.resolve()
      }
    })

    const req = makeRequest({ provider_id: 'ssh:biowulf' })
    const decisionPromise = broker.requestWithContext(req, {
      sessionId: 'session-F',
      projectId: 'proj-x',
      operation: 'call_command'
    })
    // Let checkProjectGrant resolve before responding.
    await Promise.resolve()
    broker.respond('id-1', 'project')
    const decision = await decisionPromise
    expect(decision).toBe('project')
    expect(savedGrant).toEqual({
      projectId: 'proj-x',
      operation: 'call_command',
      providerId: 'ssh:biowulf'
    })
  })
})
