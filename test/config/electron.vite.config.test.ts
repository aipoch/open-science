import { afterEach, describe, expect, it, vi } from 'vitest'

import config, { resolveWsl2BashPreviewBuildEnabled } from '../../electron.vite.config'
import { wsl2BuildDefines } from '../../scripts/wsl2-build-flags.mjs'

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

describe('WSL2 Bash Preview build admission', () => {
  it('keeps the Node and desktop build policies identical, including rollback and development', () => {
    for (const command of ['serve', 'build'] as const) {
      for (const rollback of ['0', '1']) {
        vi.stubEnv('OPEN_SCIENCE_BUILD_WSL2_BASH_PREVIEW', rollback)
        vi.stubEnv('OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW', '1')
        const flags = wsl2BuildDefines(process.platform, command === 'serve', process.env)
        expect(resolve({ command, mode: 'development' }).main?.define).toMatchObject(flags)
        expect(flags.__OPEN_SCIENCE_WSL2_BASH_PREVIEW__).toBe(
          String(process.platform === 'win32' && rollback !== '0')
        )
        expect(flags.__OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__).toBe(
          String(command === 'serve')
        )
      }
    }
  })

  it('enables Windows builds unless the rollback switch is set', () => {
    expect(resolveWsl2BashPreviewBuildEnabled('win32', undefined)).toBe(true)
    expect(resolveWsl2BashPreviewBuildEnabled('win32', '1')).toBe(true)
    expect(resolveWsl2BashPreviewBuildEnabled('win32', '0')).toBe(false)
  })

  it.each(['darwin', 'linux'] as const)(
    'keeps %s builds disabled even when the rollback switch is not set',
    (platform) => {
      expect(resolveWsl2BashPreviewBuildEnabled(platform, undefined)).toBe(false)
      expect(resolveWsl2BashPreviewBuildEnabled(platform, '1')).toBe(false)
    }
  )
})

afterEach(() => vi.unstubAllEnvs())
