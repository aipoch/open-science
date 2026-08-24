import { describe, expect, it, vi } from 'vitest'

import {
  GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR,
  GITHUB_ELECTRON_MIRROR,
  npmCiCommand,
  npmCiEnv,
  runNpmCi,
  shouldForceGitHubElectronMirrors
} from './npm-ci.mjs'

describe('npm ci Electron mirror policy', () => {
  it('forces GitHub Electron artifact URLs on GitHub Actions', () => {
    const env = npmCiEnv({
      GITHUB_ACTIONS: 'true',
      npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
      PATH: '/usr/bin'
    })

    expect(shouldForceGitHubElectronMirrors({ GITHUB_ACTIONS: 'true' })).toBe(true)
    expect(env.npm_config_electron_mirror).toBe(GITHUB_ELECTRON_MIRROR)
    expect(env.npm_config_electron_builder_binaries_mirror).toBe(
      GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR
    )
    expect(env.ELECTRON_MIRROR).toBe(GITHUB_ELECTRON_MIRROR)
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe(GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('leaves local installs on the repository npmmirror pin', () => {
    const env = npmCiEnv({
      npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
      PATH: '/usr/bin'
    })

    expect(shouldForceGitHubElectronMirrors({})).toBe(false)
    expect(env.npm_config_electron_mirror).toBe('https://npmmirror.com/mirrors/electron/')
    expect(env.ELECTRON_MIRROR).toBeUndefined()
  })

  it('runs npm ci with the resolved environment and platform command', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    expect(
      runNpmCi({
        args: ['--no-audit'],
        env: { GITHUB_ACTIONS: 'true' },
        platform: 'linux',
        spawn
      })
    ).toBe(0)
    expect(npmCiCommand('linux')).toBe('npm')
    expect(npmCiCommand('win32')).toBe('npm.cmd')
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['ci', '--no-audit'],
      expect.objectContaining({
        env: expect.objectContaining({
          npm_config_electron_mirror: GITHUB_ELECTRON_MIRROR
        }),
        shell: false,
        stdio: 'inherit'
      })
    )
  })
})
