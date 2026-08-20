import { describe, expect, it, vi } from 'vitest'

import { loadSettingsPanel } from './settings-panel-loader'

describe('Settings panel loader', () => {
  it('starts code and data together and waits for both before revealing the panel', async () => {
    let finishModule!: (module: { Panel: string }) => void
    let finishPreload!: () => void
    const loadModule = vi.fn(
      () => new Promise<{ Panel: string }>((resolve) => (finishModule = resolve))
    )
    const preload = vi.fn(() => new Promise<void>((resolve) => (finishPreload = resolve)))

    let settled = false
    const request = loadSettingsPanel(loadModule, preload).then((module) => {
      settled = true
      return module
    })
    await Promise.resolve()

    expect(loadModule).toHaveBeenCalledOnce()
    expect(preload).toHaveBeenCalledOnce()
    finishModule({ Panel: 'ready' })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishPreload()
    await expect(request).resolves.toEqual({ Panel: 'ready' })
  })

  it('lets the panel render its own retry UI when data preload fails', async () => {
    const module = { Panel: 'ready' }

    await expect(
      loadSettingsPanel(
        () => Promise.resolve(module),
        () => Promise.reject(new Error('data unavailable'))
      )
    ).resolves.toBe(module)
  })

  it('keeps chunk failures observable by the Settings error boundary', async () => {
    await expect(
      loadSettingsPanel(
        () => Promise.reject(new Error('chunk unavailable')),
        () => Promise.resolve()
      )
    ).rejects.toThrow('chunk unavailable')
  })
})
