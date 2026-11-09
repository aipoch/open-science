import { describe, expect, it, vi } from 'vitest'

import { AcpSessionCleanupAdmission } from './session-cleanup-admission'
import { AcpGenerationActivityOwner } from './generation-activity-owner'
import { AcpConnectionTransitionOwner } from './connection-transition-owner'

const harness = (): {
  activity: AcpGenerationActivityOwner
  transitions: AcpConnectionTransitionOwner
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>
  admission: AcpSessionCleanupAdmission
  assertReady: ReturnType<typeof vi.fn>
} => {
  const activity = new AcpGenerationActivityOwner({
    activityChanged: () => transitions.activityChanged(),
    hasActivePrompts: () => false,
    hasActiveReviewerSessions: () => false
  })
  const disconnect = vi.fn(async () => undefined)
  const transitions = new AcpConnectionTransitionOwner({
    blockers: () => activity.blockers(),
    connectionGeneration: () => 1,
    disconnect,
    cleanupConfirmed: () => true,
    onRetired: vi.fn(),
    publishIdle: vi.fn(),
    recoverFailedDeferredDisconnect: vi.fn(),
    reportFailure: vi.fn()
  })
  const assertReady = vi.fn()
  const admission = new AcpSessionCleanupAdmission({
    activeTransition: () => {
      const completion = transitions.inFlight
      return completion ? { kind: 'connection', completion } : undefined
    },
    withActivity: (work) => activity.withActivity(work),
    assertReady,
    diagnosticContext: () => ({ generation: 1 })
  })
  return { activity, transitions, disconnect, admission, assertReady }
}

describe('AcpSessionCleanupAdmission', () => {
  it('bypasses a pending intent while its activity lease protects provider cleanup', async () => {
    const h = harness()
    const prompt = Promise.withResolvers<void>()
    const activePrompt = h.activity.withActivity(() => prompt.promise)
    await h.transitions.requestProviderReconnect()
    expect(h.transitions.barrier).toBeDefined()
    expect(h.transitions.inFlight).toBeUndefined()
    await h.admission.run(async () => {
      prompt.resolve()
      await activePrompt
      expect(h.disconnect).not.toHaveBeenCalled()
    })
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledOnce())
    expect(h.activity.blockers()).toEqual({ reconnect: false, retirement: false })
  })

  it('waits for actual teardown and rechecks before taking a cleanup lease', async () => {
    const h = harness()
    const gate = Promise.withResolvers<void>()
    const teardown = h.transitions.settleTeardown(() => gate.promise)
    const work = vi.fn(async () => {
      expect(h.activity.blockers().reconnect).toBe(true)
    })
    const deleting = h.admission.run(work)
    expect(work).not.toHaveBeenCalled()
    expect(h.activity.blockers().reconnect).toBe(false)
    gate.resolve()
    await Promise.all([teardown, deleting])
    expect(h.assertReady).toHaveBeenCalledOnce()
    expect(work).toHaveBeenCalledOnce()
  })

  it('observes a model application without waiting for its queued admission barrier', async () => {
    const gate = Promise.withResolvers<void>()
    let applying: Promise<void> | undefined = gate.promise
    const work = vi.fn(async () => undefined)
    const admission = new AcpSessionCleanupAdmission({
      activeTransition: () => (applying ? { kind: 'model', completion: applying } : undefined),
      withActivity: (callback) => callback(),
      assertReady: vi.fn(),
      diagnosticContext: () => ({})
    })
    const deleting = admission.run(work)
    expect(work).not.toHaveBeenCalled()
    applying = undefined
    gate.resolve()
    await deleting
    expect(work).toHaveBeenCalledOnce()
  })

  it('times out observation without running a late cleanup, and permits a fresh retry', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const gate = Promise.withResolvers<void>()
      const teardown = h.transitions.settleTeardown(() => gate.promise)
      const work = vi.fn(async () => undefined)
      const deletion = h.admission.run(work)
      const rejected = expect(deletion).rejects.toThrow(
        'timed out waiting for an active lifecycle transition'
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      gate.resolve()
      await teardown
      expect(work).not.toHaveBeenCalled()
      expect(h.activity.blockers().reconnect).toBe(false)
      await h.admission.run(work)
      expect(work).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases protection when cleanup fails without dropping a reconnect intent', async () => {
    const h = harness()
    const failure = new Error('provider close failed')
    await expect(
      h.admission.run(async () => {
        await h.transitions.requestProviderReconnect()
        expect(h.disconnect).not.toHaveBeenCalled()
        throw failure
      })
    ).rejects.toBe(failure)
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledOnce())
    expect(h.activity.blockers()).toEqual({ reconnect: false, retirement: false })
  })
})
