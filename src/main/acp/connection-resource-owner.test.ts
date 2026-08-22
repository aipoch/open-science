import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AcpConnectionResourceOwner,
  type AcpConnectionResourceAttempt
} from './connection-resource-owner'

const terminateProcessTree = vi.hoisted(() =>
  vi.fn(async (child?: ChildProcessWithoutNullStreams) => {
    void child
    return { reaped: true }
  })
)
const ownerErrorLog = vi.hoisted(() => vi.fn())
vi.mock('../process-tree', () => ({ terminateProcessTree }))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: () => ({ ...actual.createLogger('acp'), error: ownerErrorLog })
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

const createDeferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const connection = (id: string): ClientConnection => ({ id }) as unknown as ClientConnection
const process = (id: string): ChildProcessWithoutNullStreams =>
  ({ id }) as unknown as ChildProcessWithoutNullStreams

const attachAndPublish = (
  attempt: AcpConnectionResourceAttempt,
  id: string
): ReturnType<AcpConnectionResourceAttempt['publish']> => {
  attempt.attach({
    process: process(id),
    connection: connection(id),
    framework: 'claude-code',
    bridgeLease: undefined
  })
  return attempt.publish({ close: true, delete: false, resume: true, steering: false })
}

describe('AcpConnectionResourceOwner', () => {
  it('shares one publication attempt across concurrent connect callers', async () => {
    const owner = new AcpConnectionResourceOwner()
    const canPublish = createDeferred()
    const operation = vi.fn(async (attempt: AcpConnectionResourceAttempt) => {
      await canPublish.promise
      return attachAndPublish(attempt, 'shared')
    })

    const first = owner.connect(operation)
    expect(operation).toHaveBeenCalledOnce()
    const secondOperation = vi.fn(async (attempt: AcpConnectionResourceAttempt) =>
      attachAndPublish(attempt, 'unexpected')
    )
    const second = owner.connect(secondOperation)

    expect(second).toBe(first)
    canPublish.resolve()
    const [firstHandle, secondHandle] = await Promise.all([first, second])

    expect(operation).toHaveBeenCalledOnce()
    expect(secondOperation).not.toHaveBeenCalled()
    expect(secondHandle).toBe(firstHandle)
    expect(owner.connection).toBe(firstHandle.connection)
  })

  it('keeps an attached resource provisional until publication', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provisional'),
        connection: connection('provisional'),
        framework: 'opencode',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: true, steering: false })
    })

    await attached.promise
    expect(owner.connection).toBeUndefined()
    expect(owner.capabilities).toEqual({ close: false, delete: false, resume: false, steering: false })

    canPublish.resolve()
    const handle = await pending
    expect(owner.connection).toBe(handle.connection)
    expect(owner.capabilities.resume).toBe(true)
  })

  it('prevents a superseded attempt from publishing its attached resource', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const staleProcess = process('stale')
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: staleProcess,
        connection: connection('stale'),
        framework: 'codex',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: false, steering: false })
    })
    await attached.promise

    const teardownEpoch = owner.supersede()
    canPublish.resolve()

    await expect(pending).rejects.toThrow('ACP connection was superseded.')
    await owner.teardown(teardownEpoch, vi.fn())
    expect(terminateProcessTree.mock.calls[0]?.[0]).toBe(staleProcess)
  })

  it('transfers each resource once and ignores a stale detach after replacement', async () => {
    const owner = new AcpConnectionResourceOwner()
    const first = await owner.connect(async (attempt) => attachAndPublish(attempt, 'first'))
    const firstTeardownEpoch = owner.supersede()
    expect(owner.connection).toBeUndefined()
    await owner.teardown(firstTeardownEpoch, vi.fn())
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    await owner.teardown(firstTeardownEpoch, vi.fn())
    expect(terminateProcessTree).toHaveBeenCalledOnce()

    const replacement = await owner.connect(async (attempt) =>
      attachAndPublish(attempt, 'replacement')
    )
    await owner.teardown(firstTeardownEpoch, vi.fn())
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    replacement.assertCurrent()
    expect(owner.connection).toBe(replacement.connection)

    await owner.teardown(owner.epoch, vi.fn())
    expect(terminateProcessTree).toHaveBeenCalledTimes(2)
    expect(() => replacement.assertCurrent()).toThrow('ACP connection was superseded.')
    expect(first.connection).not.toBe(replacement.connection)
  })

  it('restores only a still-attached published resource after teardown fails', async () => {
    const owner = new AcpConnectionResourceOwner()
    const handle = await owner.connect(async (attempt) => attachAndPublish(attempt, 'restored'))
    const teardownEpoch = owner.supersede()

    expect(owner.connection).toBeUndefined()
    expect(owner.restorePublished(teardownEpoch)).toBe(true)
    expect(owner.connection).toBe(handle.connection)

    const staleEpoch = teardownEpoch
    const replacementTeardownEpoch = owner.supersede()
    expect(owner.restorePublished(staleEpoch)).toBe(false)
    await owner.teardown(replacementTeardownEpoch, vi.fn())
    expect(owner.restorePublished(replacementTeardownEpoch)).toBe(false)
    expect(owner.connection).toBeUndefined()
  })

  it('keeps restored published process events current after teardown rollback', async () => {
    const owner = new AcpConnectionResourceOwner()
    const child = process('restored-process')
    let attemptEpoch = 0
    await owner.connect(async (attempt) => {
      attemptEpoch = attempt.epoch
      attempt.attach({
        process: child,
        connection: connection('restored-process'),
        framework: 'claude-code',
        bridgeLease: undefined
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })
    const teardownEpoch = owner.supersede()
    expect(owner.restorePublished(teardownEpoch)).toBe(true)

    expect(owner.processEventDisposition(child, attemptEpoch)).toBe('current')
  })

  it('never promotes a provisional resource through teardown rollback', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provisional'),
        connection: connection('provisional'),
        framework: 'codex',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: false, steering: false })
    })
    await attached.promise

    const teardownEpoch = owner.supersede()
    expect(owner.restorePublished(teardownEpoch)).toBe(false)
    expect(owner.connection).toBeUndefined()

    canPublish.resolve()
    await expect(pending).rejects.toThrow('ACP connection was superseded.')
    await owner.teardown(teardownEpoch, vi.fn())
    expect(terminateProcessTree).toHaveBeenCalledOnce()
  })

  it('detaches and releases one physical resource before teardown settles', async () => {
    const owner = new AcpConnectionResourceOwner()
    const child = process('physical')
    const close = vi.fn()
    const release = vi.fn(async () => undefined)
    const handle = await owner.connect(async (attempt) => {
      attempt.attach({
        process: child,
        connection: { close } as unknown as ClientConnection,
        framework: 'claude-code',
        bridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => true),
          release
        }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })
    const teardownEpoch = owner.supersede()

    await owner.teardown(teardownEpoch, vi.fn())

    expect(owner.connection).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(() => handle.assertCurrent()).toThrow('ACP connection was superseded.')

    await owner.teardown(teardownEpoch, vi.fn())
    expect(close).toHaveBeenCalledOnce()
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('retargets and releases the generation-scoped Anthropic bridge', async () => {
    const owner = new AcpConnectionResourceOwner()
    const setTarget = vi.fn(() => true)
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: process('anthropic-bridge'),
        connection: { close: vi.fn() } as unknown as ClientConnection,
        framework: 'claude-code',
        bridgeLease: undefined,
        anthropicBridgeLease: { setTarget, release }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })

    expect(owner.anthropicBridgeAvailable).toBe(true)
    expect(owner.setAnthropicBridgeTarget('kimi/kimi-k3')).toBe(true)
    expect(setTarget).toHaveBeenCalledWith('kimi/kimi-k3')

    const teardownEpoch = owner.supersede()
    await owner.teardown(teardownEpoch, vi.fn())

    expect(owner.anthropicBridgeAvailable).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('selects and releases the generation-scoped provider transport', async () => {
    const owner = new AcpConnectionResourceOwner()
    const setTarget = vi.fn(() => true)
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provider-transport'),
        connection: { close: vi.fn() } as unknown as ClientConnection,
        framework: 'opencode',
        bridgeLease: undefined,
        providerTransportLease: { setTarget, release }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })

    expect(owner.providerTransportAvailable).toBe(true)
    expect(owner.setProviderTransportTarget('provider-b/model-b')).toBe(true)
    expect(setTarget).toHaveBeenCalledWith('provider-b/model-b')

    await owner.teardown(owner.supersede(), vi.fn())

    expect(owner.providerTransportAvailable).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps synchronous shutdown terminal when close and kill both throw', async () => {
    const owner = new AcpConnectionResourceOwner()
    const close = vi.fn(() => {
      throw new Error('close failed')
    })
    const kill = vi.fn(() => {
      throw new Error('kill failed')
    })
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: { killed: false, kill } as unknown as ChildProcessWithoutNullStreams,
        connection: { close } as unknown as ClientConnection,
        framework: 'claude-code',
        bridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => true),
          release
        }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })

    ownerErrorLog.mockImplementation(() => {
      throw new Error('logger failed')
    })
    try {
      expect(() => owner.shutdownSynchronously(vi.fn())).not.toThrow()
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
      expect(close).toHaveBeenCalledOnce()
      expect(kill).toHaveBeenCalledOnce()
      expect(owner.isShuttingDown).toBe(true)
      expect(owner.connection).toBeUndefined()
    } finally {
      ownerErrorLog.mockReset()
    }
  })

  it('marks detached processes expected before async and synchronous connection close', async () => {
    const asyncOwner = new AcpConnectionResourceOwner()
    const asyncProcess = process('async-order')
    let asyncAttemptEpoch = 0
    const asyncClose = vi.fn(() => {
      expect(asyncOwner.processEventDisposition(asyncProcess, asyncAttemptEpoch)).toBe('expected')
    })
    await asyncOwner.connect(async (attempt) => {
      asyncAttemptEpoch = attempt.epoch
      attempt.attach({
        process: asyncProcess,
        connection: { close: asyncClose } as unknown as ClientConnection,
        framework: 'claude-code',
        bridgeLease: undefined
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })
    await asyncOwner.teardown(asyncOwner.supersede())

    const syncOwner = new AcpConnectionResourceOwner()
    const syncProcess = process('sync-order')
    let syncAttemptEpoch = 0
    const syncClose = vi.fn(() => {
      expect(syncOwner.processEventDisposition(syncProcess, syncAttemptEpoch)).toBe('expected')
    })
    await syncOwner.connect(async (attempt) => {
      syncAttemptEpoch = attempt.epoch
      attempt.attach({
        process: syncProcess,
        connection: { close: syncClose } as unknown as ClientConnection,
        framework: 'claude-code',
        bridgeLease: undefined
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })
    syncOwner.shutdownSynchronously(vi.fn())

    expect(asyncClose).toHaveBeenCalledOnce()
    expect(syncClose).toHaveBeenCalledOnce()
  })

  it('aggregates assigned and mid-spawn tree reap outcomes for awaitable shutdown', async () => {
    const owner = new AcpConnectionResourceOwner()
    await owner.connect(async (attempt) => attachAndPublish(attempt, 'assigned'))
    const releaseMidSpawn = createDeferred()
    const midSpawn = process('mid-spawn')
    const pending = owner.connect(async (attempt) => {
      await releaseMidSpawn.promise
      await owner.cleanupUnattached({ process: midSpawn })
      attempt.assertCurrent()
      return attachAndPublish(attempt, 'must-not-publish')
    })
    const shutdown = owner.beginAwaitableShutdown(true)
    const teardownEpoch = owner.supersede()
    terminateProcessTree
      .mockResolvedValueOnce({ reaped: false })
      .mockResolvedValueOnce({ reaped: true })

    await owner.teardown(teardownEpoch)
    releaseMidSpawn.resolve()

    await expect(shutdown.finish()).resolves.toEqual({ reaped: false })
    expect(terminateProcessTree).toHaveBeenCalledTimes(2)
    await expect(pending).rejects.toThrow('ACP connection was superseded.')
  })

  it('cleans unexpected-close resources exactly once across repeated notifications', async () => {
    const closeMcpHost = vi.fn(async () => undefined)
    const owner = new AcpConnectionResourceOwner({ closeMcpHost })
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: process('unexpected'),
        connection: connection('already-closed'),
        framework: 'claude-code',
        bridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => true),
          release
        }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })

    owner.cleanupUnexpectedClose(owner.epoch)
    owner.cleanupUnexpectedClose(owner.epoch)
    await owner.closeMcp(owner.epoch)

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(closeMcpHost).toHaveBeenCalledOnce()
  })

  it('accepts only the current epoch while a spawned process is not attached yet', () => {
    const owner = new AcpConnectionResourceOwner()
    const child = process('pre-attach')
    const spawningEpoch = owner.epoch

    expect(owner.processEventDisposition(child, spawningEpoch)).toBe('current')
    owner.supersede()
    expect(owner.processEventDisposition(child, spawningEpoch)).toBe('stale')
  })

  it('exposes an immutable ready handle without process or bridge release authority', async () => {
    const owner = new AcpConnectionResourceOwner()
    const handle = await owner.connect(async (attempt) => attachAndPublish(attempt, 'ready'))

    expect(Object.keys(handle).sort()).toEqual([
      'assertCurrent',
      'capabilities',
      'connection',
      'epoch',
      'framework'
    ])
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Object.isFrozen(handle.capabilities)).toBe(true)
    expect(handle).not.toHaveProperty('process')
    expect(handle).not.toHaveProperty('bridgeLease')
    expect(handle).not.toHaveProperty('release')
  })
})
