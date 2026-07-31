import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectCandidateDirs,
  detectCursor,
  parseVersion,
  type CursorDetectDeps
} from './cursor-detect'

const createDeps = (
  installed: Record<string, { version: string; loggedIn?: boolean }>,
  overrides: Partial<CursorDetectDeps> = {}
): CursorDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(path in installed),
  getVersion: (path) => Promise.resolve(installed[path]?.version),
  getLoginStatus: (path) => Promise.resolve(installed[path]?.loggedIn),
  ...overrides
})

describe('cursor-detect', () => {
  it('parses the first non-empty version line', () => {
    expect(parseVersion('2026.07.23-e383d2b\n')).toBe('2026.07.23-e383d2b')
    expect(parseVersion('\n  agent 1.0.0  \n')).toBe('agent 1.0.0')
  })

  it('returns undefined when no candidate is executable', async () => {
    expect(await detectCursor(createDeps({}))).toBeUndefined()
  })

  it('finds agent on PATH and records login status', async () => {
    const result = await detectCursor(
      createDeps({ '/usr/local/bin/agent': { version: '2026.07.23-e383d2b', loggedIn: true } })
    )

    expect(result).toEqual({
      resolvedPath: '/usr/local/bin/agent',
      version: '2026.07.23-e383d2b',
      loggedIn: true
    })
  })

  it('prefers agent over the cursor-agent alias', async () => {
    const result = await detectCursor(
      createDeps({
        '/usr/local/bin/cursor-agent': { version: 'old' },
        '/usr/local/bin/agent': { version: 'new', loggedIn: false }
      })
    )

    expect(result?.resolvedPath).toBe('/usr/local/bin/agent')
    expect(result?.version).toBe('new')
    expect(result?.loggedIn).toBe(false)
  })

  it('probes ~/.local/bin for the official install script layout', async () => {
    const result = await detectCursor(
      createDeps({ '/home/user/.local/bin/agent': { version: '2026.01.01-abc', loggedIn: true } })
    )

    expect(result?.resolvedPath).toBe('/home/user/.local/bin/agent')
  })

  it('probes %LOCALAPPDATA%\\cursor-agent on Windows', async () => {
    const localAppData = 'C:\\Users\\user\\AppData\\Local'
    const candidate = win32.join(localAppData, 'cursor-agent', 'agent.cmd')
    const result = await detectCursor(
      createDeps(
        { [candidate]: { version: '2026.07.23-e383d2b', loggedIn: true } },
        {
          platform: 'win32',
          homePath: 'C:\\Users\\user',
          env: { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: localAppData }
        }
      )
    )

    expect(result?.resolvedPath).toBe(candidate)
  })

  it('skips a path that exists but cannot report a version', async () => {
    const result = await detectCursor(
      createDeps(
        {},
        {
          isExecutable: () => Promise.resolve(true),
          getVersion: () => Promise.resolve(undefined)
        }
      )
    )

    expect(result).toBeUndefined()
  })

  it('includes well-known unix dirs in the candidate list', async () => {
    const dirs = await collectCandidateDirs(
      createDeps({}, { env: { PATH: '/custom/bin' }, homePath: '/home/user', platform: 'linux' })
    )

    expect(dirs).toContain('/custom/bin')
    expect(dirs).toContain(posix.join('/home/user', '.local', 'bin'))
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
  })
})
