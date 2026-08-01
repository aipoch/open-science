import { describe, expect, it, vi } from 'vitest'

import { composeApplicationRuntime } from './application-runtime'

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
      const synthetic = await modules.add(
        { readSetting: settings.read },
        ({ readSetting }) => ({
          capability: { describe: () => `synthetic:${readSetting()}` },
          start: () => {
            events.push('start:synthetic')
          },
          dispose: () => {
            events.push('dispose:synthetic')
          }
        })
      )

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

    expect(events).toEqual([
      'start:first',
      'start:second',
      'dispose:second',
      'dispose:first'
    ])
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
})
