import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NOTEBOOK_ISOLATION_TEST, runNotebookIsolation } from './run-notebook-isolation.mjs'

describe('Notebook macOS isolation retry', () => {
  it('runs the CLI retry in a different OS process with no inherited singleton', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-isolation-process-'))
    try {
      mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
      writeFileSync(
        join(root, 'node_modules', 'vitest', 'vitest.mjs'),
        `import assert from 'node:assert/strict'
import { appendFileSync, existsSync } from 'node:fs'
assert.deepEqual(process.argv.slice(2), ['run', ${JSON.stringify(NOTEBOOK_ISOLATION_TEST)}])
assert.equal(globalThis.sandboxOwner, undefined)
globalThis.sandboxOwner = 'retained'
const retry = existsSync('attempts')
appendFileSync('attempts', process.pid + '\\n')
console.log('fixture attempt', process.pid)
process.exit(retry ? 0 : 1)
`
      )
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/ci/run-notebook-isolation.mjs')],
        {
          cwd: root,
          env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, 'summary.md') },
          encoding: 'utf8'
        }
      )
      expect(result.status, result.stderr).toBe(0)
      const pids = readFileSync(join(root, 'attempts'), 'utf8').trim().split('\n')
      expect(pids).toHaveLength(2)
      expect(new Set(pids).size).toBe(2)
      expect(result.stdout.match(/fixture attempt/g)).toHaveLength(2)
      expect(result.stderr).toContain('retrying only this test file once in a fresh process')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs the complete isolation file once when it passes', () => {
    const spawn = vi.fn(() => ({ status: 0 }))
    expect(runNotebookIsolation({ spawn, env: {} })).toBe(0)
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [
        resolve('node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/notebook/runtime-service.macos-isolation.integration.test.ts'
      ],
      { env: {}, stdio: 'inherit' }
    )
  })

  it('starts a fresh process for the same file and preserves both attempt outcomes', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-isolation-retry-'))
    const summary = join(root, 'summary.md')
    const env = { OPEN_SCIENCE_TEST_PY_ENV: '/fixture/python', GITHUB_STEP_SUMMARY: summary }
    const spawn = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 })
    try {
      expect(runNotebookIsolation({ spawn, env })).toBe(0)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(spawn.mock.calls[1]).toEqual(spawn.mock.calls[0])
      expect(spawn.mock.calls[1][2]).toEqual({ env, stdio: 'inherit' })
      const outcomes = readFileSync(summary, 'utf8')
      expect(outcomes).toContain('attempt 1/2: failed')
      expect(outcomes).toContain('attempt 2/2: passed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails after the second failure without a third attempt', () => {
    const spawn = vi.fn(() => ({ status: 1 }))
    expect(runNotebookIsolation({ spawn, env: {} })).toBe(1)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it.each([
    { status: null, signal: 'SIGTERM' },
    { status: null, signal: 'SIGINT' },
    { status: null, error: new Error('spawn failed') },
    { status: null },
    { status: 2 },
    { status: 130 },
    { status: 0, error: new Error('process error') }
  ])('does not retry an interrupted or invalid invocation: %j', (result) => {
    const spawn = vi.fn(() => result)
    expect(runNotebookIsolation({ spawn, env: {} })).not.toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
