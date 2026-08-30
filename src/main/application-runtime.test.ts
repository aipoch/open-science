import { describe, expect, it, vi } from 'vitest'

import {
  APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
  APPLICATION_SURFACE_SHUTDOWN_BUDGET_MS,
  composeApplicationRuntime,
  composeApplicationRuntimeWithAdapters,
  shutdownApplicationSurfaces,
  withApplicationRuntimeShutdown
} from './application-runtime'
import {
  BackendShutdownCoordinator,
  BackendShutdownOutcomeError,
  QUIT_SHUTDOWN_BUDGET_MS
} from './lifecycle-shutdown'
import { createApplicationEventModule } from './application-events'

describe('application runtime composition', () => {
  it('constructs and starts each module once through declared dependencies', async () => {
    const events: string[] = []

    const runtime = await composeApplicationRuntime(async (modules) => {
      const settings = await modules.add({ initialValue: 'managed' }, ({ initialValue }) => ({
        capability: { read: () => initialValue },
        start: () => {
          events.push('start:settings')
        },
        dispose: () => {
          events.push('dispose:settings')
        }
      }))
      const synthetic = await modules.add({ readSetting: settings.read }, ({ readSetting }) => ({
        capability: { describe: () => `synthetic:${readSetting()}` },
        start: () => {
          events.push('start:synthetic')
        },
        dispose: () => {
          events.push('dispose:synthetic')
        }
      }))

      return { settings, synthetic }
    })

    expect(runtime.interfaces.settings.read()).toBe('managed')
    expect(runtime.interfaces.synthetic.describe()).toBe('synthetic:managed')
    expect(events).toEqual(['start:settings', 'start:synthetic'])

    await runtime.dispose()
    await runtime.dispose()

    expect(events).toEqual([
      'start:settings',
      'start:synthetic',
      'dispose:synthetic',
      'dispose:settings'
    ])
  })

  it('disposes already-created modules in reverse order after partial construction failure', async () => {
    const events: string[] = []
    const failure = new Error('synthetic construction failed')

    await expect(
      composeApplicationRuntime(async (modules) => {
        await modules.add({}, () => ({
          capability: { name: 'first' },
          start: () => {
            events.push('start:first')
          },
          dispose: () => {
            events.push('dispose:first')
          }
        }))
        await modules.add({}, () => ({
          capability: { name: 'second' },
          start: () => {
            events.push('start:second')
          },
          dispose: () => {
            events.push('dispose:second')
          }
        }))
        await modules.add({}, () => {
          throw failure
        })
        return {}
      })
    ).rejects.toBe(failure)

    expect(events).toEqual(['start:first', 'start:second', 'dispose:second', 'dispose:first'])
  })

  it('releases a module whose startup fails before propagating the error', async () => {
    const dispose = vi.fn()
    const failure = new Error('start failed')

    await expect(
      composeApplicationRuntime(async (modules) => {
        await modules.add({}, () => ({
          capability: {},
          start: () => {
            throw failure
          },
          dispose
        }))
        return {}
      })
    ).rejects.toBe(failure)

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('uses rollback ownership only for failed composition', async () => {
    const rollback = vi.fn()
    const dispose = vi.fn()

    await expect(
      composeApplicationRuntime(async (modules) => {
        await modules.add({}, () => ({ capability: {}, rollback, dispose }))
        throw new Error('construction failed')
      })
    ).rejects.toThrow('construction failed')

    expect(rollback).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('attempts every disposer in reverse order when cleanup reports failures', async () => {
    const events: string[] = []
    const firstFailure = new Error('first disposal failed')
    const secondFailure = new Error('second disposal failed')

    const runtime = await composeApplicationRuntime(async (modules) => {
      await modules.add({}, () => ({
        capability: {},
        dispose: () => {
          events.push('dispose:first')
          throw firstFailure
        }
      }))
      await modules.add({}, () => ({
        capability: {},
        dispose: () => {
          events.push('dispose:second')
          throw secondFailure
        }
      }))
      return {}
    })

    const disposalError = await runtime.dispose().catch((error: unknown) => error)
    expect(disposalError).toMatchObject({
      errors: [secondFailure, firstFailure]
    })
    await expect(runtime.dispose()).rejects.toBe(disposalError)
    expect(events).toEqual(['dispose:second', 'dispose:first'])
  })

  it('bounds a hung module, reports its name, and continues reverse disposal', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    let rejectLate: ((error: Error) => void) | undefined

    try {
      const runtime = await composeApplicationRuntime(async (modules) => {
        await modules.add({}, () => ({
          name: 'settings',
          capability: {},
          dispose: () => {
            events.push('dispose:settings')
          }
        }))
        await modules.add({}, () => ({
          name: 'mcp-client-manager',
          capability: {},
          disposeTimeoutMs: 25,
          dispose: () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate = reject
            })
        }))
        return {}
      })

      const disposal = runtime.dispose().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(25)

      const error = await disposal
      expect(error).toMatchObject({
        errors: [
          expect.objectContaining({
            name: 'ApplicationModuleDisposalTimeoutError',
            moduleName: 'mcp-client-manager',
            timeoutMs: 25
          })
        ]
      })
      expect(events).toEqual(['dispose:settings'])

      // A timed-out disposer remains observed: a later transport rejection must not become unhandled.
      rejectLate?.(new Error('late MCP close failure'))
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('installs adapters from the completed production composition before exposing interfaces', async () => {
    const order: string[] = []
    const adapterInterfaces = { compute: {}, acp: {} }

    const runtime = await composeApplicationRuntimeWithAdapters(
      async (modules) => {
        const capability = await modules.add({}, () => ({
          name: 'runtime',
          capability: { ready: true },
          start: () => {
            order.push('start')
          },
          dispose: () => {
            order.push('dispose')
          }
        }))
        order.push('created')
        return { capability, electronAdapters: adapterInterfaces }
      },
      (adapters) => {
        expect(adapters).toBe(adapterInterfaces)
        order.push('install')
        return {
          uninstall: () => {
            order.push('uninstall')
          }
        }
      }
    )

    expect(runtime.interfaces).toEqual({ capability: { ready: true } })
    expect(order).toEqual(['start', 'created', 'install'])

    await runtime.dispose()
    expect(order).toEqual(['start', 'created', 'install', 'uninstall', 'dispose'])
  })

  it('keeps application event publication alive until later-owned backends finish disposal', async () => {
    const order: string[] = []
    let emitTerminalEvent = (): void => undefined

    const runtime = await composeApplicationRuntime(async (modules) => {
      const events = await modules.add((installedEvents) => {
        emitTerminalEvent = () =>
          installedEvents.publish('acp:event', [
            {
              id: 'event-1',
              timestamp: 100,
              kind: 'stop',
              level: 'info',
              sessionId: 'session-1',
              turnUsage: { inputTokens: 3, cacheTokens: 2, outputTokens: 1 }
            }
          ])
        return () => order.push('uninstall:application-events')
      }, createApplicationEventModule)
      events.subscribe((event) => {
        if (event.channel === 'acp:event') order.push(`event:${event.payload[0]?.kind}`)
      })
      await modules.add(undefined, () => ({
        capability: undefined,
        dispose: () => {
          order.push('dispose:backend')
          emitTerminalEvent()
        }
      }))
      return {}
    })

    await runtime.dispose()
    emitTerminalEvent()

    expect(order).toEqual(['dispose:backend', 'event:stop', 'uninstall:application-events'])
  })
})

describe('application surface shutdown', () => {
  it('waits for runtime disposal within its configured budget before closing later surfaces', async () => {
    vi.useFakeTimers()
    const order: string[] = []

    try {
      const shutdownCoordinator = new BackendShutdownCoordinator({
        runtime: {
          shutdownForQuit: async () => {
            order.push('application-runtime:start')
            await new Promise<void>((resolve) => setTimeout(resolve, 2000))
            order.push('application-runtime:end')
            return { reaped: true }
          },
          shutdownForUpdateGate: async () => ({ reaped: true })
        },
        notebook: {
          dispose: async () => ({ reaped: true }),
          shutdownAll: async () => ({ reaped: true })
        }
      })
      const runtime = await composeApplicationRuntime(async (modules) => {
        await modules.add({ shutdownCoordinator }, ({ shutdownCoordinator: coordinator }) => ({
          name: 'backend-shutdown-coordinator',
          capability: undefined,
          disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS + APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
          dispose: async () =>
            BackendShutdownOutcomeError.assertClean(await coordinator.runForQuit())
        }))
        return {}
      })

      const shutdown = shutdownApplicationSurfaces({
        disposeWebController: () => {
          order.push('web-controller')
        },
        disposeApplicationRuntime: () => runtime.dispose(),
        shutdownRemoteAccess: () => {
          order.push('remote-access')
        },
        disposeIpcHandlers: () => {
          order.push('ipc-handlers')
        }
      })

      await vi.advanceTimersByTimeAsync(1999)
      expect(order).toEqual(['web-controller', 'application-runtime:start'])

      await vi.advanceTimersByTimeAsync(1)
      await expect(shutdown).resolves.toBe('completed')
      expect(order).toEqual([
        'web-controller',
        'application-runtime:start',
        'application-runtime:end',
        'remote-access',
        'ipc-handlers'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserves completion time for IPC when Remote Access exhausts its final-surface share', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    let outcome: Awaited<ReturnType<typeof shutdownApplicationSurfaces>> | undefined

    try {
      void shutdownApplicationSurfaces({
        disposeWebController: vi.fn(),
        disposeApplicationRuntime: vi.fn(),
        shutdownRemoteAccess: () => new Promise<void>(() => undefined),
        disposeIpcHandlers: async () => {
          order.push('ipc-handlers:start')
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
          order.push('ipc-handlers:end')
        }
      }).then((result) => {
        outcome = result
      })

      await vi.advanceTimersByTimeAsync(APPLICATION_MODULE_DISPOSAL_BUDGET_MS / 2)
      expect(order).toEqual(['ipc-handlers:start'])

      await vi.advanceTimersByTimeAsync(1)
      expect(order).toEqual(['ipc-handlers:start', 'ipc-handlers:end'])
      expect(outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a hung surface and still attempts every later surface', async () => {
    vi.useFakeTimers()
    let outcome: Awaited<ReturnType<typeof shutdownApplicationSurfaces>> | undefined
    const order: string[] = []
    const disposeApplicationRuntime = vi.fn(() => {
      order.push('application-runtime')
    })
    const shutdownRemoteAccess = vi.fn(() => {
      order.push('remote-access')
    })
    const disposeIpcHandlers = vi.fn(() => {
      order.push('ipc-handlers')
    })

    try {
      void shutdownApplicationSurfaces({
        disposeApplicationRuntime,
        shutdownRemoteAccess,
        disposeWebController: () => {
          order.push('web-controller')
          return new Promise<void>(() => undefined)
        },
        disposeIpcHandlers
      }).then((result) => {
        outcome = result
      })

      await vi.advanceTimersByTimeAsync(APPLICATION_SURFACE_SHUTDOWN_BUDGET_MS)

      expect(outcome).toBe('timeout')
      expect(disposeApplicationRuntime).toHaveBeenCalledOnce()
      expect(shutdownRemoteAccess).toHaveBeenCalledOnce()
      expect(disposeIpcHandlers).toHaveBeenCalledOnce()
      expect(order).toEqual([
        'web-controller',
        'application-runtime',
        'remote-access',
        'ipc-handlers'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one ordered quit path from the composed backend through web surfaces', async () => {
    const order: string[] = []

    const lifecycle = withApplicationRuntimeShutdown(
      { marker: 'electron-lifecycle' },
      {
        disposeApplicationRuntime: () => {
          order.push('application-runtime')
        },
        remoteAccess: {
          shutdown: () => {
            order.push('remote-access')
          }
        },
        webController: {
          dispose: () => {
            order.push('web-controller')
          }
        },
        disposeIpcHandlers: () => {
          order.push('ipc-handlers')
        }
      }
    )
    await expect(lifecycle.shutdownBackends()).resolves.toBe('completed')

    expect(lifecycle.marker).toBe('electron-lifecycle')
    expect(order).toEqual([
      'web-controller',
      'application-runtime',
      'remote-access',
      'ipc-handlers'
    ])
  })

  it('diagnoses runtime failure and continues closing surfaces without rejecting lifecycle', async () => {
    const failure = new Error('backend shutdown failed')
    const shutdownRemoteAccess = vi.fn()
    const disposeWebController = vi.fn()
    const disposeIpcHandlers = vi.fn()
    const log = { error: vi.fn() }

    await expect(
      shutdownApplicationSurfaces({
        disposeApplicationRuntime: () => Promise.reject(failure),
        shutdownRemoteAccess,
        disposeWebController,
        disposeIpcHandlers,
        log
      })
    ).resolves.toBe('failed')

    expect(log.error).toHaveBeenCalledWith('application surface shutdown failed', {
      surface: 'application-runtime',
      result: 'failed',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('backend shutdown failed')
    expect(shutdownRemoteAccess).toHaveBeenCalledOnce()
    expect(disposeWebController).toHaveBeenCalledOnce()
    expect(disposeIpcHandlers).toHaveBeenCalledOnce()
  })

  it('continues closing surfaces when the shutdown diagnostic sink throws', async () => {
    const shutdownRemoteAccess = vi.fn()
    const disposeWebController = vi.fn()
    const disposeIpcHandlers = vi.fn()

    await expect(
      shutdownApplicationSurfaces({
        disposeApplicationRuntime: () => Promise.reject(new Error('runtime failure')),
        shutdownRemoteAccess,
        disposeWebController,
        disposeIpcHandlers,
        log: {
          error: () => {
            throw new Error('sink failure')
          }
        }
      })
    ).resolves.toBe('failed')

    expect(shutdownRemoteAccess).toHaveBeenCalledOnce()
    expect(disposeWebController).toHaveBeenCalledOnce()
    expect(disposeIpcHandlers).toHaveBeenCalledOnce()
  })

  it.each([
    ['timeout', 'timeout'],
    ['degraded', 'degraded']
  ] as const)(
    'preserves the fixed %s backend outcome without logging raw error details',
    async (backendOutcome, expected) => {
      const log = { error: vi.fn() }

      await expect(
        shutdownApplicationSurfaces({
          disposeApplicationRuntime: () =>
            Promise.reject(new BackendShutdownOutcomeError(expected)),
          shutdownRemoteAccess: vi.fn(),
          disposeWebController: vi.fn(),
          disposeIpcHandlers: vi.fn(),
          log
        })
      ).resolves.toBe(backendOutcome)

      expect(log.error).toHaveBeenCalledWith('application surface shutdown failed', {
        surface: 'application-runtime',
        result: expected,
        errorCategory: 'object'
      })
      expect(JSON.stringify(log.error.mock.calls)).not.toContain('Backend shutdown')
    }
  )
})
