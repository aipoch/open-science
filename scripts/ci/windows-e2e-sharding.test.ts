import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JSONReport } from '@playwright/test/reporter'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const run = (
  args: string[],
  failing = false,
  namedProject = false
): { exit: number | null; report: JSONReport } => {
  const root = mkdtempSync(join(tmpdir(), 'windows-e2e-sharding-'))
  try {
    writeFileSync(
      join(root, 'config.cjs'),
      `module.exports = { testDir: __dirname, fullyParallel: true, workers: 1,
        projects: ${JSON.stringify(namedProject ? [{ name: 'chromium' }] : undefined)},
        retries: 1, outputDir: ${JSON.stringify(join(root, 'results'))},
        reporter: [[${JSON.stringify(resolve('e2e/windows-shard-reporter.ts'))}], ['json']] };`
    )
    for (const file of ['fast', 'slow']) {
      writeFileSync(
        join(root, `${file}.spec.cjs`),
        `const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
         for (let i = 0; i < 6; i++) test('${file} ' + i, async ({}, info) => {
           if (${failing} && i === 0) expect(info.retry).toBe(1);
         });`
      )
    }
    const result = spawnSync(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '-c', join(root, 'config.cjs'), ...args],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: undefined,
          PLAYWRIGHT_JSON_OUTPUT_FILE: undefined
        }
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    return { exit: result.status, report: JSON.parse(result.stdout) as JSONReport }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('Windows Electron round-robin sharding', () => {
  it('distributes every file across runners without dropping or duplicating cases', () => {
    const titles: string[] = []
    for (let current = 1; current <= 3; current++) {
      const { exit, report } = run([`--shard=${current}/3`])
      expect(exit).toBe(0)
      expect(report.config.shard).toEqual({ current, total: 3 })
      expect(report.stats.expected).toBe(4)
      const shard = report.suites.flatMap((suite) => suite.specs.map((spec) => spec.title))
      expect(shard).toEqual([
        `fast ${current - 1}`,
        `fast ${current + 2}`,
        `slow ${current - 1}`,
        `slow ${current + 2}`
      ])
      titles.push(...shard)
    }
    expect(new Set(titles).size).toBe(12)
  }, 60_000)

  it('preserves unsharded runs and still blocks retry-passes', () => {
    const complete = run([])
    expect(complete.exit).toBe(0)
    expect(complete.report.stats.expected).toBe(12)
    const flaky = run(['--shard=1/3', '--fail-on-flaky-tests'], true)
    expect(flaky.exit).toBe(1)
    expect(flaky.report.stats.flaky).toBe(2)
  }, 45_000)

  it('keeps the selected Electron cases independent for test-level distribution', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    for (const script of ['test:e2e:journey', 'test:e2e:workspace']) {
      const files = scripts[script].match(/e2e\/[^ ]+\.spec\.ts/g) as string[]
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(
          /test\.(?:beforeAll|afterAll)|describe\.serial|mode:\s*['"]serial['"]/
        )
      }
    }
  })

  it('preserves native sharding in named browser projects inheriting the reporter', () => {
    const { exit, report } = run(['--shard=1/3'], false, true)
    expect(exit).toBe(0)
    expect(report.suites.flatMap((suite) => suite.specs.map((spec) => spec.title))).toEqual([
      'fast 0',
      'fast 1',
      'fast 2',
      'fast 3'
    ])
  }, 25_000)
})
