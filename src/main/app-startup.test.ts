import { describe, expect, it, vi } from 'vitest'

import { createSecondInstanceRelay, orchestrateAppStartup } from './app-startup'

describe('createSecondInstanceRelay', () => {
  it('records a signal that arrives before bind and drains it on bind', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.signal()
    expect(handler).not.toHaveBeenCalled()

    relay.bind(handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('forwards a signal that arrives after bind directly to the handler', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.bind(handler)
    expect(handler).not.toHaveBeenCalled()

    relay.signal()
    relay.signal()
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('drains only once when bound, even if multiple signals arrived first', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.signal()
    relay.signal()
    relay.bind(handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('orchestrateAppStartup', () => {
  const makeDeps = (
    overrides: Partial<Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0]> = {}
  ): Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0] => {
    const showMainWindow = vi.fn()
    return {
      acquireSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      prepare: vi.fn(async () => ({ tag: 'ctx' })),
      installMigrationQuitGuard: vi.fn(),
      installAppLifecycle: vi.fn(() => ({ showMainWindow })),
      ...overrides
    }
  }

  it('quits and does no backend work when the lock is already held', async () => {
    const deps = makeDeps({ acquireSingleInstanceLock: vi.fn(() => false) })

    await orchestrateAppStartup(deps)

    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.installMigrationQuitGuard).not.toHaveBeenCalled()
    expect(deps.installAppLifecycle).not.toHaveBeenCalled()
  })

  it('installs the migration guard before the lifecycle for the primary instance', async () => {
    const deps = makeDeps()

    await orchestrateAppStartup(deps)

    expect(deps.quit).not.toHaveBeenCalled()
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    const guardOrder = vi.mocked(deps.installMigrationQuitGuard).mock.invocationCallOrder[0]
    const lifecycleOrder = vi.mocked(deps.installAppLifecycle).mock.invocationCallOrder[0]
    expect(guardOrder).toBeLessThan(lifecycleOrder)
    // The guard and lifecycle both receive the context produced by prepare.
    expect(deps.installMigrationQuitGuard).toHaveBeenCalledWith({ tag: 'ctx' })
    expect(deps.installAppLifecycle).toHaveBeenCalledWith({ tag: 'ctx' })
  })

  it('surfaces the window for a second instance that arrives during startup', async () => {
    const showMainWindow = vi.fn()
    let signalDuringStartup: () => void = () => {}
    const deps = makeDeps({
      // Capture the relay signal the lock is wired with, then fire it while prepare() is still running.
      acquireSingleInstanceLock: vi.fn(({ onSecondInstance }) => {
        signalDuringStartup = onSecondInstance
        return true
      }),
      prepare: vi.fn(async () => {
        signalDuringStartup()
        return { tag: 'ctx' }
      }),
      installAppLifecycle: vi.fn(() => ({ showMainWindow }))
    })

    await orchestrateAppStartup(deps)

    // The handoff arrived before the window existed; it must be drained once the lifecycle is installed.
    expect(showMainWindow).toHaveBeenCalledTimes(1)
  })

  it('routes a second instance that arrives after startup straight to the window', async () => {
    const showMainWindow = vi.fn()
    let signal: () => void = () => {}
    const deps = makeDeps({
      acquireSingleInstanceLock: vi.fn(({ onSecondInstance }) => {
        signal = onSecondInstance
        return true
      }),
      installAppLifecycle: vi.fn(() => ({ showMainWindow }))
    })

    await orchestrateAppStartup(deps)
    expect(showMainWindow).not.toHaveBeenCalled()

    signal()
    expect(showMainWindow).toHaveBeenCalledTimes(1)
  })
})
