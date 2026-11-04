import { describe, expect, it, vi } from 'vitest'

import { AcpConnectionTransitionOwner } from './connection-transition-owner'
import { AcpConnectionResourceOwner } from './connection-resource-owner'
import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const terminateProcessTree = vi.hoisted(() => vi.fn(async () => ({ reaped: true })))
vi.mock('../process-tree', () => ({ terminateProcessTree }))

describe('AcpConnectionTransitionOwner', () => {
  it('keeps failed retirement retryable without recursively retrying activity during cleanup', async () => {
    const failure = new Error('disconnect failed')
    const onRetired = vi.fn()
    const disconnect = vi.fn(async (): Promise<void> => {
      owner.activityChanged()
      throw failure
    })
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: false, retirement: false }),
      connectionGeneration: () => 1,
      cleanupConfirmed: () => true,
      disconnect,
      onRetired,
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })
    await owner.requestRetirement()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onRetired).not.toHaveBeenCalled()
    disconnect.mockResolvedValue(undefined)
    owner.activityChanged()
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'retries retirement until actual resource cleanup is confirmed; joining planned disconnect=%s',
    async (planned) => {
      const resources = new AcpConnectionResourceOwner()
      await resources.connect(async (attempt) => {
        attempt.attach({
          process: {} as ChildProcessWithoutNullStreams,
          connection: { close: vi.fn() } as unknown as ClientConnection,
          framework: 'claude-code',
          bridgeLease: undefined
        })
        return attempt.publish({ close: false, delete: false, resume: false, steering: false })
      })
      const gate = Promise.withResolvers<void>()
      const disconnect = vi.fn(async () => {
        await gate.promise
        await resources.teardown(resources.supersede())
      })
      const onRetired = vi.fn()
      const owner = new AcpConnectionTransitionOwner({
        blockers: () => ({ reconnect: false, retirement: false }),
        connectionGeneration: () => resources.epoch,
        disconnect,
        cleanupConfirmed: () => resources.cleanupConfirmed,
        onRetired,
        publishIdle: vi.fn(),
        recoverFailedDeferredDisconnect: vi.fn(),
        reportFailure: vi.fn()
      })
      terminateProcessTree.mockResolvedValueOnce({ reaped: false })
      const reconnect = planned ? owner.requestProviderReconnect() : undefined
      const first = owner.requestRetirement()
      const concurrent = owner.requestRetirement()
      gate.resolve()
      await Promise.all([reconnect, first, concurrent])
      expect(onRetired).not.toHaveBeenCalled()
      expect(disconnect).toHaveBeenCalledOnce()
      await owner.requestRetirement()
      expect(disconnect).toHaveBeenCalledTimes(2)
      expect(onRetired).toHaveBeenCalledOnce()
      await owner.requestRetirement()
      expect(onRetired).toHaveBeenCalledOnce()
    }
  )

  it.each([false, true])(
    'coalesces reconnects with an in-flight idle release; failure=%s',
    async (fail) => {
      const gate = Promise.withResolvers<void>()
      const failure = new Error('idle teardown failed')
      const disconnect = vi.fn(async () => {
        await gate.promise
        if (fail) throw failure
      })
      const recoverFailedDeferredDisconnect = vi.fn()
      const publishIdle = vi.fn()
      const owner = new AcpConnectionTransitionOwner({
        blockers: () => ({ reconnect: false, retirement: false }),
        connectionGeneration: () => 1,
        cleanupConfirmed: () => true,
        disconnect,
        onRetired: vi.fn(),
        publishIdle,
        recoverFailedDeferredDisconnect,
        reportFailure: vi.fn()
      })
      owner.requestIdleRelease()
      let reconnectSettled = false
      const reconnect = owner.requestProviderReconnect().then(
        () => {
          reconnectSettled = true
        },
        (error) => {
          reconnectSettled = true
          return error
        }
      )
      owner.requestSkillsReload()
      owner.requestIdleRelease()
      await Promise.resolve()
      expect(disconnect).toHaveBeenCalledOnce()
      expect(reconnectSettled).toBe(false)
      expect(owner.barrier).toBeDefined()
      gate.resolve()
      await Promise.all([reconnect, owner.barrier])
      expect(await reconnect).toBe(fail ? failure : undefined)
      expect(owner.barrier).toBeUndefined()
      expect(disconnect).toHaveBeenCalledOnce()
      expect(publishIdle).toHaveBeenCalledTimes(fail ? 0 : 1)
      expect(recoverFailedDeferredDisconnect).toHaveBeenCalledTimes(fail ? 1 : 0)
      disconnect.mockResolvedValue(undefined)
      await owner.requestProviderReconnect()
      expect(disconnect).toHaveBeenCalledTimes(2)
    }
  )

  it('waits for operation leases before idle release and fences startup during teardown', async () => {
    let operationActive = true
    let finish!: () => void
    const teardown = new Promise<void>((resolve) => {
      finish = resolve
    })
    const disconnect = vi.fn(() => teardown)
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: false, retirement: operationActive }),
      connectionGeneration: () => 1,
      cleanupConfirmed: () => true,
      disconnect,
      onRetired: vi.fn(),
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })
    owner.requestIdleRelease()
    expect(disconnect).not.toHaveBeenCalled()
    expect(owner.barrier).toBeUndefined()
    operationActive = false
    owner.activityChanged()
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(false)
    expect(owner.barrier).toBeDefined()
    finish()
    await owner.barrier
    owner.activityChanged()
    expect(owner.barrier).toBeUndefined()
    expect(disconnect).toHaveBeenCalledOnce()
  })

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
        cleanupConfirmed: () => true,
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
      cleanupConfirmed: () => true,
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
      cleanupConfirmed: () => true,
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
      cleanupConfirmed: () => true,
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
      cleanupConfirmed: () => true,
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
