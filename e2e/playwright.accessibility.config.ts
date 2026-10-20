import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

import baseConfig from '../playwright.config'

export default defineConfig(baseConfig, {
  testDir: '.',
  outputDir: '../test-results/electron',
  globalTimeout: 600_000,
  reporter: process.env.CI
    ? [
        ['line'],
        ['blob', { outputDir: resolve(__dirname, '..', 'blob-report') }],
        [
          'json',
          {
            outputFile: resolve(
              __dirname,
              '..',
              process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? 'test-results/e2e.json'
            )
          }
        ],
        ['html', { outputFolder: resolve(__dirname, '..', 'playwright-report'), open: 'never' }],
        [resolve(__dirname, 'accessibility-reporter.ts')]
      ]
    : [['list'], [resolve(__dirname, 'accessibility-reporter.ts')]]
})
