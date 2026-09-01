import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendShutdownOutcomeError,
  BackendShutdownCoordinator,
  shutdownBackends,
  UPDATE_SHUTDOWN_BUDGET_MS,
  type BackendShutdownDeps
} from './lifecycle-shutdown'

// Builds a fresh set of injectable fakes; individual tests override behavior as needed. Both teardowns
// default to a clean reaped result.
const makeDeps = (overrides: Partial<BackendShutdownDeps> = {}): BackendShutdownDeps => ({
  runtime: {
    shutdownForQuit: vi.fn(async () => ({ reaped: true })),
    shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
  },
  notebook: {
    shutdownAll: vi.fn(async () => ({ reaped: true })),
    dispose: vi.fn(async () => ({ reaped: true }))
  },
  sideChat: {
    shutdown: vi.fn(async () => undefined),
    suspendAll: vi.fn(async () => undefined)
  },
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
    expect(deps.notebook.dispose).toHaveBeenCalledTimes(1)
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
  })

  it('still runs notebook shutdown and resolves when runtime teardown rejects', async () => {
    const err = new Error('runtime boom')
    const deps = makeDeps({
      runtime: {
        shutdownForQuit: vi.fn(async () => Promise.reject(err)),
        shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
      }
    })
    await expect(shutdownBackends(deps)).resolves.toBeUndefined()
    expect(deps.notebook.dispose).toHaveBeenCalledTimes(1)
    expect(deps.log?.error).toHaveBeenCalledWith('backend shutdown failed', {
      backend: 'runtime',
      errorCategory: 'error'
    })
    const errorLog = deps.log?.error
    if (!errorLog) throw new Error('Expected a shutdown logger.')
    expect(JSON.stringify(vi.mocked(errorLog).mock.calls)).not.toContain('runtime boom')
  })

  it('resolves and logs even when notebook shutdown rejects', async () => {
    const err = new Error('notebook boom')
    const deps = makeDeps({
      notebook: {
        shutdownAll: vi.fn(async () => ({ reaped: true })),
        dispose: vi.fn(async () => Promise.reject(err))
      }
    })
    await expect(shutdownBackends(deps)).resolves.toBeUndefined()
    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.log?.error).toHaveBeenCalledWith('backend shutdown failed', {
      backend: 'notebook',
      errorCategory: 'error'
    })
    const errorLog = deps.log?.error
    if (!errorLog) throw new Error('Expected a shutdown logger.')
    expect(JSON.stringify(vi.mocked(errorLog).mock.calls)).not.toContain('notebook boom')
  })

  it('still resolves when backend teardown and the diagnostic sink both fail', async () => {
    const deps = makeDeps({
      runtime: {
        shutdownForQuit: vi.fn(async () => Promise.reject(new Error('runtime boom'))),
        shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
      },
      log: {
        error: () => {
          throw new Error('sink unavailable')
        }
      }
    })

    await expect(shutdownBackends(deps)).resolves.toBeUndefined()
    expect(deps.notebook.dispose).toHaveBeenCalledOnce()
  })

  it('resolves via the timeout when a backend never settles', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      // A backend that hangs forever; only the timeout can free the caller.
      runtime: {
        shutdownForQuit: vi.fn(() => new Promise<never>(() => {})),
        shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
      },
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

describe('BackendShutdownCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runForQuit uses the latching teardown and reports completed + reaped when clean', async () => {
    const deps = makeDeps()
    const coordinator = new BackendShutdownCoordinator(deps)

    const outcome = await coordinator.runForQuit()

    expect(outcome).toEqual({ completed: true, reaped: true })
    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.runtime.shutdownForUpdateGate).not.toHaveBeenCalled()
    expect(deps.notebook.dispose).toHaveBeenCalledTimes(1)
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
  })

  it('runForUpdateGate uses the non-latching teardown', async () => {
    const suspendAll = vi.fn(async () => undefined)
    const deps = makeDeps({
      sideChat: {
        shutdown: vi.fn(async () => undefined),
        suspendAll
      }
    })
    const coordinator = new BackendShutdownCoordinator(deps)

    const outcome = await coordinator.runForUpdateGate()

    expect(outcome).toEqual({ completed: true, reaped: true })
    expect(deps.runtime.shutdownForUpdateGate).toHaveBeenCalledTimes(1)
    expect(deps.runtime.shutdownForQuit).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).toHaveBeenCalledTimes(1)
    expect(suspendAll).toHaveBeenCalledOnce()
  })

  it('reports reaped:false when a tree kill was degraded', async () => {
    const deps = makeDeps({
      notebook: {
        shutdownAll: vi.fn(async () => ({ reaped: false })),
        dispose: vi.fn(async () => ({ reaped: true }))
      }
    })
    const coordinator = new BackendShutdownCoordinator(deps)

    const outcome = await coordinator.runForUpdateGate()

    expect(outcome).toEqual({ completed: true, reaped: false })
  })

  it('refuses a handoff when Side Chat suspension cannot persist its conversation', async () => {
    const deps = makeDeps({
      sideChat: {
        shutdown: vi.fn(async () => undefined),
        suspendAll: vi.fn(async () => Promise.reject(new Error('save failed')))
      }
    })
    const coordinator = new BackendShutdownCoordinator(deps)

    await expect(coordinator.runForUpdateGate()).resolves.toEqual({
      completed: true,
      reaped: false
    })
  })

  it('reports completed:false (and reaped:false) when the gate teardown exceeds its budget', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      runtime: {
        shutdownForQuit: vi.fn(async () => ({ reaped: true })),
        // Hangs forever: only the budget deadline can resolve the gate.
        shutdownForUpdateGate: vi.fn(() => new Promise<never>(() => {}))
      }
    })
    const coordinator = new BackendShutdownCoordinator(deps)

    const pending = coordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_SHUTDOWN_BUDGET_MS)

    await expect(pending).resolves.toEqual({ completed: false, reaped: false })
  })

  it.each([
    { pendingBackends: ['runtime'] as const },
    { pendingBackends: ['notebook'] as const },
    { pendingBackends: ['runtime', 'notebook'] as const }
  ])(
    'identifies only $pendingBackends when the quit budget expires',
    async ({ pendingBackends }) => {
      vi.useFakeTimers()
      const pendingBackendSet = new Set<string>(pendingBackends)
      const neverSettles = (): Promise<never> => new Promise(() => {})
      const deps = makeDeps({
        runtime: {
          shutdownForQuit: vi.fn(() =>
            pendingBackendSet.has('runtime') ? neverSettles() : Promise.resolve({ reaped: true })
          ),
          shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
        },
        notebook: {
          dispose: vi.fn(() =>
            pendingBackendSet.has('notebook') ? neverSettles() : Promise.resolve({ reaped: true })
          ),
          shutdownAll: vi.fn(async () => ({ reaped: true }))
        }
      })
      const coordinator = new BackendShutdownCoordinator(deps)

      const pending = coordinator.runForQuit(25)
      await vi.advanceTimersByTimeAsync(25)

      await expect(pending).resolves.toEqual({ completed: false, reaped: false })
      for (const backend of ['runtime', 'notebook'] as const) {
        const assertion = expect(deps.log?.error)
        const expected = [
          'backend shutdown timed out',
          { backend, errorCategory: 'timeout' }
        ] as const
        if (pendingBackendSet.has(backend)) assertion.toHaveBeenCalledWith(...expected)
        else assertion.not.toHaveBeenCalledWith(...expected)
      }
    }
  )

  it.each([
    ['timeout', { completed: false, reaped: false }],
    ['degraded', { completed: true, reaped: false }]
  ] as const)(
    'converts a non-clean quit result into the fixed %s category',
    (expected, outcome) => {
      expect(() => BackendShutdownOutcomeError.assertClean(outcome)).toThrowError(
        expect.objectContaining({ outcome: expected })
      )
    }
  )
})
