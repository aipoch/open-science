import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PlaywrightTestConfig } from '@playwright/test'
import type { JSONReport } from '@playwright/test/reporter'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const loadConfig = async (platform: NodeJS.Platform): Promise<PlaywrightTestConfig> => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    vi.resetModules()
    return (await import('./playwright.config')).default
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
