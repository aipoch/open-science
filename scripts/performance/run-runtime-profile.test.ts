import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const launcherEnvironment = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    // The launcher must not depend on `npm` being on PATH. Windows still needs PATH so
    // node.exe can load its DLLs. Drop every casing of npm_execpath so the mock path wins.
    if (key === 'npm_execpath') continue
    if (process.platform !== 'win32' && key === 'path') continue
    environment[name] = value
  }
  return { ...environment, ...overrides }
}

describe('runtime profile launcher', () => {
  it('invokes npm through the current Node executable without relying on a shell command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-runtime-launcher-'))
    const npmCliPath = join(root, 'mock-npm-cli.cjs')
    const invocationLog = join(root, 'npm-invocations.jsonl')
    await writeFile(
      npmCliPath,
      `'use strict'
const { appendFileSync } = require('node:fs')
appendFileSync(
  process.env.RUNTIME_PROFILE_INVOCATION_LOG,
  JSON.stringify(process.argv.slice(2)) + '\\n'
)
process.exit(0)
`,
      'utf8'
    )

    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/performance/run-runtime-profile.mjs'),
          '--repeat=1',
          '--phase-ms=2000',
          '--interval-ms=500',
          '--stress-cycles=1',
          `--output=${join(root, 'output')}`
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: launcherEnvironment({
            npm_execpath: npmCliPath,
            RUNTIME_PROFILE_INVOCATION_LOG: invocationLog
          }),
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
          windowsHide: true
        }
      )

      expect(result.error, result.stderr || result.stdout).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const invocations = (await readFile(invocationLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      expect(invocations).toEqual([
        ['run', 'build:e2e'],
        [
          'exec',
          '--',
          'playwright',
          'test',
          'e2e/runtime-performance.spec.ts',
          '--workers=1',
          '--repeat-each=1',
          '--retries=0',
          '--reporter=list'
        ]
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
