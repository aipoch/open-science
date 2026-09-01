import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('runtime profile launcher', () => {
  it('invokes npm through the current Node executable without relying on a shell command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-runtime-launcher-'))
    const npmCliPath = join(root, 'mock-npm-cli.mjs')
    const invocationLog = join(root, 'npm-invocations.jsonl')
    await writeFile(
      npmCliPath,
      `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.RUNTIME_PROFILE_INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      'utf8'
    )

    try {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path')
      )
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
          env: {
            ...environment,
            npm_execpath: npmCliPath,
            RUNTIME_PROFILE_INVOCATION_LOG: invocationLog
          },
          timeout: 10_000
        }
      )

      expect(result.error).toBeUndefined()
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
          '--reporter=list'
        ]
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
