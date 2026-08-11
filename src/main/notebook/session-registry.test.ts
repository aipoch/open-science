import { describe, expect, it, vi } from 'vitest'

import { NotebookSessionRegistry } from './session-registry'
import { createFrameNotebookLane, type NotebookLaneIdentity } from './lane-identity'

const lane = (sessionId: string): NotebookLaneIdentity =>
  createFrameNotebookLane('project-a', sessionId, `root-frame-${sessionId}`)

type TestSession = {
  sessionId: string
  shutdownExecutor: () => Promise<{ reaped: boolean }>
  releaseMcpRpcConnection: () => void
}

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const testSession = (sessionId: string): TestSession => ({
  sessionId,
  shutdownExecutor: vi.fn(async () => ({ reaped: true })),
  releaseMcpRpcConnection: vi.fn()
})

describe('NotebookSessionRegistry', () => {
  it('rejects a Session-only owner identity', () => {
    const registry = new NotebookSessionRegistry<TestSession>()

    expect(() =>
      registry.getOrCreate('session-1' as unknown as NotebookLaneIdentity, async () =>
        testSession('session-1')
      )
    ).toThrow('Notebook owners require an explicit Frame lane.')
  })

  it('isolates owners in different Project and Agent Frame lanes even when session IDs match', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const firstLane = createFrameNotebookLane('project-a', 'session-1', 'frame-a')
    const secondLane = createFrameNotebookLane('project-a', 'session-1', 'frame-b')
    const otherProjectLane = createFrameNotebookLane('project-b', 'session-1', 'frame-a')
    const first = testSession('session-1')
    const second = testSession('session-1')
    const otherProject = testSession('session-1')

    await registry.getOrCreate(firstLane, async () => first)
    await registry.getOrCreate(secondLane, async () => second)
    await registry.getOrCreate(otherProjectLane, async () => otherProject)

    expect(registry.get(firstLane)).toBe(first)
    expect(registry.get(secondLane)).toBe(second)
    expect(registry.get(otherProjectLane)).toBe(otherProject)

    await registry.remove(secondLane)
    expect(registry.get(firstLane)).toBe(first)
    expect(registry.get(secondLane)).toBeUndefined()
    expect(registry.get(otherProjectLane)).toBe(otherProject)
  })

  it('shares one initialization across concurrent admission for the same session ID', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const create = vi.fn(() => initialization.promise)

    const first = registry.getOrCreate(lane('session-1'), create)
    const second = registry.getOrCreate(lane('session-1'), create)

    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    const session = testSession('session-1')
    initialization.resolve(session)

    await expect(Promise.all([first, second])).resolves.toEqual([session, session])
    expect(registry.get(lane('session-1'))).toBe(session)
  })

  it('allows another initialization after the first attempt rejects', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initializationError = new Error('initialization failed')
    const session = testSession('session-1')
    const create = vi
      .fn<() => Promise<TestSession>>()
      .mockRejectedValueOnce(initializationError)
      .mockResolvedValueOnce(session)

    await expect(registry.getOrCreate(lane('session-1'), create)).rejects.toBe(initializationError)
    await expect(registry.getOrCreate(lane('session-1'), create)).resolves.toBe(session)

    expect(create).toHaveBeenCalledTimes(2)
  })

  it('turns a synchronous initialization failure into a retryable rejection', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initializationError = new Error('synchronous initialization failed')
    const session = testSession('session-1')
    const create = vi
      .fn<() => Promise<TestSession>>()
      .mockImplementationOnce(() => {
        throw initializationError
      })
      .mockResolvedValueOnce(session)

    await expect(registry.getOrCreate(lane('session-1'), create)).rejects.toBe(initializationError)
    await expect(registry.getOrCreate(lane('session-1'), create)).resolves.toBe(session)
  })

  it('initializes different session IDs without serializing them', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const firstInitialization = deferred<TestSession>()
    const second = testSession('session-2')

    const firstAdmission = registry.getOrCreate(
      lane('session-1'),
      () => firstInitialization.promise
    )
    const secondAdmission = registry.getOrCreate(lane('session-2'), async () => second)

    await expect(secondAdmission).resolves.toBe(second)
    const first = testSession('session-1')
    firstInitialization.resolve(first)
    await expect(firstAdmission).resolves.toBe(first)
  })

  it('removes an in-flight session before admitting a fresh generation', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const original = testSession('session-1')
    const replacement = testSession('session-1')
    const createReplacement = vi.fn(async () => replacement)

    const originalAdmission = registry.getOrCreate(lane('session-1'), () => initialization.promise)
    const removal = registry.remove(lane('session-1'))
    const replacementAdmission = registry.getOrCreate(lane('session-1'), createReplacement)

    expect(createReplacement).not.toHaveBeenCalled()
    initialization.resolve(original)

    await expect(originalAdmission).resolves.toBe(original)
    await expect(removal).resolves.toEqual({ reaped: true })
    await expect(replacementAdmission).resolves.toBe(replacement)
    expect(original.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(original.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBe(replacement)
  })

  it('restores queued admission to the old session when removal fails', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('teardown failed')
    const original = testSession('session-1')
    vi.mocked(original.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => original)
    const createReplacement = vi.fn(async () => testSession('session-1'))

    const removal = registry.remove(lane('session-1'))
    const queuedAdmission = registry.getOrCreate(lane('session-1'), createReplacement)

    await expect(removal).rejects.toBe(teardownError)
    await expect(queuedAdmission).resolves.toBe(original)
    expect(createReplacement).not.toHaveBeenCalled()
    expect(original.releaseMcpRpcConnection).not.toHaveBeenCalled()
    expect(registry.get(lane('session-1'))).toBe(original)
  })

  it('shuts down in-flight sessions before reopening global admission', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const original = testSession('session-1')
    const replacement = testSession('session-2')
    const createReplacement = vi.fn(async () => replacement)

    const originalAdmission = registry.getOrCreate(lane('session-1'), () => initialization.promise)
    const shutdown = registry.shutdownAll()
    const replacementAdmission = registry.getOrCreate(lane('session-2'), createReplacement)

    expect(createReplacement).not.toHaveBeenCalled()
    initialization.resolve(original)

    await expect(originalAdmission).resolves.toBe(original)
    await expect(shutdown).resolves.toEqual({ reaped: true })
    await expect(replacementAdmission).resolves.toBe(replacement)
    expect(original.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(original.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
    expect(registry.get(lane('session-2'))).toBe(replacement)
  })

  it('keeps failed sessions while removing successful sessions after best-effort shutdown', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('session-1 teardown failed')
    const failed = testSession('session-1')
    const removed = testSession('session-2')
    vi.mocked(failed.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => failed)
    await registry.getOrCreate(lane('session-2'), async () => removed)
    const createReplacement = vi.fn(async () => testSession('session-1'))

    const shutdown = registry.shutdownAll()
    const queuedAdmission = registry.getOrCreate(lane('session-1'), createReplacement)

    await expect(shutdown).rejects.toBe(teardownError)
    await expect(queuedAdmission).resolves.toBe(failed)
    expect(createReplacement).not.toHaveBeenCalled()
    expect(registry.get(lane('session-1'))).toBe(failed)
    expect(registry.get(lane('session-2'))).toBeUndefined()
    expect(failed.releaseMcpRpcConnection).not.toHaveBeenCalled()
    expect(removed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('isolates a synchronous executor shutdown failure from other aggregates', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('synchronous teardown failed')
    const failed = testSession('session-1')
    const removed = testSession('session-2')
    vi.mocked(failed.shutdownExecutor).mockImplementationOnce(() => {
      throw teardownError
    })
    await registry.getOrCreate(lane('session-1'), async () => failed)
    await registry.getOrCreate(lane('session-2'), async () => removed)

    await expect(registry.shutdownAll()).rejects.toBe(teardownError)

    expect(failed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(removed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBe(failed)
    expect(registry.get(lane('session-2'))).toBeUndefined()
    expect(removed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('reports multiple shutdown failures in deterministic session-ID order', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const firstError = new Error('session-1 teardown failed')
    const secondError = new Error('session-2 teardown failed')
    const second = testSession('session-2')
    const first = testSession('session-1')
    vi.mocked(second.shutdownExecutor).mockRejectedValueOnce(secondError)
    vi.mocked(first.shutdownExecutor).mockRejectedValueOnce(firstError)
    await registry.getOrCreate(lane('session-2'), async () => second)
    await registry.getOrCreate(lane('session-1'), async () => first)

    const failure = await registry.shutdownAll().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([firstError, secondError])
    expect(registry.get(lane('session-1'))).toBe(first)
    expect(registry.get(lane('session-2'))).toBe(second)
  })

  it('isolates reusable release failures and aggregates them with executor failures', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const executorError = new Error('session-1 executor teardown failed')
    const releaseError = new Error('session-2 connection release failed')
    const executorFailed = testSession('session-1')
    const releaseFailed = testSession('session-2')
    const removed = testSession('session-3')
    vi.mocked(executorFailed.shutdownExecutor).mockRejectedValueOnce(executorError)
    vi.mocked(releaseFailed.releaseMcpRpcConnection).mockImplementationOnce(() => {
      throw releaseError
    })
    await registry.getOrCreate(lane('session-1'), async () => executorFailed)
    await registry.getOrCreate(lane('session-2'), async () => releaseFailed)
    await registry.getOrCreate(lane('session-3'), async () => removed)

    const failure = await registry.shutdownAll().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([executorError, releaseError])
    expect(executorFailed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(releaseFailed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(removed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBe(executorFailed)
    expect(registry.get(lane('session-2'))).toBe(releaseFailed)
    expect(registry.get(lane('session-3'))).toBeUndefined()
  })

  it('returns reaped false after releasing sessions, then reopens admission', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const unreaped = testSession('session-1')
    vi.mocked(unreaped.shutdownExecutor).mockResolvedValueOnce({ reaped: false })
    await registry.getOrCreate(lane('session-1'), async () => unreaped)

    await expect(registry.shutdownAll()).resolves.toEqual({ reaped: false })

    const replacement = testSession('session-1')
    await expect(registry.getOrCreate(lane('session-1'), async () => replacement)).resolves.toBe(
      replacement
    )
    expect(unreaped.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('includes an earlier per-session removal without tearing down its aggregate twice', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardown = deferred<{ reaped: boolean }>()
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockReturnValue(teardown.promise)
    await registry.getOrCreate(lane('session-1'), async () => session)

    const removal = registry.remove(lane('session-1'))
    const shutdown = registry.shutdownAll()

    await vi.waitFor(() => expect(session.shutdownExecutor).toHaveBeenCalledTimes(1))
    teardown.resolve({ reaped: true })
    await expect(Promise.all([removal, shutdown])).resolves.toEqual([
      { reaped: true },
      { reaped: true }
    ])
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('queues per-session removal behind an earlier global shutdown', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardown = deferred<{ reaped: boolean }>()
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockReturnValue(teardown.promise)
    await registry.getOrCreate(lane('session-1'), async () => session)

    const shutdown = registry.shutdownAll()
    const removal = registry.remove(lane('session-1'))

    await vi.waitFor(() => expect(session.shutdownExecutor).toHaveBeenCalledTimes(1))
    teardown.resolve({ reaped: true })
    await expect(Promise.all([shutdown, removal])).resolves.toEqual([
      { reaped: true },
      { reaped: true }
    ])
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('permanently closes admission and shares terminal disposal across callers', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockResolvedValueOnce({ reaped: false })
    const admission = registry.getOrCreate(lane('session-1'), () => initialization.promise)

    const firstDisposal = registry.dispose()
    const repeatedDisposal = registry.dispose()
    const createAfterDispose = vi.fn(async () => testSession('session-2'))

    expect(repeatedDisposal).toBe(firstDisposal)
    await expect(registry.getOrCreate(lane('session-2'), createAfterDispose)).rejects.toThrow(
      /disposed/
    )
    expect(createAfterDispose).not.toHaveBeenCalled()
    initialization.resolve(session)

    await expect(admission).resolves.toBe(session)
    await expect(firstDisposal).resolves.toEqual({ reaped: false })
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    await expect(registry.getOrCreate(lane('session-1'), async () => session)).rejects.toThrow(
      /disposed/
    )
  })

  it('rethrows one terminal teardown error unchanged after attempting every session', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('terminal teardown failed')
    const failed = testSession('session-1')
    const removed = testSession('session-2')
    vi.mocked(failed.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => failed)
    await registry.getOrCreate(lane('session-2'), async () => removed)

    await expect(registry.dispose()).rejects.toBe(teardownError)

    expect(failed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(removed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(failed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(removed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
    expect(registry.get(lane('session-2'))).toBeUndefined()
  })

  it('releases terminal resources exactly once after executor shutdown rejects', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('terminal executor teardown failed')
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => session)

    const disposal = registry.dispose()

    await expect(disposal).rejects.toBe(teardownError)
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
    await expect(registry.dispose()).rejects.toBe(teardownError)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('aggregates terminal executor and release failures after attempting every aggregate', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const executorError = new Error('session-1 terminal executor failed')
    const releaseError = new Error('session-1 terminal release failed')
    const failed = testSession('session-1')
    const cleaned = testSession('session-2')
    vi.mocked(failed.shutdownExecutor).mockRejectedValueOnce(executorError)
    vi.mocked(failed.releaseMcpRpcConnection).mockImplementationOnce(() => {
      throw releaseError
    })
    await registry.getOrCreate(lane('session-1'), async () => failed)
    await registry.getOrCreate(lane('session-2'), async () => cleaned)

    const failure = await registry.dispose().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([executorError, releaseError])
    expect(failed.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(cleaned.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(failed.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(cleaned.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
    expect(registry.get(lane('session-2'))).toBeUndefined()
  })

  it('orders multiple terminal teardown errors by session ID', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const firstError = new Error('session-1 terminal teardown failed')
    const secondError = new Error('session-2 terminal teardown failed')
    const second = testSession('session-2')
    const first = testSession('session-1')
    vi.mocked(second.shutdownExecutor).mockRejectedValueOnce(secondError)
    vi.mocked(first.shutdownExecutor).mockRejectedValueOnce(firstError)
    await registry.getOrCreate(lane('session-2'), async () => second)
    await registry.getOrCreate(lane('session-1'), async () => first)

    const failure = await registry.dispose().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([firstError, secondError])
  })

  it('finishes terminal disposal when an in-flight initialization rejects', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const initializationError = new Error('factory failed')
    const admission = registry.getOrCreate(lane('session-1'), () => initialization.promise)

    const disposal = registry.dispose()
    initialization.reject(initializationError)

    await expect(admission).rejects.toBe(initializationError)
    await expect(disposal).resolves.toEqual({ reaped: true })
  })

  it('includes an earlier failed removal in terminal disposal without retrying teardown', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('removal teardown failed')
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => session)

    const removal = registry.remove(lane('session-1'))
    const disposal = registry.dispose()

    await expect(removal).rejects.toBe(teardownError)
    await expect(disposal).rejects.toBe(teardownError)
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
  })

  it('does not repeat a release that already failed during removal before terminal disposal', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const releaseError = new Error('removal release failed')
    const session = testSession('session-1')
    vi.mocked(session.releaseMcpRpcConnection).mockImplementationOnce(() => {
      throw releaseError
    })
    await registry.getOrCreate(lane('session-1'), async () => session)

    const removal = registry.remove(lane('session-1'))
    const disposal = registry.dispose()

    await expect(removal).rejects.toBe(releaseError)
    await expect(disposal).rejects.toBe(releaseError)
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get(lane('session-1'))).toBeUndefined()
  })

  it('adopts an earlier global shutdown as terminal cleanup without retrying failures', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('global teardown failed')
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate(lane('session-1'), async () => session)

    const shutdown = registry.shutdownAll()
    const disposal = registry.dispose()

    await expect(shutdown).rejects.toBe(teardownError)
    await expect(disposal).rejects.toBe(teardownError)
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
  })
})
