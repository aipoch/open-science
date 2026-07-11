import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveClaudeExecutableForSpawn } from './claude-executable'

// Uses posix-style paths so the logic is exercised host-independently; production uses the platform's
// path module (back-slashes on real Windows).
const PACKAGE_DIR = join('/npm', 'node_modules', '@anthropic-ai', 'claude-code')
const CLI_JS = join(PACKAGE_DIR, 'cli.js')

type Deps = { exists: (p: string) => boolean; readText: (p: string) => string }

const deps = (over: Partial<Deps>): Deps => ({
  exists: () => false,
  readText: () => '',
  ...over
})

describe('resolveClaudeExecutableForSpawn', () => {
  it('passes any path through unchanged off Windows', () => {
    expect(resolveClaudeExecutableForSpawn('/usr/local/bin/claude.cmd', 'darwin')).toBe(
      '/usr/local/bin/claude.cmd'
    )
  })

  it('passes a native .exe through unchanged on Windows', () => {
    const exe = join('/programs', 'claude', 'claude.exe')
    expect(resolveClaudeExecutableForSpawn(exe, 'win32')).toBe(exe)
  })

  it('passes a .js entry through unchanged on Windows', () => {
    expect(resolveClaudeExecutableForSpawn(CLI_JS, 'win32')).toBe(CLI_JS)
  })

  it('resolves a .cmd shim to the cli.js from the package bin map', () => {
    const result = resolveClaudeExecutableForSpawn(
      join('/npm', 'claude.cmd'),
      'win32',
      deps({
        readText: () => JSON.stringify({ bin: { claude: 'cli.js' } }),
        exists: (p) => p === CLI_JS
      })
    )

    expect(result).toBe(CLI_JS)
  })

  it('resolves a .cmd shim when bin is a plain string', () => {
    const result = resolveClaudeExecutableForSpawn(
      join('/npm', 'claude.cmd'),
      'win32',
      deps({
        readText: () => JSON.stringify({ bin: 'cli.js' }),
        exists: (p) => p === CLI_JS
      })
    )

    expect(result).toBe(CLI_JS)
  })

  it('falls back to the conventional cli.js when package.json is unreadable', () => {
    const result = resolveClaudeExecutableForSpawn(
      join('/npm', 'claude.cmd'),
      'win32',
      deps({
        readText: () => {
          throw new Error('ENOENT')
        },
        exists: (p) => p === CLI_JS
      })
    )

    expect(result).toBe(CLI_JS)
  })

  it('returns the original shim when nothing can be resolved', () => {
    const shim = join('/npm', 'claude.cmd')
    const result = resolveClaudeExecutableForSpawn(shim, 'win32', deps({ exists: () => false }))

    expect(result).toBe(shim)
  })
})
