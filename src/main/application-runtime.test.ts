import { describe, expect, it, vi } from 'vitest'

import { composeApplicationRuntime, shutdownApplicationSurfaces } from './application-runtime'

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
})

describe('application surface shutdown', () => {
  it('keeps one ordered quit path from the composed backend through web surfaces', async () => {
    const order: string[] = []

    await shutdownApplicationSurfaces({
      disposeApplicationRuntime: () => {
        order.push('application-runtime')
      },
      shutdownRemoteAccess: () => {
        order.push('remote-access')
      },
      closeWebController: () => {
        order.push('web-controller')
      },
      disposeWebRpc: () => {
        order.push('web-rpc')
      }
    })

    expect(order).toEqual(['application-runtime', 'remote-access', 'web-controller', 'web-rpc'])
  })

  it('continues closing surfaces when application runtime disposal rejects', async () => {
    const failure = new Error('backend shutdown failed')
    const shutdownRemoteAccess = vi.fn()
    const closeWebController = vi.fn()
    const disposeWebRpc = vi.fn()

    await expect(
      shutdownApplicationSurfaces({
        disposeApplicationRuntime: () => Promise.reject(failure),
        shutdownRemoteAccess,
        closeWebController,
        disposeWebRpc
      })
    ).rejects.toBe(failure)

    expect(shutdownRemoteAccess).toHaveBeenCalledOnce()
    expect(closeWebController).toHaveBeenCalledOnce()
    expect(disposeWebRpc).toHaveBeenCalledOnce()
  })
})
