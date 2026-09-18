import { defineConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import base from './playwright.config'

// Config is loaded in each worker; separate files preserve logs across workers and retries.
const netlogDirectory = resolve('test-results/browser-diagnostics')
const captureNetlog =
  process.platform === 'win32' || process.env.OPEN_SCIENCE_BROWSER_NETLOG === '1'
if (captureNetlog) mkdirSync(netlogDirectory, { recursive: true })

// Replace Electron's Windows project list; defineConfig(base, override) merges projects by name.
export default defineConfig({
  ...base,
  testDir: './e2e/browser',
  testIgnore: [],
  outputDir: 'test-results/browser',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  fullyParallel: true,
  workers: 2,
  timeout: 60_000,
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:4178',
    headless: true,
    launchOptions: captureNetlog
      ? { args: [`--log-net-log=${resolve(netlogDirectory, `netlog-${process.pid}.json`)}`] }
      : undefined
  },
  webServer: {
    // Bundled fixtures avoid hundreds of dev-module requests and React-refresh startup failures.
    command:
      'node node_modules/vite/bin/vite.js build --config vite.browser-test.config.ts && node node_modules/vite/bin/vite.js preview --config vite.browser-test.config.ts',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 120_000
  }
})
