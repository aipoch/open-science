import { describe, expect, it, vi } from 'vitest'

import { NotebookSessionRegistry } from './session-registry'

type TestSession = {
  sessionId: string
  shutdownExecutor: () => Promise<{ reaped: boolean }>
  releaseMcpRpcConnection: () => void
}

const deferred = <T>() => {
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
  it('shares one initialization across concurrent admission for the same session ID', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const create = vi.fn(() => initialization.promise)

    const first = registry.getOrCreate('session-1', create)
    const second = registry.getOrCreate('session-1', create)

    expect(create).toHaveBeenCalledTimes(1)
    const session = testSession('session-1')
    initialization.resolve(session)

    await expect(Promise.all([first, second])).resolves.toEqual([session, session])
    expect(registry.get('session-1')).toBe(session)
  })

  it('allows another initialization after the first attempt rejects', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initializationError = new Error('initialization failed')
    const session = testSession('session-1')
    const create = vi
      .fn<() => Promise<TestSession>>()
      .mockRejectedValueOnce(initializationError)
      .mockResolvedValueOnce(session)

    await expect(registry.getOrCreate('session-1', create)).rejects.toBe(initializationError)
    await expect(registry.getOrCreate('session-1', create)).resolves.toBe(session)

    expect(create).toHaveBeenCalledTimes(2)
  })

  it('initializes different session IDs without serializing them', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const firstInitialization = deferred<TestSession>()
    const second = testSession('session-2')

    const firstAdmission = registry.getOrCreate('session-1', () => firstInitialization.promise)
    const secondAdmission = registry.getOrCreate('session-2', async () => second)

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

    const originalAdmission = registry.getOrCreate('session-1', () => initialization.promise)
    const removal = registry.remove('session-1')
    const replacementAdmission = registry.getOrCreate('session-1', createReplacement)

    expect(createReplacement).not.toHaveBeenCalled()
    initialization.resolve(original)

    await expect(originalAdmission).resolves.toBe(original)
    await expect(removal).resolves.toEqual({ reaped: true })
    await expect(replacementAdmission).resolves.toBe(replacement)
    expect(original.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(original.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get('session-1')).toBe(replacement)
  })

  it('restores queued admission to the old session when removal fails', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('teardown failed')
    const original = testSession('session-1')
    vi.mocked(original.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate('session-1', async () => original)
    const createReplacement = vi.fn(async () => testSession('session-1'))

    const removal = registry.remove('session-1')
    const queuedAdmission = registry.getOrCreate('session-1', createReplacement)

    await expect(removal).rejects.toBe(teardownError)
    await expect(queuedAdmission).resolves.toBe(original)
    expect(createReplacement).not.toHaveBeenCalled()
    expect(original.releaseMcpRpcConnection).not.toHaveBeenCalled()
    expect(registry.get('session-1')).toBe(original)
  })

  it('shuts down in-flight sessions before reopening global admission', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const initialization = deferred<TestSession>()
    const original = testSession('session-1')
    const replacement = testSession('session-2')
    const createReplacement = vi.fn(async () => replacement)

    const originalAdmission = registry.getOrCreate('session-1', () => initialization.promise)
    const shutdown = registry.shutdownAll()
    const replacementAdmission = registry.getOrCreate('session-2', createReplacement)

    expect(createReplacement).not.toHaveBeenCalled()
    initialization.resolve(original)

    await expect(originalAdmission).resolves.toBe(original)
    await expect(shutdown).resolves.toEqual({ reaped: true })
    await expect(replacementAdmission).resolves.toBe(replacement)
    expect(original.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(original.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
    expect(registry.get('session-1')).toBeUndefined()
    expect(registry.get('session-2')).toBe(replacement)
  })

  it('keeps failed sessions while removing successful sessions after best-effort shutdown', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardownError = new Error('session-1 teardown failed')
    const failed = testSession('session-1')
    const removed = testSession('session-2')
    vi.mocked(failed.shutdownExecutor).mockRejectedValueOnce(teardownError)
    await registry.getOrCreate('session-1', async () => failed)
    await registry.getOrCreate('session-2', async () => removed)
    const createReplacement = vi.fn(async () => testSession('session-1'))

    const shutdown = registry.shutdownAll()
    const queuedAdmission = registry.getOrCreate('session-1', createReplacement)

    await expect(shutdown).rejects.toBe(teardownError)
    await expect(queuedAdmission).resolves.toBe(failed)
    expect(createReplacement).not.toHaveBeenCalled()
    expect(registry.get('session-1')).toBe(failed)
    expect(registry.get('session-2')).toBeUndefined()
    expect(failed.releaseMcpRpcConnection).not.toHaveBeenCalled()
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
    await registry.getOrCreate('session-2', async () => second)
    await registry.getOrCreate('session-1', async () => first)

    const failure = await registry.shutdownAll().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([firstError, secondError])
    expect(registry.get('session-1')).toBe(first)
    expect(registry.get('session-2')).toBe(second)
  })

  it('returns reaped false after releasing sessions, then reopens admission', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const unreaped = testSession('session-1')
    vi.mocked(unreaped.shutdownExecutor).mockResolvedValueOnce({ reaped: false })
    await registry.getOrCreate('session-1', async () => unreaped)

    await expect(registry.shutdownAll()).resolves.toEqual({ reaped: false })

    const replacement = testSession('session-1')
    await expect(registry.getOrCreate('session-1', async () => replacement)).resolves.toBe(
      replacement
    )
    expect(unreaped.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })

  it('includes an earlier per-session removal without tearing down its aggregate twice', async () => {
    const registry = new NotebookSessionRegistry<TestSession>()
    const teardown = deferred<{ reaped: boolean }>()
    const session = testSession('session-1')
    vi.mocked(session.shutdownExecutor).mockReturnValue(teardown.promise)
    await registry.getOrCreate('session-1', async () => session)

    const removal = registry.remove('session-1')
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
    await registry.getOrCreate('session-1', async () => session)

    const shutdown = registry.shutdownAll()
    const removal = registry.remove('session-1')

    await vi.waitFor(() => expect(session.shutdownExecutor).toHaveBeenCalledTimes(1))
    teardown.resolve({ reaped: true })
    await expect(Promise.all([shutdown, removal])).resolves.toEqual([
      { reaped: true },
      { reaped: true }
    ])
    expect(session.shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledTimes(1)
  })
})
