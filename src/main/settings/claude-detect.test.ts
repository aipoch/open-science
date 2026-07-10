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
})
