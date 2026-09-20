import { defineConfig } from '@playwright/test'

import baseConfig from './playwright.config'

export default defineConfig(baseConfig, {
  globalTimeout: 600_000,
  reporter: process.env.CI
    ? [
        ['line'],
        ['blob'],
        [
          'json',
          { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? 'test-results/e2e.json' }
        ],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['./e2e/accessibility-reporter.ts']
      ]
    : [['list'], ['./e2e/accessibility-reporter.ts']]
})
