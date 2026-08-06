import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/electron',
  // Keep one canonical Chromium layout baseline for every desktop OS. Text antialiasing differs by
  // platform, so the visual spec applies a wider cross-platform pixel budget while still catching
  // displaced, missing, or resized surfaces.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-darwin{ext}',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
