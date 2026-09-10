import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: './e2e/browser',
  testIgnore: [],
  outputDir: 'test-results/browser',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  fullyParallel: true,
  workers: 2,
  timeout: 60_000,
  use: { ...base.use, baseURL: 'http://127.0.0.1:4178', headless: true },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.browser-test.config.ts',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 120_000
  }
})
