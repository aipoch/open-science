import { EventEmitter } from 'node:events'

import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  createSecondInstanceRelay,
  createStartupWindowCloseOptions,
  createStartupWindowSecondInstanceHandler,
  orchestrateAppStartup,
  prepareVisibleStartupRuntime,
  waitForStartupShell
} from './app-startup'

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((next) => {
      resolve = next
    }),
    resolve
  }
}

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

  it('surfaces an existing startup window for a second launch', () => {
    const forward = vi.fn()
    const window = {
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn()
    }

    createStartupWindowSecondInstanceHandler(window, forward)(['app', '--serve=44100'])

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(forward).toHaveBeenCalledWith(['app', '--serve=44100'])
  })

  it('allows the startup window to close after it requests app quit', () => {
    const quit = vi.fn()
    const options = createStartupWindowCloseOptions(quit)

    expect(options.classifyClose()).toBe('quit')
    options.requestQuit()

    expect(quit).toHaveBeenCalledOnce()
    expect(options.classifyClose()).toBe('close')
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
    const markReady = vi.fn()
    const deps = makeDeps({ markReady })

    await orchestrateAppStartup(deps)

    expect(deps.quit).not.toHaveBeenCalled()
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    const guardOrder = vi.mocked(deps.installMigrationQuitGuard).mock.invocationCallOrder[0]
    const lifecycleOrder = vi.mocked(deps.installAppLifecycle).mock.invocationCallOrder[0]
    const readyOrder = markReady.mock.invocationCallOrder[0]
    expect(guardOrder).toBeLessThan(lifecycleOrder)
    expect(lifecycleOrder).toBeLessThan(readyOrder)
    // The guard and lifecycle both receive the context produced by prepare.
    expect(deps.installMigrationQuitGuard).toHaveBeenCalledWith({ tag: 'ctx' })
    expect(deps.installAppLifecycle).toHaveBeenCalledWith({ tag: 'ctx' })
    expect(markReady).toHaveBeenCalledWith({ tag: 'ctx' })
  })

  it('queues a system shutdown requested during prepare until the lifecycle owner is installed', async () => {
    const events: string[] = []
    const onSystemShutdown = vi.fn(() => events.push('shutdown'))
    const onSecondInstance = vi.fn()
    let requestSystemShutdown = (): void => {}
    const installSystemShutdownListeners = vi.fn((request: () => void) => {
      requestSystemShutdown = request
    })
    const deps = {
      ...makeDeps({
        prepare: vi.fn(async () => {
          requestSystemShutdown()
          expect(onSystemShutdown).not.toHaveBeenCalled()
          return { tag: 'ctx' }
        }),
        installAppLifecycle: vi.fn(() => ({ onSecondInstance, onSystemShutdown })),
        markReady: vi.fn(() => events.push('ready'))
      }),
      installSystemShutdownListeners
    } as Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0]

    await orchestrateAppStartup(deps)

    expect(installSystemShutdownListeners).toHaveBeenCalledOnce()
    expect(onSystemShutdown).toHaveBeenCalledOnce()
    expect(events).toEqual(['ready', 'shutdown'])
    const listenersOrder = installSystemShutdownListeners.mock.invocationCallOrder[0]
    const prepareOrder = vi.mocked(deps.prepare).mock.invocationCallOrder[0]
    expect(listenersOrder).toBeLessThan(prepareOrder)
  })

  it('forces exit when system shutdown is requested while prepare remains blocked', async () => {
    vi.useFakeTimers()
    try {
      const preparation = deferred<{ tag: string }>()
      const forceExit = vi.fn()
      let requestSystemShutdown = (): void => {}
      const deps = {
        ...makeDeps({ prepare: vi.fn(() => preparation.promise) }),
        installSystemShutdownListeners: (request: () => void) => {
          requestSystemShutdown = request
        },
        forceExit,
        startupSystemShutdownTimeoutMs: 25
      } as Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0]

      void orchestrateAppStartup(deps)
      requestSystemShutdown()
      await vi.advanceTimersByTimeAsync(25)

      expect(forceExit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
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

  it('terminalizes startup diagnostics at the phase that rejects without changing the failure', async () => {
    const failure = new Error('backend import failed')
    const diagnostics = {
      phase: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      fail: vi.fn()
    }
    const deps = makeDeps({
      prepare: vi.fn(async () => {
        throw failure
      }),
      diagnostics
    })

    await expect(orchestrateAppStartup(deps)).rejects.toBe(failure)

    expect(diagnostics.phase).toHaveBeenCalledWith('prepare-runtime')
    expect(diagnostics.fail).toHaveBeenCalledWith(failure)
    expect(diagnostics.complete).not.toHaveBeenCalled()
  })

  it('cleans the prepared runtime before rejecting a post-composition startup failure', async () => {
    const failure = new Error('mark ready failed')
    const cleanup = deferred<void>()
    const events: string[] = []
    const deps = makeDeps({
      markReady: vi.fn(() => {
        throw failure
      }),
      cleanupAfterStartupFailure: vi.fn(async () => {
        events.push('cleanup:start')
        await cleanup.promise
        events.push('cleanup:end')
      })
    })

    const startupOutcome = orchestrateAppStartup(deps).then(
      () => undefined,
      (error: unknown) => {
        events.push('startup:rejected')
        return error
      }
    )

    await vi.waitFor(() => expect(events).toEqual(['cleanup:start']))
    cleanup.resolve()

    await expect(startupOutcome).resolves.toBe(failure)
    expect(events).toEqual(['cleanup:start', 'cleanup:end', 'startup:rejected'])
    expect(deps.cleanupAfterStartupFailure).toHaveBeenCalledWith({ tag: 'ctx' }, failure)
  })

  it('cancels the startup system-shutdown fallback before failure cleanup', async () => {
    vi.useFakeTimers()
    try {
      const failure = new Error('mark ready failed')
      const cleanup = deferred<void>()
      const cleanupStarted = deferred<void>()
      const forceExit = vi.fn()
      let requestSystemShutdown = (): void => {}
      const deps = {
        ...makeDeps({
          prepare: vi.fn(async () => {
            requestSystemShutdown()
            return { tag: 'ctx' }
          }),
          markReady: vi.fn(() => {
            throw failure
          }),
          cleanupAfterStartupFailure: vi.fn(() => {
            cleanupStarted.resolve()
            return cleanup.promise
          })
        }),
        installSystemShutdownListeners: (request: () => void) => {
          requestSystemShutdown = request
        },
        forceExit,
        startupSystemShutdownTimeoutMs: 25
      } as Parameters<typeof orchestrateAppStartup<{ tag: string }>>[0]

      const startupOutcome = orchestrateAppStartup(deps).then(
        () => undefined,
        (error: unknown) => error
      )
      await cleanupStarted.promise
      await vi.advanceTimersByTimeAsync(25)

      expect(forceExit).not.toHaveBeenCalled()
      cleanup.resolve()
      await expect(startupOutcome).resolves.toBe(failure)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('prepareVisibleStartupRuntime', () => {
  it('loads the backend while database verification runs, then composes only after both finish', async () => {
    const shellReady = deferred<{ tag: 'shell' }>()
    const databaseReady = deferred<void>()
    const modulesReady = deferred<{ tag: 'modules' }>()
    const events: string[] = []

    const preparation = prepareVisibleStartupRuntime({
      prepareShell: vi.fn(async () => {
        events.push('shell:start')
        const shell = await shellReady.promise
        events.push('shell:ready')
        return shell
      }),
      verifyDatabase: vi.fn(async () => {
        events.push('database:start')
        await databaseReady.promise
        events.push('database:ready')
      }),
      loadApplicationModules: vi.fn(async () => {
        events.push('modules:start')
        const modules = await modulesReady.promise
        events.push('modules:ready')
        return modules
      }),
      composeRuntime: vi.fn(async (_shell, modules) => {
        events.push('runtime:ready')
        return modules.tag
      })
    })

    expect(events).toEqual(['shell:start'])
    shellReady.resolve({ tag: 'shell' })
    await vi.waitFor(() => {
      expect(events).toEqual(['shell:start', 'shell:ready', 'database:start', 'modules:start'])
    })

    modulesReady.resolve({ tag: 'modules' })
    await vi.waitFor(() => expect(events).toContain('modules:ready'))
    expect(events).not.toContain('runtime:ready')

    databaseReady.resolve()
    await expect(preparation).resolves.toBe('modules')
    expect(events).toEqual([
      'shell:start',
      'shell:ready',
      'database:start',
      'modules:start',
      'modules:ready',
      'database:ready',
      'runtime:ready'
    ])
  })

  it('rolls back the visible shell when a concurrent prerequisite fails', async () => {
    const failure = new Error('backend import failed')
    const rollbackShell = vi.fn()

    await expect(
      prepareVisibleStartupRuntime({
        prepareShell: async () => ({ tag: 'shell' }),
        verifyDatabase: async () => undefined,
        loadApplicationModules: async () => {
          throw failure
        },
        composeRuntime: vi.fn(),
        rollbackShell
      })
    ).rejects.toBe(failure)

    expect(rollbackShell).toHaveBeenCalledOnce()
    expect(rollbackShell).toHaveBeenCalledWith({ tag: 'shell' }, failure)
  })
})

describe('waitForStartupShell', () => {
  const makeWindow = (): {
    destroy: ReturnType<typeof vi.fn>
    emitWindow: (event: string) => void
    emitWebContents: (event: string, ...args: unknown[]) => void
    windowListenerCount: (event: string) => number
    webContentsListenerCount: (event: string) => number
    window: Pick<BrowserWindow, 'destroy' | 'once' | 'removeListener' | 'webContents'>
  } => {
    const windowEvents = new EventEmitter()
    const webContentsEvents = new EventEmitter()
    const destroy = vi.fn()
    return {
      destroy,
      emitWindow: (event) => windowEvents.emit(event),
      emitWebContents: (event, ...args) => webContentsEvents.emit(event, ...args),
      windowListenerCount: (event) => windowEvents.listenerCount(event),
      webContentsListenerCount: (event) => webContentsEvents.listenerCount(event),
      window: Object.assign(windowEvents, {
        destroy,
        webContents: webContentsEvents
      }) as unknown as Pick<BrowserWindow, 'destroy' | 'once' | 'removeListener' | 'webContents'>
    }
  }

  it('waits through subframe failures and resolves after the first paint', async () => {
    const source = makeWindow()
    const settled = vi.fn()
    void waitForStartupShell(source.window).then(settled)

    source.emitWebContents('did-fail-load', {}, -3, 'ABORTED', 'preview://frame', false)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    source.emitWindow('ready-to-show')
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(source.destroy).not.toHaveBeenCalled()
  })

  it('discards an unusable startup window after a main-frame load failure', async () => {
    const source = makeWindow()
    const settled = vi.fn()
    void waitForStartupShell(source.window).then(settled)

    source.emitWebContents('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file://index', true)

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(source.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'a renderer exit',
      (source: ReturnType<typeof makeWindow>) =>
        source.emitWebContents('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    ],
    [
      'the startup window closing',
      (source: ReturnType<typeof makeWindow>) => source.emitWindow('closed')
    ]
  ])('continues startup after %s', async (_label, signal) => {
    const source = makeWindow()
    const settled = vi.fn()
    void waitForStartupShell(source.window).then(settled)

    signal(source)

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(source.destroy).not.toHaveBeenCalled()
  })

  it('discards a silent startup window after a bounded wait', async () => {
    vi.useFakeTimers()
    try {
      const source = makeWindow()
      const settled = vi.fn()
      const diagnostics = { phase: vi.fn() }
      void waitForStartupShell(source.window, { diagnostics }).then(settled)

      await vi.advanceTimersByTimeAsync(15_000)

      expect(settled).toHaveBeenCalledOnce()
      expect(source.destroy).toHaveBeenCalledOnce()
      expect(diagnostics.phase).toHaveBeenCalledOnce()
      expect(diagnostics.phase).toHaveBeenCalledWith('startup-shell-timeout', {
        timeoutMs: 15_000
      })
      expect(source.windowListenerCount('ready-to-show')).toBe(0)
      expect(source.windowListenerCount('closed')).toBe(0)
      expect(source.webContentsListenerCount('did-fail-load')).toBe(0)
      expect(source.webContentsListenerCount('render-process-gone')).toBe(0)

      source.emitWindow('ready-to-show')
      source.emitWindow('closed')
      source.emitWebContents('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file://index', true)
      source.emitWebContents('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      await Promise.resolve()

      expect(settled).toHaveBeenCalledOnce()
      expect(source.destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
