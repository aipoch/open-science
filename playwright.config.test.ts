import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PlaywrightTestConfig } from '@playwright/test'
import type { JSONReport } from '@playwright/test/reporter'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const loadConfig = async (
  platform: NodeJS.Platform,
  browser = false
): Promise<PlaywrightTestConfig> => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    vi.resetModules()
    return browser
      ? (await import('./playwright.browser.config')).default
      : (await import('./playwright.config')).default
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
}

describe('Electron Playwright concurrency', () => {
  it('runs one Windows journey at a time even with the CI two-worker CLI budget', async () => {
    const config = await loadConfig('win32')
    const root = mkdtempSync(join(tmpdir(), 'open-science-playwright-config-'))
    try {
      const configPath = join(root, 'playwright.config.cjs')
      writeFileSync(
        configPath,
        `module.exports = ${JSON.stringify({ ...config, testDir: root, outputDir: join(root, 'results') })}`
      )
      writeFileSync(
        join(root, 'concurrency.spec.cjs'),
        `const { test } = require(${JSON.stringify(require.resolve('@playwright/test'))});
         for (let i = 0; i < 4; i++) test('journey ' + i, async () => {});`
      )
      const run = spawnSync(
        process.execPath,
        [
          require.resolve('@playwright/test/cli'),
          'test',
          '-c',
          configPath,
          '--workers=2',
          '--fully-parallel',
          '--retries=0',
          '--reporter=json'
        ],
        { encoding: 'utf8', timeout: 15_000 }
      )
      expect(run.status, run.stderr).toBe(0)
      const report = JSON.parse(run.stdout) as JSONReport
      const results = report.suites.flatMap((suite) =>
        suite.specs.flatMap((spec) => spec.tests.flatMap((test) => test.results))
      )
      expect(results).toHaveLength(4)
      expect([...new Set(results.map((result) => result.workerIndex))]).toEqual([0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it.each(['darwin', 'linux'] as const)(
    'preserves the CLI worker choice on %s',
    async (platform) => {
      expect((await loadConfig(platform)).projects).toBeUndefined()
    }
  )
})

it('schedules each Windows browser case once without inheriting the Electron project', async () => {
  const config = await loadConfig('win32', true)
  const root = mkdtempSync(join(tmpdir(), 'open-science-browser-config-'))
  try {
    const configPath = join(root, 'playwright.config.cjs')
    writeFileSync(
      configPath,
      `module.exports = ${JSON.stringify({ ...config, testDir: root, webServer: undefined })}`
    )
    writeFileSync(
      join(root, 'browser.spec.cjs'),
      `const { test } = require(${JSON.stringify(require.resolve('@playwright/test'))});
       test('browser fixture', async () => {});`
    )
    const run = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '-c',
        configPath,
        '--list',
        '--reporter=json'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    )
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as JSONReport
    const scheduled = report.suites.flatMap((suite) => suite.specs.flatMap((spec) => spec.tests))
    expect(scheduled.map((test) => test.projectName)).toEqual(['chromium'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

it('partitions the selected Electron suites across three shards without losing or repeating tests', () => {
  const collect = (files: string[], shard?: string): string[] => {
    const run = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '--list',
        '--reporter=json',
        '--fully-parallel',
        ...(shard ? [`--shard=${shard}`] : []),
        ...files
      ],
      { encoding: 'utf8', timeout: 20_000 }
    )
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as JSONReport
    const visit = (suites: JSONReport['suites']): string[] =>
      suites.flatMap((suite) => [
        ...suite.specs.map((spec) => spec.id),
        ...visit(suite.suites ?? [])
      ])
    return visit(report.suites)
  }
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  for (const command of ['test:e2e:journey', 'test:e2e:workspace']) {
    const files = scripts[command].split(' ').slice(2)
    const expected = collect(files)
    expect(expected.length).toBeGreaterThan(0)
    const actual = [1, 2, 3].flatMap((index) => collect(files, `${index}/3`))
    expect(new Set(actual).size).toBe(actual.length)
    expect(actual.sort()).toEqual(expected.sort())
  }
}, 90_000)

it.each(['win32', 'darwin', 'linux'] as const)(
  'runs browser tests in exactly one Chromium project on %s',
  async (platform) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      vi.resetModules()
      const config = (await import('./playwright.browser.config')).default
      expect(config.projects).toEqual([{ name: 'chromium', use: { browserName: 'chromium' } }])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  }
)
