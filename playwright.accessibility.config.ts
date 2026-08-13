import { defineConfig } from '@playwright/test'

import baseConfig from './playwright.config'

export default defineConfig(baseConfig, {
  reporter: process.env.CI
    ? [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['./e2e/accessibility-reporter.ts']
      ]
    : [['list'], ['./e2e/accessibility-reporter.ts']]
})
