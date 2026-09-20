import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JSONReport } from '@playwright/test/reporter'
import { describe, expect, it } from 'vitest'
import { ACCESSIBILITY_SURFACES } from '../../e2e/accessibility-reporter'

const require = createRequire(import.meta.url)

const runFixture = (
  config: string,
  source: string,
  accessibility = false
): {
  exit: number | null
  report: JSONReport
  summary?: { status: string; axeRunCount: number }
} => {
  const root = mkdtempSync(join(tmpdir(), 'playwright-guard-'))
  try {
    const resultPath = join(root, 'summary.json')
    writeFileSync(
      join(root, 'config.ts'),
      `import base from ${JSON.stringify(resolve(config))};
       export default { ...base, testDir: ${JSON.stringify(root)}, testIgnore: [],
         webServer: undefined, projects: undefined, outputDir: ${JSON.stringify(join(root, 'results'))},
         retries: 1, workers: 1, reporter: [['json']${accessibility ? `, [${JSON.stringify(resolve('e2e/accessibility-reporter.ts'))}]` : ''}] };`
    )
    writeFileSync(
      join(root, 'guard.spec.cjs'),
      `const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});\n${source}`
    )
    const run = spawnSync(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '-c', join(root, 'config.ts')],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          CI: '1',
          GITHUB_STEP_SUMMARY: undefined,
          PLAYWRIGHT_JSON_OUTPUT_NAME: undefined,
          PLAYWRIGHT_JSON_OUTPUT_FILE: undefined,
          ACCESSIBILITY_RESULT_PATH: resultPath
        }
      }
    )
    expect(run.error).toBeUndefined()
    expect(run.signal, run.stderr).toBeNull()
    return {
      exit: run.status,
      report: JSON.parse(run.stdout) as JSONReport,
      ...(accessibility ? { summary: JSON.parse(readFileSync(resultPath, 'utf8')) } : {})
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('CI focused test guard', () => {
  for (const config of [
    'playwright.config.ts',
    'playwright.browser.config.ts',
    'playwright.accessibility.config.ts'
  ]) {
    it.each(['test.only', 'test.describe.only'])(
      'rejects %s through ' + config,
      (focus) => {
        const focused =
          focus === 'test.only'
            ? "test.only('focused', () => {});"
            : "test.describe.only('focused group', () => { test('focused', () => {}); });"
        const { exit, report } = runFixture(
          config,
          `${focused}\ntest('omitted failure', () => expect(1).toBe(2));`
        )
        expect(exit).toBe(1)
        expect(report.errors.some(({ message }) => message?.includes('forbidOnly'))).toBe(true)
      },
      25_000
    )
  }
  it('executes the complete ordinary collection', () => {
    const { exit, report } = runFixture(
      'playwright.config.ts',
      "test('first', () => {}); test('second', () => {});"
    )
    expect(exit).toBe(0)
    expect(report.stats.expected).toBe(2)
  })
})

describe('accessibility runner stability', () => {
  it.each(['clean', 'assertion', 'timeout'])(
    'classifies a complete scan after %s',
    (failure) => {
      const scans = ACCESSIBILITY_SURFACES.map((surface) => ({ surface, violations: [] }))
      const { exit, report, summary } = runFixture(
        'playwright.accessibility.config.ts',
        `
      for (let i = 0; i < 11; i++) test('surface ' + i, async ({}, info) => {
        if (i === 0 && info.retry === 0) {
          if (${JSON.stringify(failure)} === 'assertion') expect(false, 'first-attempt interaction failure').toBe(true);
          if (${JSON.stringify(failure)} === 'timeout') {
            test.setTimeout(100);
            await new Promise(() => {});
          }
        }
        await info.attach('accessibility-ui-ready', { body: Buffer.from('{}'), contentType: 'application/json' });
        if (i === 0) for (const scan of ${JSON.stringify(scans)})
          await info.attach('accessibility-scan', { body: Buffer.from(JSON.stringify(scan)), contentType: 'application/json' });
      });
    `,
        true
      )
      expect(report.errors).toEqual([])
      expect(report.stats.flaky, JSON.stringify(report.suites)).toBe(failure === 'clean' ? 0 : 1)
      expect(summary?.axeRunCount).toBe(21)
      expect.soft(summary?.status).toBe(failure === 'clean' ? 'passed' : 'infra-failure')
      expect(exit).toBe(failure === 'clean' ? 0 : 1)
    },
    25_000
  )
})
