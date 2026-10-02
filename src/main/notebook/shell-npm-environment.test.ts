import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  prepareNotebookWorkloadCache,
  removeNotebookWorkloadCache
} from './notebook-workload-cache-paths'
import {
  prepareShellNpmEnvironment,
  shellNpmPaths,
  shellNpmReadRoots
} from './shell-npm-environment'

describe('managed shell npm storage', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shell-npm-'))
    prepareNotebookWorkloadCache(root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it.skipIf(process.platform === 'win32')(
    'reads only the physical npm package behind a POSIX PATH launcher',
    () => {
      const bin = join(root, 'node', 'bin')
      const npmRoot = join(root, 'node', 'lib', 'node_modules', 'npm')
      mkdirSync(bin, { recursive: true })
      mkdirSync(join(npmRoot, 'bin'), { recursive: true })
      writeFileSync(join(npmRoot, 'bin', 'npm-cli.js'), '#!/usr/bin/env node\n', {
        mode: 0o755
      })
      symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'))
      for (const platform of ['darwin', 'linux'] as const) {
        expect(shellNpmReadRoots({ PATH: bin }, platform)).toEqual([realpathSync.native(npmRoot)])
      }
      expect(shellNpmReadRoots({ PATH: bin }, 'win32')).toEqual([])
      const shadow = join(root, 'shadow')
      mkdirSync(shadow)
      writeFileSync(join(shadow, 'npm'), '#!/bin/sh\n', { mode: 0o755 })
      expect(shellNpmReadRoots({ PATH: `${shadow}:${bin}` }, 'darwin')).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not authorize arbitrary npm symlink targets or missing launchers',
    () => {
      const cli = join(root, 'npm-cli.js')
      writeFileSync(cli, '#!/usr/bin/env node\n', { mode: 0o755 })
      symlinkSync(cli, join(root, 'npm'))
      expect(shellNpmReadRoots({ PATH: root }, 'darwin')).toEqual([])
      expect(shellNpmReadRoots({}, 'darwin')).toEqual([])
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'shares %s global tools across launches while keeping them outside disposable cache',
    (platform) => {
      const first = prepareShellNpmEnvironment(root, platform, { PATH: 'existing-path' })
      writeFileSync(join(first.NPM_CONFIG_PREFIX!, 'installed-package'), 'retained')
      writeFileSync(join(first.NPM_CONFIG_CACHE!, 'download'), 'disposable')
      expect(removeNotebookWorkloadCache(root)).toBe(true)
      prepareNotebookWorkloadCache(root)
      const second = prepareShellNpmEnvironment(root, platform, { PATH: 'existing-path' })
      expect(second).toEqual(first)
      expect(readFileSync(join(second.NPM_CONFIG_PREFIX!, 'installed-package'), 'utf8')).toBe(
        'retained'
      )
      expect(existsSync(join(second.NPM_CONFIG_CACHE!, 'download'))).toBe(false)
      const paths = shellNpmPaths(root, platform)
      expect(second.PATH).toBe(`${paths.bin}${platform === 'win32' ? ';' : ':'}existing-path`)
      expect(second.NPM_CONFIG_GLOBAL).toBeUndefined()
      expect(second.OPEN_SCIENCE_CANONICAL_NPM_PREFIX).toBe(
        platform === 'win32' ? realpathSync.native(paths.prefix) : undefined
      )
    }
  )

  it('separates native Windows and WSL Linux installations', () => {
    const windows = prepareShellNpmEnvironment(root, 'win32', {})
    const linux = prepareShellNpmEnvironment(root, 'linux', {})
    expect(windows.NPM_CONFIG_PREFIX).not.toBe(linux.NPM_CONFIG_PREFIX)
    expect(windows.NPM_CONFIG_CACHE).not.toBe(linux.NPM_CONFIG_CACHE)
  })

  it('replaces differently cased destination overrides in frozen launch environments', () => {
    const env = prepareShellNpmEnvironment(root, 'linux', {
      npm_config_prefix: '/host-global',
      Npm_Config_Cache: '/host-cache',
      OPEN_SCIENCE_CANONICAL_NPM_PREFIX: '/host-prefix',
      KEEP: 'retained'
    })
    expect(env.npm_config_prefix).toBeUndefined()
    expect(env.Npm_Config_Cache).toBeUndefined()
    expect(env.OPEN_SCIENCE_CANONICAL_NPM_PREFIX).toBeUndefined()
    expect(env.KEEP).toBe('retained')
    expect(env.NPM_CONFIG_PREFIX).toBe(shellNpmPaths(root, 'linux').prefix)
  })

  it.each(['npm', `npm/${process.platform}-${process.arch}`, 'cache/notebook/npm'])(
    'rejects a redirected %s directory before granting write access',
    (relative) => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      const parts = relative.split('/')
      const link = join(root, ...parts)
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => prepareShellNpmEnvironment(root, process.platform, {})).toThrow(
        'not a trusted directory'
      )
      expect(existsSync(join(outside, `${process.platform}-${process.arch}`))).toBe(false)
    }
  )
})
