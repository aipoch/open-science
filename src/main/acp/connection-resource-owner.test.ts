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
  it('awaits every superseded connection attempt before shutdown can report no resources', async () => {
    const owner = new AcpConnectionResourceOwner()
    const firstGate = createDeferred()
    const secondGate = createDeferred()
    const first = owner.connect(async (attempt) => {
      await firstGate.promise
      attempt.assertCurrent()
      return attachAndPublish(attempt, 'first')
    })
    void first.catch(() => undefined)
    owner.supersede()
    const second = owner.connect(async (attempt) => {
      await secondGate.promise
      attempt.assertCurrent()
      return attachAndPublish(attempt, 'second')
    })
    void second.catch(() => undefined)
    owner.shutdownSynchronously(vi.fn())
    expect(owner.hasProcessResources).toBe(true)
    let completed = false
    const shutdown = owner
      .beginAwaitableShutdown(true)
      .finish()
      .then((result) => {
        completed = true
        return result
      })
    secondGate.resolve()
    await expect(second).rejects.toThrow('superseded')
    expect(completed).toBe(false)
    expect(owner.hasProcessResources).toBe(true)
    firstGate.resolve()
    await expect(first).rejects.toThrow('superseded')
    await expect(shutdown).resolves.toEqual({ reaped: true })
    expect(owner.hasProcessResources).toBe(false)
    await expect(owner.connect(vi.fn())).rejects.toThrow('shutting down')
  })

  it.each(['bridgeLease', 'anthropicBridgeLease', 'providerTransportLease'] as const)(
    'retains failed %s releases until an explicit shutdown retry succeeds',
    async (key) => {
      const owner = new AcpConnectionResourceOwner()
      const release = vi
        .fn()
        .mockRejectedValueOnce(new Error('release unavailable'))
        .mockRejectedValueOnce(new Error('release still unavailable'))
        .mockResolvedValue(undefined)
      const lease = {
        selectSkills: vi.fn(async () => []),
        registerReviewerSession: vi.fn(),
        unregisterReviewerSession: vi.fn(() => true),
        setTarget: vi.fn(() => true),
        release
      }
      await owner.cleanupUnattached({ [key]: lease })
      expect(owner.hasProcessResources).toBe(true)
      await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: false })
      await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
      await owner.cleanupUnattached({ [key]: lease })
      expect(release).toHaveBeenCalledTimes(3)
      expect(owner.hasProcessResources).toBe(false)
    }
  )

  it('joins concurrent lease releases and includes them in shutdown readiness', async () => {
    const owner = new AcpConnectionResourceOwner()
    const gate = createDeferred()
    const release = vi.fn(() => gate.promise)
    const resource = { providerTransportLease: { setTarget: vi.fn(() => true), release } }
    const first = owner.cleanupUnattached(resource)
    const second = owner.cleanupUnattached(resource)
    const shutdown = owner.beginAwaitableShutdown(false).finish()
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(owner.hasProcessResources).toBe(true)
    gate.resolve()
    await Promise.all([first, second])
    await expect(shutdown).resolves.toEqual({ reaped: true })
    expect(release).toHaveBeenCalledOnce()
  })

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
    expect(owner.capabilities).toEqual({
      close: false,
      delete: false,
      resume: false,
      steering: false
    })

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
    const selectSkills = vi.fn(async () => [
      { name: 'mcp-pubmed', path: '/skills/mcp-pubmed/SKILL.md' }
    ])
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provider-transport'),
        connection: { close: vi.fn() } as unknown as ClientConnection,
        framework: 'opencode',
        bridgeLease: undefined,
        providerTransportLease: { setTarget, selectSkills, release }
      })
      return attempt.publish({ close: true, delete: false, resume: true, steering: false })
    })

    expect(owner.providerTransportAvailable).toBe(true)
    expect(owner.bridgeSkillsAvailable).toBe(true)
    expect(owner.setProviderTransportTarget('provider-b/model-b')).toBe(true)
    expect(setTarget).toHaveBeenCalledWith('provider-b/model-b')
    await expect(owner.selectBridgeSkills('use pubmed', [])).resolves.toEqual([
      { name: 'mcp-pubmed', path: '/skills/mcp-pubmed/SKILL.md' }
    ])

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

  it('retains a failed detached tree across empty shutdowns until exact-child recovery succeeds', async () => {
    const owner = new AcpConnectionResourceOwner()
    const child = process('unreaped')
    const release = vi.fn(async () => undefined)
    await owner.connect(async (attempt) => {
      attempt.attach({
        process: child,
        connection: { close: vi.fn() } as unknown as ClientConnection,
        framework: 'codex',
        bridgeLease: undefined,
        providerTransportLease: { setTarget: vi.fn(() => true), release }
      })
      return attempt.publish({ close: false, delete: false, resume: true, steering: false })
    })
    terminateProcessTree
      .mockResolvedValueOnce({ reaped: false })
      .mockResolvedValueOnce({ reaped: false })
      .mockResolvedValueOnce({ reaped: true })

    const first = owner.beginAwaitableShutdown(false)
    await owner.teardown(owner.supersede())
    await expect(first.finish()).resolves.toEqual({ reaped: false })
    expect(owner.connection).toBeUndefined()
    expect(release).toHaveBeenCalledOnce()

    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: false })
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
    expect(terminateProcessTree.mock.calls.map(([candidate]) => candidate)).toEqual([
      child,
      child,
      child
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not let a healthy successor erase an older generation cleanup failure', async () => {
    const owner = new AcpConnectionResourceOwner()
    const oldChild = process('old')
    terminateProcessTree.mockResolvedValueOnce({ reaped: false })
    await owner.cleanupUnattached({ process: oldChild })
    await owner.connect(async (attempt) => attachAndPublish(attempt, 'successor'))
    terminateProcessTree
      .mockResolvedValueOnce({ reaped: false })
      .mockResolvedValueOnce({ reaped: true })

    const shutdown = owner.beginAwaitableShutdown(false)
    await owner.teardown(owner.supersede(), vi.fn())
    await expect(shutdown.finish()).resolves.toEqual({ reaped: false })
    expect(terminateProcessTree.mock.calls[1]?.[0]).toBe(oldChild)
    expect(terminateProcessTree.mock.calls[2]?.[0]).not.toBe(oldChild)
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
    expect(terminateProcessTree.mock.calls[3]?.[0]).toBe(oldChild)
  })

  it('joins cleanup already started by unexpected close before declaring shutdown reaped', async () => {
    const owner = new AcpConnectionResourceOwner()
    await owner.connect(async (attempt) => attachAndPublish(attempt, 'closing'))
    const releaseReaping = createDeferred()
    terminateProcessTree.mockImplementationOnce(async () => {
      await releaseReaping.promise
      return { reaped: false }
    })
    owner.cleanupUnexpectedClose(owner.epoch)
    const first = owner.beginAwaitableShutdown(false).finish()
    const second = owner.beginAwaitableShutdown(false).finish()
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    releaseReaping.resolve()
    await expect(first).resolves.toEqual({ reaped: false })
    await expect(second).resolves.toEqual({ reaped: false })
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
  })

  it('retains an exact child for retry when its teardown rejects', async () => {
    const owner = new AcpConnectionResourceOwner()
    const child = process('rejected')
    terminateProcessTree.mockRejectedValueOnce(new Error('receipt settlement failed'))
    const reportFailure = vi.fn()
    await owner.cleanupUnattached({ process: child }, reportFailure)
    expect(reportFailure).toHaveBeenCalledWith('agent-process', expect.any(Error))
    terminateProcessTree.mockResolvedValueOnce({ reaped: false })
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: false })
    await expect(owner.beginAwaitableShutdown(false).finish()).resolves.toEqual({ reaped: true })
    expect(terminateProcessTree.mock.calls.every(([candidate]) => candidate === child)).toBe(true)
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
