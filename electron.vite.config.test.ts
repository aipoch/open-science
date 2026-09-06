import { afterEach, describe, expect, it, vi } from 'vitest'

import config from './electron.vite.config'

const resolve = config as (input: { command: 'serve' | 'build'; mode: string }) => {
  main?: { define?: Record<string, string> }
  renderer?: { optimizeDeps?: { force?: boolean } }
}

describe('electron Vite renderer configuration', () => {
  it('forces dependency optimization for every development-server start', () => {
    const rendererConfig = resolve({ command: 'serve', mode: 'development' }).renderer

    expect(rendererConfig?.optimizeDeps?.force).toBe(true)
  })

  it('compiles the WSL2 development switch into serve only and never into a build', () => {
    vi.stubEnv('OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW', '1')
    expect(resolve({ command: 'serve', mode: 'development' }).main?.define).toMatchObject({
      __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: 'true'
    })
    expect(resolve({ command: 'build', mode: 'production' }).main?.define).toMatchObject({
      __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: 'false'
    })
  })

  it('keeps the WSL2 development switch off unless its exact opt-in value is present', () => {
    vi.stubEnv('OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW', 'true')

    expect(resolve({ command: 'serve', mode: 'development' }).main?.define).toMatchObject({
      __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: 'false'
    })
  })
})

afterEach(() => vi.unstubAllEnvs())
