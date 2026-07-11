import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectCandidateDirs,
  detectClaude,
  parseVersion,
  type ClaudeDetectDeps
} from './claude-detect'

// Builds detect deps around a set of "installed" executables keyed by absolute path.
const createDeps = (
  installed: Record<string, string>,
  overrides: Partial<ClaudeDetectDeps> = {}
): ClaudeDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  // Pinned so probe order is host-independent (tests run on macOS/Linux/Windows CI runners alike).
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(path in installed),
  getVersion: (path) => Promise.resolve(installed[path]),
  resolveNpmBinDirs: () => Promise.resolve([]),
  ...overrides
})

describe('claude-detect', () => {
  it('parses a version string out of --version output', () => {
    expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3')
    expect(parseVersion('claude 1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('returns not found when no candidate is executable', async () => {
    const result = await detectClaude(createDeps({}))

    expect(result).toEqual({ found: false })
  })

  it('finds claude on PATH and records its absolute path and version', async () => {
    const result = await detectClaude(createDeps({ '/usr/local/bin/claude': '2.1.0' }))

    expect(result).toEqual({ found: true, path: '/usr/local/bin/claude', version: '2.1.0' })
  })

  it('falls back to ~/.local/bin and npm bin dirs when PATH misses', async () => {
    const npmBin = '/home/user/.nvm/bin'
    const result = await detectClaude(
      createDeps(
        { [join(npmBin, 'claude')]: '2.2.0' },
        { resolveNpmBinDirs: () => Promise.resolve([npmBin]) }
      )
    )

    expect(result).toEqual({ found: true, path: join(npmBin, 'claude'), version: '2.2.0' })
  })

  it('skips a path that exists but cannot report a version', async () => {
    const deps = createDeps(
      { '/usr/local/bin/claude': undefined as unknown as string },
      { isExecutable: () => Promise.resolve(true), getVersion: () => Promise.resolve(undefined) }
    )
    const result = await detectClaude(deps)

    expect(result.found).toBe(false)
  })

  it('probes PATH, ~/.local/bin, homebrew, then npm dirs without duplicates', async () => {
    const dirs = await collectCandidateDirs(
      createDeps({}, { resolveNpmBinDirs: () => Promise.resolve(['/usr/local/bin']) })
    )

    expect(dirs).toContain('/usr/bin')
    expect(dirs).toContain('/home/user/.local/bin')
    expect(dirs).toContain('/opt/homebrew/bin')
    // /usr/local/bin appears in PATH and the npm dir list but is only probed once.
    expect(dirs.filter((dir) => dir === '/usr/local/bin')).toHaveLength(1)
  })

  it('tolerates a failing npm bin resolution', async () => {
    const deps = createDeps(
      { '/usr/local/bin/claude': '2.0.0' },
      { resolveNpmBinDirs: () => Promise.reject(new Error('npm missing')) }
    )
    const result = await detectClaude(deps)

    expect(result.found).toBe(true)
  })

  describe('windows', () => {
    // Windows uses ; as the PATH delimiter and back-slash paths. join() on a posix test host emits
    // forward slashes, so assert on the pieces produced by join() rather than literal separators.
    const winDeps = (
      installed: Record<string, string>,
      overrides: Partial<ClaudeDetectDeps> = {}
    ): ClaudeDetectDeps =>
      createDeps(installed, {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows;C:\\Users\\me\\bin',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
        },
        homePath: 'C:\\Users\\me',
        ...overrides
      })

    it('probes %APPDATA%\\npm and %LOCALAPPDATA%\\Programs\\claude, not the Unix dirs', async () => {
      const dirs = await collectCandidateDirs(winDeps({}))

      expect(dirs).toContain(join('C:\\Users\\me\\AppData\\Roaming', 'npm'))
      expect(dirs).toContain(join('C:\\Users\\me\\AppData\\Local', 'Programs', 'claude'))
      expect(dirs).toContain(join('C:\\Users\\me', '.local', 'bin'))
      expect(dirs).not.toContain('/opt/homebrew/bin')
    })

    it('finds claude.cmd ahead of the bare name', async () => {
      const npmDir = join('C:\\Users\\me\\AppData\\Roaming', 'npm')
      const result = await detectClaude(winDeps({ [join(npmDir, 'claude.cmd')]: '2.3.0' }))

      expect(result).toEqual({ found: true, path: join(npmDir, 'claude.cmd'), version: '2.3.0' })
    })

    it('finds claude.exe when no .cmd shim exists', async () => {
      const dir = join('C:\\Users\\me\\AppData\\Local', 'Programs', 'claude')
      const result = await detectClaude(winDeps({ [join(dir, 'claude.exe')]: '2.4.0' }))

      expect(result).toEqual({ found: true, path: join(dir, 'claude.exe'), version: '2.4.0' })
    })

    it('still probes the extensionless catch-all name', async () => {
      // Place it in a well-known dir (not PATH) so the assertion is independent of the host's PATH
      // delimiter, which is ':' on the posix machines this test suite also runs on.
      const npmDir = join('C:\\Users\\me\\AppData\\Roaming', 'npm')
      const result = await detectClaude(winDeps({ [join(npmDir, 'claude')]: '2.5.0' }))

      expect(result).toEqual({ found: true, path: join(npmDir, 'claude'), version: '2.5.0' })
    })
  })
})
