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
})
