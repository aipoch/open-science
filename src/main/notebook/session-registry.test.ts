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
})
