import { describe, expect, it, vi } from 'vitest'

import {
  composeApplicationRuntime,
  composeApplicationRuntimeWithAdapters,
  shutdownApplicationSurfaces,
  withApplicationRuntimeShutdown
} from './application-runtime'

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
      }
    )

    expect(runtime.interfaces).toEqual({ capability: { ready: true } })
    expect(order).toEqual(['start', 'created', 'install'])

    await runtime.dispose()
    expect(order).toEqual(['start', 'created', 'install', 'dispose'])
  })
})

describe('application surface shutdown', () => {
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
          close: () => {
            order.push('web-controller')
          }
        },
        webRpc: {
          dispose: () => {
            order.push('web-rpc')
          }
        }
      }
    )
    await lifecycle.shutdownBackends()

    expect(lifecycle.marker).toBe('electron-lifecycle')
    expect(order).toEqual(['application-runtime', 'remote-access', 'web-controller', 'web-rpc'])
  })

  it('diagnoses runtime failure and continues closing surfaces without rejecting lifecycle', async () => {
    const failure = new Error('backend shutdown failed')
    const shutdownRemoteAccess = vi.fn()
    const closeWebController = vi.fn()
    const disposeWebRpc = vi.fn()
    const log = { error: vi.fn() }

    await expect(
      shutdownApplicationSurfaces({
        disposeApplicationRuntime: () => Promise.reject(failure),
        shutdownRemoteAccess,
        closeWebController,
        disposeWebRpc,
        log
      })
    ).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalledWith(
      'application runtime disposal failed during application shutdown: Error: backend shutdown failed',
      failure
    )
    expect(shutdownRemoteAccess).toHaveBeenCalledOnce()
    expect(closeWebController).toHaveBeenCalledOnce()
    expect(disposeWebRpc).toHaveBeenCalledOnce()
  })
})
