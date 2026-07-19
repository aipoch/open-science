import { describe, expect, it, vi } from 'vitest'

import { createSecondInstanceRelay, orchestrateAppStartup } from './app-startup'

describe('createSecondInstanceRelay', () => {
  it('records a signal that arrives before bind and drains it on bind, with its argv', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.signal(['app', '--serve=44100'])
    expect(handler).not.toHaveBeenCalled()

    relay.bind(handler)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(['app', '--serve=44100'])
  })

  it('forwards a signal that arrives after bind directly to the handler', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.bind(handler)
    expect(handler).not.toHaveBeenCalled()

    relay.signal(['app'])
    relay.signal(['app', '--serve'])
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(2, ['app', '--serve'])
  })

  it('drains every queued signal in arrival order when bound', () => {
    const relay = createSecondInstanceRelay()
    const handler = vi.fn()

    relay.signal(['app', 'first'])
    relay.signal(['app', 'second'])
    relay.bind(handler)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(1, ['app', 'first'])
    expect(handler).toHaveBeenNthCalledWith(2, ['app', 'second'])
  })
})

describe('orchestrateAppStartup', () => {
  const makeDeps = (
    overrides: Partial<Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0]> = {}
  ): Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0] => {
    const onSecondInstance = vi.fn()
    return {
      acquireSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      prepare: vi.fn(async () => ({ tag: 'ctx' })),
      installMigrationQuitGuard: vi.fn(),
      installAppLifecycle: vi.fn(() => ({ onSecondInstance })),
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

  it('drains a second instance that arrives during startup, forwarding its argv', async () => {
    const onSecondInstance = vi.fn()
    let signalDuringStartup: (argv: string[]) => void = () => {}
    const deps = makeDeps({
      // Capture the relay signal the lock is wired with, then fire it while prepare() is still running.
      acquireSingleInstanceLock: vi.fn(({ onSecondInstance: signal }) => {
        signalDuringStartup = signal
        return true
      }),
      prepare: vi.fn(async () => {
        signalDuringStartup(['app', '--serve=44100'])
        return { tag: 'ctx' }
      }),
      installAppLifecycle: vi.fn(() => ({ onSecondInstance }))
    })

    await orchestrateAppStartup(deps)

    // The handoff arrived before the lifecycle existed; it must be drained once it is installed.
    expect(onSecondInstance).toHaveBeenCalledTimes(1)
    expect(onSecondInstance).toHaveBeenCalledWith(['app', '--serve=44100'])
  })

  it('routes a second instance that arrives after startup straight to the lifecycle handler', async () => {
    const onSecondInstance = vi.fn()
    let signal: (argv: string[]) => void = () => {}
    const deps = makeDeps({
      acquireSingleInstanceLock: vi.fn(({ onSecondInstance: relaySignal }) => {
        signal = relaySignal
        return true
      }),
      installAppLifecycle: vi.fn(() => ({ onSecondInstance }))
    })

    await orchestrateAppStartup(deps)
    expect(onSecondInstance).not.toHaveBeenCalled()

    signal(['app'])
    expect(onSecondInstance).toHaveBeenCalledWith(['app'])
  })
})
