import { describe, expect, it, vi } from 'vitest'

import { AcpConnectionTransitionOwner } from './connection-transition-owner'

describe('AcpConnectionTransitionOwner', () => {
  it.each([false, true])(
    'holds a Skill-only reload barrier until teardown settles; failure=%s',
    async (fail) => {
      let blocked = true
      let finish!: () => void
      const teardown = new Promise<void>((resolve) => {
        finish = resolve
      })
      const owner = new AcpConnectionTransitionOwner({
        blockers: () => ({ reconnect: blocked, retirement: blocked }),
        connectionGeneration: () => 1,
        disconnect: async () => {
          await teardown
          if (fail) throw new Error('teardown failed')
        },
        onRetired: vi.fn(),
        publishIdle: vi.fn(),
        recoverFailedDeferredDisconnect: vi.fn(),
        reportFailure: vi.fn()
      })
      owner.requestSkillsReload()
      expect(owner.barrier).toBeUndefined()
      blocked = false
      owner.activityChanged()
      const barrier = owner.barrier
      expect(barrier).toBeDefined()
      let released = false
      void barrier!.then(() => {
        released = true
      })
      await Promise.resolve()
      expect(released).toBe(false)
      finish()
      await barrier
      expect(owner.barrier).toBeUndefined()
    }
  )

  it('coalesces blocked provider and skills intents into one planned reconnect', async () => {
    let reconnectBlocked = true
    const disconnect = vi.fn(async () => undefined)
    const publishIdle = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: reconnectBlocked, retirement: reconnectBlocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired: vi.fn(),
      publishIdle,
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    owner.requestSkillsReload()

    expect(owner.barrier).toBeDefined()
    expect(disconnect).not.toHaveBeenCalled()

    reconnectBlocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined())

    expect(disconnect).toHaveBeenCalledOnce()
    expect(publishIdle).toHaveBeenCalledOnce()
    expect(owner.providerReconnectPending).toBe(false)
  })

  it('lets retirement win over queued reconnect intents and retires once', async () => {
    let blocked = true
    const disconnect = vi.fn(async () => undefined)
    const onRetired = vi.fn()
    const publishIdle = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired,
      publishIdle,
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    owner.requestSkillsReload()
    await owner.requestRetirement()
    await owner.requestRetirement()
    expect(disconnect).not.toHaveBeenCalled()

    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())

    expect(disconnect).toHaveBeenCalledOnce()
    expect(publishIdle).not.toHaveBeenCalled()
    expect(owner.barrier).toBeUndefined()
    await owner.requestRetirement()
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not let stale teardown release a newer reconnect barrier', async () => {
    let blocked = true
    let releaseTeardown!: () => void
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })
    const disconnect = vi.fn(async () => undefined)
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired: vi.fn(),
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    const staleTeardown = owner.settleTeardown(() => teardownGate)
    await owner.requestProviderReconnect()

    releaseTeardown()
    await staleTeardown
    expect(owner.barrier).toBeDefined()

    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined())
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('recovers a failed deferred disconnect and always releases its barrier', async () => {
    let blocked = true
    let connectionGeneration = 1
    const disconnectFailure = new Error('disconnect failed')
    const recoverFailedDeferredDisconnect = vi.fn(async () => undefined)
    const reportFailure = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => connectionGeneration,
      disconnect: vi.fn(async () => {
        connectionGeneration += 1
        throw disconnectFailure
      }),
      onRetired: vi.fn(),
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect,
      reportFailure
    })

    await owner.requestProviderReconnect()
    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined())

    expect(recoverFailedDeferredDisconnect).toHaveBeenCalledOnce()
    expect(recoverFailedDeferredDisconnect).toHaveBeenCalledWith(disconnectFailure, 1)
    expect(reportFailure).toHaveBeenCalledWith(
      'deferred reconnect disconnect failed',
      disconnectFailure
    )
  })
})
