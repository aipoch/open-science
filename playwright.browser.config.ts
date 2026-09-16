import { defineConfig } from '@playwright/test'
import base from './playwright.config'

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
  use: { ...base.use, baseURL: 'http://127.0.0.1:4178', headless: true },
  webServer: {
    // Bundled fixtures avoid hundreds of dev-module requests and React-refresh startup failures.
    // CI restores fixtures built at this revision in the existing setup snapshot.
    command:
      (process.env.OPEN_SCIENCE_E2E_BROWSER_PREBUILT === '1'
        ? ''
        : 'node node_modules/vite/bin/vite.js build --config vite.browser-test.config.ts && ') +
      'node node_modules/vite/bin/vite.js preview --config vite.browser-test.config.ts',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 120_000
  }
})
