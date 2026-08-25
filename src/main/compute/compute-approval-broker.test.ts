import { describe, it, expect, vi } from 'vitest'
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

// Minimal download approval request payload (no command fields).
const makeDownloadRequest = (
  overrides: Partial<Omit<ComputeApprovalRequest, 'id'>> = {}
): Omit<ComputeApprovalRequest, 'id'> => ({
  provider_id: 'ssh:biowulf',
  provider_name: 'biowulf',
  shape: 'direct_ssh',
  intent: 'Download remote file for analysis',
  remote_path: '/home/user/data/results.csv',
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

  it('reports resolved, rejected, and expired request lifecycles', async () => {
    const timer = makeTimer()
    const onSettled = vi.fn()
    let sequence = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++sequence}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onSettled
    })

    const responded = broker.request(makeRequest())
    broker.respond('id-1', 'once')
    await responded
    const denied = broker.request(makeRequest())
    broker.respond('id-2', 'deny')
    await denied
    const expired = broker.request(makeRequest())
    timer.fire()
    await expired

    expect(onSettled).toHaveBeenNthCalledWith(1, 'id-1', 'resolved')
    expect(onSettled).toHaveBeenNthCalledWith(2, 'id-2', 'rejected')
    expect(onSettled).toHaveBeenNthCalledWith(3, 'id-3', 'expired')
  })

  it('cancels a pending approval when its request is aborted', async () => {
    const timer = makeTimer()
    const onSettled = vi.fn()
    const controller = new AbortController()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onSettled
    })

    const decision = broker.request(makeRequest(), undefined, controller.signal)
    controller.abort()

    expect(broker.getPending('id-1')).toBeNull()
    await expect(decision).resolves.toBe('deny')
    expect(onSettled).toHaveBeenCalledWith('id-1', 'cancelled')
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

  it('pauses a Session timeout while Side chat owns the composer', async () => {
    let now = 0
    const timers: Array<{ fn: () => void; ms: number }> = []
    const clearTimer = vi.fn()
    const broker = new ComputeApprovalBroker({
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

    const decision = broker.request(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command'
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

  it('exposes a pending request until it settles', async () => {
    const timer = makeTimer()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })
    const request = makeRequest()

    const decision = broker.request(request)
    expect(broker.getPending('id-1')).toEqual({ id: 'id-1', ...request })

    broker.respond('id-1', 'deny')
    await decision
    expect(broker.getPending('id-1')).toBeNull()
  })

  it('retains the renderer Session owner when replaying a contextual approval', async () => {
    const timer = makeTimer()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })
    const request = makeRequest()
    const decision = broker.request(request, {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command'
    })

    expect(broker.getPending('id-1')).toEqual({
      id: 'id-1',
      ...request,
      session_id: 'session-1'
    })

    broker.respond('id-1', 'deny')
    await decision
  })

  it('replays pending requests with their renderer Session owner and omits settled requests', async () => {
    const timer = makeTimer()
    const broadcast = vi.fn()
    const replay = vi.fn()
    let sequence = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++sequence}`,
      broadcast,
      replay,
      setTimer: timer.set,
      clearTimer: timer.clear
    })
    const request = makeRequest()
    const decision = broker.request(request, {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command'
    })
    broadcast.mockClear()

    broker.replayPending()

    expect(replay).toHaveBeenCalledWith(
      { id: 'id-1', ...request },
      expect.objectContaining({ sessionId: 'session-1' })
    )
    expect(broadcast).not.toHaveBeenCalled()

    broker.respond('id-1', 'deny')
    await decision
    replay.mockClear()
    broker.replayPending()
    expect(replay).not.toHaveBeenCalled()
  })

  it('cancels only pending approvals owned by a deleted Session', async () => {
    const timer = makeTimer()
    const onSettled = vi.fn()
    let sequence = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++sequence}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onSettled
    })
    const deletedCall = broker.request(makeRequest(), {
      sessionId: 'session-deleted',
      projectId: 'project-1',
      operation: 'call_command'
    })
    const deletedDownload = broker.request(makeDownloadRequest(), {
      sessionId: 'session-deleted',
      projectId: 'project-1',
      operation: 'download'
    })
    const retainedCall = broker.request(makeRequest(), {
      sessionId: 'session-retained',
      projectId: 'project-1',
      operation: 'call_command'
    })

    broker.cancelSession('session-deleted')

    await expect(deletedCall).resolves.toBe('deny')
    await expect(deletedDownload).resolves.toBe('deny')
    expect(broker.getPending('id-1')).toBeNull()
    expect(broker.getPending('id-2')).toBeNull()
    expect(broker.getPending('id-3')).not.toBeNull()
    expect(onSettled).toHaveBeenCalledWith('id-1', 'cancelled')
    expect(onSettled).toHaveBeenCalledWith('id-2', 'cancelled')

    broker.respond('id-3', 'deny')
    await retainedCall
  })

  it('allows new approvals if Session deletion fails after pending requests are cancelled', async () => {
    const timer = makeTimer()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear
    })
    const context = {
      sessionId: 'session-retained',
      projectId: 'project-1',
      operation: 'call_command'
    }

    broker.cancelSession('session-retained')
    broker.completeSessionCancellation('session-retained')
    const retried = broker.request(makeRequest(), context)

    expect(broker.getPending('id-1')).not.toBeNull()
    broker.respond('id-1', 'once')
    await expect(retried).resolves.toBe('once')
  })

  it('denies a pending approval when its compute provider is invalidated', async () => {
    const timer = makeTimer()
    const remember = vi.fn()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      permissionGrants: { resolve: vi.fn(), remember } as never
    })

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-row-1'
    })
    await Promise.resolve()
    broker.invalidateProvider('ssh:biowulf')
    broker.respond('id-1', 'global')

    await expect(decision).resolves.toBe('deny')
    expect(remember).not.toHaveBeenCalled()
  })

  it('does not create a pending approval after invalidation sweeps pending requests', async () => {
    let finishGrantLookup: (() => void) | undefined
    const resolveGrant = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finishGrantLookup = () => resolve(undefined)
        })
    )
    const broadcast = vi.fn()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast,
      permissionGrants: { resolve: resolveGrant, remember: vi.fn() } as never
    })

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-row-1'
    })
    await vi.waitFor(() => expect(resolveGrant).toHaveBeenCalledOnce())

    let invalidationCompleted = false
    const invalidation = broker.invalidateProvider('ssh:biowulf').then(() => {
      invalidationCompleted = true
    })
    await Promise.resolve()
    expect(invalidationCompleted).toBe(false)

    finishGrantLookup?.()
    await invalidation
    await expect(decision).resolves.toBe('deny')
    expect(broadcast).not.toHaveBeenCalled()
    broker.completeProviderInvalidation('ssh:biowulf')
  })

  it('does not allow a remembered grant when the request aborts during lookup', async () => {
    let finishGrantLookup: ((scope: 'project') => void) | undefined
    const resolveGrant = vi.fn(
      () =>
        new Promise<'project'>((resolve) => {
          finishGrantLookup = resolve
        })
    )
    const broadcast = vi.fn()
    const controller = new AbortController()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast,
      permissionGrants: { resolve: resolveGrant, remember: vi.fn() } as never
    })

    const decision = broker.requestWithContext(
      makeRequest(),
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        operation: 'call_command',
        ownerId: 'host-row-1'
      },
      controller.signal
    )
    await vi.waitFor(() => expect(resolveGrant).toHaveBeenCalledOnce())

    controller.abort()
    finishGrantLookup?.('project')

    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does not publish an approval after Session cancellation starts during grant lookup', async () => {
    let finishGrantLookup: (() => void) | undefined
    const resolveGrant = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finishGrantLookup = () => resolve(undefined)
        })
    )
    const broadcast = vi.fn()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast,
      permissionGrants: { resolve: resolveGrant, remember: vi.fn() } as never
    })

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-deleting',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-row-1'
    })
    await vi.waitFor(() => expect(resolveGrant).toHaveBeenCalledOnce())

    broker.cancelSession('session-deleting')
    broker.completeSessionCancellation('session-deleting')
    finishGrantLookup?.()

    await expect(decision).resolves.toBe('deny')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does not remember approval when the provider id belongs to a recreated host', async () => {
    const timer = makeTimer()
    const remember = vi.fn()
    const isProviderCurrent = vi.fn().mockResolvedValue(false)
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      permissionGrants: { resolve: vi.fn(), remember } as never,
      isProviderCurrent
    })

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'deleted-host-row'
    })
    await Promise.resolve()
    broker.respond('id-1', 'project')

    await expect(decision).resolves.toBe('deny')
    expect(isProviderCurrent).toHaveBeenCalledWith({
      providerId: 'ssh:biowulf',
      ownerId: 'deleted-host-row'
    })
    expect(remember).not.toHaveBeenCalled()
  })

  it('drains an approval persistence tail before provider deletion proceeds', async () => {
    const timer = makeTimer()
    let releaseRemember: (() => void) | undefined
    const remember = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRemember = resolve
        })
    )
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      permissionGrants: { resolve: vi.fn(), remember } as never,
      isProviderCurrent: vi.fn().mockResolvedValue(true)
    })

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-row-1'
    })
    await Promise.resolve()
    broker.respond('id-1', 'project')
    await vi.waitFor(() => expect(remember).toHaveBeenCalledOnce())

    let invalidationCompleted = false
    const invalidation = broker.invalidateProvider('ssh:biowulf').then(() => {
      invalidationCompleted = true
    })
    await Promise.resolve()
    expect(invalidationCompleted).toBe(false)

    releaseRemember?.()
    await invalidation
    await expect(decision).resolves.toBe('deny')
    broker.completeProviderInvalidation('ssh:biowulf')
  })

  it('aborts the operation but preserves a broad scope the user approved before cancellation', async () => {
    const timer = makeTimer()
    let releaseRemember: (() => void) | undefined
    const remember = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRemember = resolve
        })
    )
    const controller = new AbortController()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      permissionGrants: { resolve: vi.fn(), remember } as never,
      isProviderCurrent: vi.fn().mockResolvedValue(true)
    })

    const decision = broker.requestWithContext(
      makeRequest(),
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        operation: 'call_command',
        ownerId: 'host-row-1'
      },
      controller.signal
    )
    await Promise.resolve()
    broker.respond('id-1', 'project')
    await vi.waitFor(() => expect(remember).toHaveBeenCalledOnce())

    controller.abort()
    releaseRemember?.()

    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    expect(remember).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      },
      'project'
    )
  })

  it('denies new requests while provider deletion is draining', async () => {
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: vi.fn(),
      permissionGrants: { resolve: vi.fn(), remember: vi.fn() } as never
    })

    await broker.invalidateProvider('ssh:biowulf')
    await expect(
      broker.requestWithContext(makeRequest(), {
        sessionId: 'session-1',
        projectId: 'project-1',
        operation: 'call_command',
        ownerId: 'host-row-1'
      })
    ).resolves.toBe('deny')
    broker.completeProviderInvalidation('ssh:biowulf')
  })

  it('denies a stale Once request that reaches the broker after provider deletion completes', async () => {
    const broadcast = vi.fn()
    const remember = vi.fn()
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast,
      permissionGrants: { resolve: vi.fn(), remember } as never,
      isProviderCurrent: vi.fn().mockResolvedValue(false)
    })

    await broker.invalidateProvider('ssh:biowulf')
    broker.completeProviderInvalidation('ssh:biowulf')

    const decision = broker.requestWithContext(makeRequest(), {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'deleted-host-row'
    })
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce())
    broker.respond('id-1', 'once')

    await expect(decision).resolves.toBe('deny')
    expect(remember).not.toHaveBeenCalled()
  })

  it('does not auto-allow an existing grant for a replacement host with the same provider id', async () => {
    const broadcast = vi.fn()
    const isProviderCurrent = vi.fn().mockResolvedValue(false)
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast,
      permissionGrants: {
        resolve: vi.fn().mockResolvedValue('project'),
        remember: vi.fn()
      } as never,
      isProviderCurrent
    })

    await expect(
      broker.requestWithContext(makeRequest(), {
        sessionId: 'session-1',
        projectId: 'project-1',
        operation: 'call_command',
        ownerId: 'replacement-host-row'
      })
    ).resolves.toBe('deny')
    expect(isProviderCurrent).toHaveBeenCalledWith({
      providerId: 'ssh:biowulf',
      ownerId: 'replacement-host-row'
    })
    expect(broadcast).not.toHaveBeenCalled()
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

  it('forwards approval context only when a card is actually broadcast', async () => {
    const timer = makeTimer()
    const broadcasts: unknown[] = []
    const broker = new ComputeApprovalBroker({
      generateId: () => 'id-1',
      broadcast: (request, context) => broadcasts.push({ request, context }),
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })
    const context = {
      sessionId: 'session-A',
      projectId: 'project-1',
      operation: 'call_command'
    }
    const request = makeRequest()

    const decision = broker.requestWithContext(request, context)
    await Promise.resolve()

    expect(broadcasts).toEqual([{ request: { id: 'id-1', ...request }, context }])
    broker.respond('id-1', 'once')
    await decision
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

// ── Download operation scope tests ───────────────────────────────────────────────────────────────
describe('ComputeApprovalBroker — download operation', () => {
  it('broadcasts a download approval request with remote_path', async () => {
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

    const req = makeDownloadRequest()
    const decision = broker.request(req)
    expect(broadcast).toMatchObject({
      id: 'id-1',
      provider_id: 'ssh:biowulf',
      remote_path: '/home/user/data/results.csv'
    })
    broker.respond('id-1', 'once')
    await expect(decision).resolves.toBe('once')
  })

  it('conversation grant for (download, provider) skips card on repeat', async () => {
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

    const req = makeDownloadRequest({ provider_id: 'ssh:biowulf' })
    const ctx = { sessionId: 'session-dl', projectId: 'proj-1', operation: 'download' }

    const firstPromise = broker.requestWithContext(req, ctx)
    await Promise.resolve()
    broker.respond('id-1', 'conversation')
    await expect(firstPromise).resolves.toBe('conversation')
    expect(broadcastCount).toBe(1)

    // Second download request: conversation grant for (download, ssh:biowulf) → no card.
    const second = await broker.requestWithContext(req, ctx)
    expect(second).toBe('conversation')
    expect(broadcastCount).toBe(1)
  })

  it('download and call_command grants are isolated by operation', async () => {
    const timer = makeTimer()
    let n = 0
    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })

    // Grant conversation scope for call_command.
    const cmdReq = makeRequest({ provider_id: 'ssh:biowulf' })
    const cmdCtx = { sessionId: 'sess', projectId: 'p', operation: 'call_command' }
    const p1 = broker.requestWithContext(cmdReq, cmdCtx)
    await Promise.resolve()
    broker.respond('id-1', 'conversation')
    await p1

    // download for same provider must still show card (different operation key).
    let broadcastCount = 0
    const broker2 = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(false)
    })
    const dlReq = makeDownloadRequest({ provider_id: 'ssh:biowulf' })
    const dlCtx = { sessionId: 'sess', projectId: 'p', operation: 'download' }
    const p2 = broker2.requestWithContext(dlReq, dlCtx)
    await Promise.resolve()
    broker2.respond('id-2', 'once')
    await p2
    expect(broadcastCount).toBe(1)
  })

  it('project grant for download persists to settings JSON and skips card', async () => {
    const timer = makeTimer()
    let n = 0
    let savedGrant: { projectId: string; operation: string; providerId: string } | undefined

    const broker = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => undefined,
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: (g) =>
        Promise.resolve(
          savedGrant?.projectId === g.projectId &&
            savedGrant?.operation === g.operation &&
            savedGrant?.providerId === g.providerId
        ),
      saveProjectGrant: (g) => {
        savedGrant = g
        return Promise.resolve()
      }
    })

    const req = makeDownloadRequest({ provider_id: 'ssh:biowulf' })
    const ctx = { sessionId: 'sess', projectId: 'proj-dl', operation: 'download' }

    // First request: user picks project scope.
    const p1 = broker.requestWithContext(req, ctx)
    await Promise.resolve()
    broker.respond('id-1', 'project')
    const d1 = await p1
    expect(d1).toBe('project')
    expect(savedGrant).toEqual({
      projectId: 'proj-dl',
      operation: 'download',
      providerId: 'ssh:biowulf'
    })

    // Second request: project grant exists → resolves immediately without broadcast.
    let broadcastCount = 0
    const broker2 = new ComputeApprovalBroker({
      generateId: () => `id-${++n}`,
      broadcast: () => {
        broadcastCount++
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
      checkProjectGrant: () => Promise.resolve(true)
    })
    const d2 = await broker2.requestWithContext(req, ctx)
    expect(d2).toBe('project')
    expect(broadcastCount).toBe(0)
  })
})
