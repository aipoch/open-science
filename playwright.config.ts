import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  tag: process.env.CI ? `@${process.platform}` : undefined,
  testIgnore: ['**/browser/**'],
  outputDir: 'test-results/electron',
  // Keep one canonical Chromium layout baseline for every desktop OS. Text antialiasing differs by
  // platform, so the visual spec applies a wider cross-platform pixel budget while still catching
  // displaced, missing, or resized surfaces.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-darwin{ext}',
  fullyParallel: false,
  workers: 1,
  // Keep Windows Electron journeys from sharing a desktop, including when CI raises the global
  // worker budget. The unnamed project preserves existing test IDs and test-level sharding.
  projects: process.platform === 'win32' ? [{ workers: 1 }] : undefined,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  reporter: process.env.CI
    ? [
        ['line'],
        ['blob'],
        [
          'json',
          { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? 'test-results/e2e.json' }
        ],
        ['html', { outputFolder: 'playwright-report', open: 'never' }]
      ]
    : [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
