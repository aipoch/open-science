import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
      PATH: '/usr/bin'
    })

    expect(shouldForceGitHubElectronMirrors({ GITHUB_ACTIONS: 'true' })).toBe(true)
    expect(env.ELECTRON_MIRROR).toBe(GITHUB_ELECTRON_MIRROR)
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe(GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR)
    expect(env).not.toHaveProperty('npm_config_electron_mirror')
    expect(env).not.toHaveProperty('npm_config_electron_builder_binaries_mirror')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('preserves caller-provided local mirror environment', () => {
    const env = npmCiEnv({
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      PATH: '/usr/bin'
    })

    expect(shouldForceGitHubElectronMirrors({})).toBe(false)
    expect(env.ELECTRON_MIRROR).toBe('https://npmmirror.com/mirrors/electron/')
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
        env: expect.objectContaining({ ELECTRON_MIRROR: GITHUB_ELECTRON_MIRROR }),
        shell: false,
        stdio: 'inherit'
      })
    )
  })

  it('routes Electron-installing workflow npm ci through the GitHub mirror helper', () => {
    const workflowDir = join(process.cwd(), '.github', 'workflows')
    const leftover: string[] = []
    for (const name of readdirSync(workflowDir).filter((file) => file.endsWith('.yml'))) {
      const text = readFileSync(join(workflowDir, name), 'utf8')
      for (const [lineNumber, line] of text.split('\n').entries()) {
        const match = line.match(/^\s+run:\s*(npm ci.*)$/)
        if (!match) continue
        if (match[1].includes('--ignore-scripts')) continue
        leftover.push(`${name}:${lineNumber + 1}: ${match[1]}`)
      }
    }
    expect(leftover).toEqual([])
  })
})
