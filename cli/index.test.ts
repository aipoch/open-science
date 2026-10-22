import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isProcessAlive, parseCliArgs } from './index.mjs'

describe('CLI argument parsing', () => {
  it('parses machine-readable start output', () => {
    expect(parseCliArgs(['start', '--json'])).toEqual({
      command: 'start',
      options: { open: true, json: true }
    })
  })

  it('rejects unsupported --json for url instead of ignoring it', () => {
    expect(() => parseCliArgs(['url', '--json'])).toThrow('--json is not supported')
  })

  it('parses start options', () => {
    expect(
      parseCliArgs([
        'start',
        '--port',
        '44200',
        '--app-path',
        '/opt/open-science',
        '--config-root',
        '/tmp/open-science',
        '--no-open'
      ])
    ).toEqual({
      command: 'start',
      options: {
        open: false,
        json: false,
        port: 44200,
        appPath: '/opt/open-science',
        configRoot: '/tmp/open-science'
      }
    })
  })

  it('parses the explicit no-sandbox start fallback', () => {
    expect(parseCliArgs(['start', '--no-sandbox'])).toEqual({
      command: 'start',
      options: { open: true, json: false, noSandbox: true }
    })
  })

  it('parses status JSON output and rejects invalid options', () => {
    expect(parseCliArgs(['status', '--json'])).toEqual({
      command: 'status',
      options: { open: true, json: true }
    })
    expect(() => parseCliArgs(['start', '--port', '70000'])).toThrow('Invalid port')
    expect(() => parseCliArgs(['start', '--unknown'])).toThrow('Unknown option')
  })

  it('requires a value for value-taking flags', () => {
    expect(() => parseCliArgs(['start', '--app-path'])).toThrow('requires a value')
    expect(() => parseCliArgs(['start', '--config-root'])).toThrow('requires a value')
  })
})

describe('removed application update command', () => {
  it.each(
    ['./index.mjs', '../packages/open-science/cli.mjs'].flatMap((entry) =>
      [[], ['--json'], ['--help']].map((flags) => ({ entry, flags }))
    )
  )(
    'rejects update through $entry with $flags without creating a profile',
    async ({ entry, flags }) => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-removed-update-'))
      const profile = join(directory, 'profile')
      try {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL(entry, import.meta.url)),
            'update',
            '--config-root',
            profile,
            ...flags
          ],
          { encoding: 'utf8', timeout: 10_000 }
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('Unknown command: update')
        if (flags.includes('--json')) {
          expect(JSON.parse(result.stderr)).toMatchObject({
            error: { code: 'invalid_cli_usage' },
            exitCode: 2
          })
        }
        expect(existsSync(profile)).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

describe('isProcessAlive', () => {
  it('returns true for the running test process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for invalid or non-existent pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    // A pid this large is effectively certain not to be running.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})
