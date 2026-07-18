import { afterEach, describe, expect, it, vi } from 'vitest'
import { shutdownBackends, type BackendShutdownDeps } from './lifecycle-shutdown'

// Builds a fresh set of injectable fakes; individual tests override behavior as needed.
const makeDeps = (overrides: Partial<BackendShutdownDeps> = {}): BackendShutdownDeps => ({
  runtime: { shutdownForQuit: vi.fn(async () => undefined) },
  notebook: { shutdownAll: vi.fn(async () => undefined) },
  log: { error: vi.fn() },
  ...overrides
})

describe('shutdownBackends', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shuts down both backends via the quit-safe runtime path', async () => {
    const deps = makeDeps()
    await shutdownBackends(deps)
    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.notebook.shutdownAll).toHaveBeenCalledTimes(1)
  })

  it('still runs notebook shutdown and resolves when runtime teardown rejects', async () => {
    const err = new Error('runtime boom')
    const deps = makeDeps({
      runtime: { shutdownForQuit: vi.fn(async () => Promise.reject(err)) }
    })
    await expect(shutdownBackends(deps)).resolves.toBeUndefined()
    expect(deps.notebook.shutdownAll).toHaveBeenCalledTimes(1)
    expect(deps.log?.error).toHaveBeenCalledWith(expect.any(String), err)
  })

  it('resolves and logs even when notebook shutdown rejects', async () => {
    const err = new Error('notebook boom')
    const deps = makeDeps({
      notebook: { shutdownAll: vi.fn(async () => Promise.reject(err)) }
    })
    await expect(shutdownBackends(deps)).resolves.toBeUndefined()
    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.log?.error).toHaveBeenCalledWith(expect.any(String), err)
  })

  it('resolves via the timeout when a backend never settles', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      // A backend that hangs forever; only the timeout can free the caller.
      runtime: { shutdownForQuit: vi.fn(() => new Promise<never>(() => {})) },
      timeoutMs: 5000
    })

    const pending = shutdownBackends(deps)
    let settled = false
    void pending.then(() => {
      settled = true
    })

    // Before the deadline the promise is still pending.
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)

    // Crossing the timeout resolves the shutdown regardless of the hung backend.
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })
})
