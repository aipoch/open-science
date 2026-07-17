import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectCandidateDirs,
  detectOpencode,
  parseVersion,
  type OpencodeDetectDeps
} from './opencode-detect'

// Builds detect deps around a set of "installed" executables keyed by absolute path.
const createDeps = (
  installed: Record<string, string>,
  overrides: Partial<OpencodeDetectDeps> = {}
): OpencodeDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  // Pinned so probe order is host-independent (tests run on macOS/Linux/Windows CI runners alike).
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(path in installed),
  getVersion: (path) => Promise.resolve(installed[path]),
  resolveNpmBinDirs: () => Promise.resolve([]),
  ...overrides
})

describe('opencode-detect', () => {
  it('parses a version string out of --version output', () => {
    expect(parseVersion('1.18.3')).toBe('1.18.3')
    expect(parseVersion('opencode 1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('returns undefined when no candidate is executable', async () => {
    expect(await detectOpencode(createDeps({}))).toBeUndefined()
  })

  it('finds opencode on PATH and records its absolute path and version', async () => {
    const result = await detectOpencode(createDeps({ '/usr/local/bin/opencode': '1.18.0' }))

    expect(result).toEqual({ resolvedPath: '/usr/local/bin/opencode', version: '1.18.0' })
  })

  it('finds a managed opencode via extraDirs even when it is not on PATH', async () => {
    const managedDir = '/home/user/.open-science/opencode-managed/bin'
    const result = await detectOpencode(
      createDeps({ [posix.join(managedDir, 'opencode')]: '1.19.0' }, { extraDirs: [managedDir] })
    )

    expect(result).toEqual({ resolvedPath: posix.join(managedDir, 'opencode'), version: '1.19.0' })
  })

  it('probes the ~/.opencode/bin install-script target', async () => {
    const result = await detectOpencode(
      createDeps({ '/home/user/.opencode/bin/opencode': '1.20.0' })
    )

    expect(result).toEqual({
      resolvedPath: '/home/user/.opencode/bin/opencode',
      version: '1.20.0'
    })
  })

  it('skips a path that exists but cannot report a version', async () => {
    const result = await detectOpencode(
      createDeps(
        {},
        { isExecutable: () => Promise.resolve(true), getVersion: () => Promise.resolve(undefined) }
      )
    )

    expect(result).toBeUndefined()
  })

  it('tolerates a failing npm bin resolution', async () => {
    const result = await detectOpencode(
      createDeps(
        { '/usr/local/bin/opencode': '1.0.0' },
        { resolveNpmBinDirs: () => Promise.reject(new Error('npm missing')) }
      )
    )

    expect(result?.version).toBe('1.0.0')
  })

  describe('windows', () => {
    const winDeps = (
      installed: Record<string, string>,
      overrides: Partial<OpencodeDetectDeps> = {}
    ): OpencodeDetectDeps =>
      createDeps(installed, {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows;C:\\Users\\me\\bin',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming'
        },
        homePath: 'C:\\Users\\me',
        ...overrides
      })

    it('probes %APPDATA%\\npm and the home install dirs, not the Unix dirs', async () => {
      const dirs = await collectCandidateDirs(winDeps({}))

      expect(dirs).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm'))
      expect(dirs).toContain(win32.join('C:\\Users\\me', '.opencode', 'bin'))
      expect(dirs).not.toContain('/opt/homebrew/bin')
    })

    it('finds opencode.exe from a managed install dir', async () => {
      const managedDir = win32.join('C:\\Users\\me\\AppData\\Local', 'open-science', 'bin')
      const result = await detectOpencode(
        winDeps({ [win32.join(managedDir, 'opencode.exe')]: '1.18.0' }, { extraDirs: [managedDir] })
      )

      expect(result).toEqual({
        resolvedPath: win32.join(managedDir, 'opencode.exe'),
        version: '1.18.0'
      })
    })

    it('finds opencode.cmd ahead of the bare name', async () => {
      const npmDir = win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm')
      const result = await detectOpencode(
        winDeps({ [win32.join(npmDir, 'opencode.cmd')]: '1.1.0' })
      )

      expect(result).toEqual({
        resolvedPath: win32.join(npmDir, 'opencode.cmd'),
        version: '1.1.0'
      })
    })
  })
})
