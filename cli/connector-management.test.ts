import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue #2287 entry-point reproductions. Operation-specific contracts follow design review;
// these checks establish only that the requested CLI surface is missing.
describe('Connector CLI entry point', () => {
  it.each([
    ['list'],
    ['show', 'context7'],
    ['enable', 'context7'],
    ['disable', 'context7'],
    ['add'],
    ['update', 'context7'],
    ['remove', 'context7'],
    ['test', 'context7']
  ])('recognizes connector %s before operation validation', (...args) => {
    const configRoot = mkdtempSync(join(tmpdir(), 'connector-cli-repro-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve('packages/open-science/cli.mjs'),
          'connector',
          ...args,
          '--config-root',
          configRoot,
          '--json'
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      const error = result.stderr.trim() ? JSON.parse(result.stderr).error : undefined
      expect(error?.message ?? '').not.toMatch(/^Unknown command: connector\b/)
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})

it('accepts real piped credential JSON without echoing its secret', () => {
  const script = `
    import { parseCliArgs, runTaskCommand } from './packages/open-science/cli.mjs';
    await runTaskCommand(parseCliArgs(['credential', 'add', '--json']), {
      connect: async () => ({ createCredential: async (input) => {
        if (input.secret !== 'private-token') throw new Error('input was not read');
        return { createdCredential: { id: 'saved' } };
      } })
    });`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify({ kind: 'token', displayName: 'Example', secret: 'private-token' }),
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ createdCredential: { id: 'saved' } })
  expect(result.stdout + result.stderr).not.toContain('private-token')
})
