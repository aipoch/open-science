import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import suite from './suite.json'

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: suite.testFiles,
    setupFiles: ['scripts/ci/notebook-analysis-native/setup.ts'],
    environment: 'node',
    testTimeout: 15000,
    maxWorkers: 4,
    passWithNoTests: false,
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/notebook-analysis-native.json' }
  }
})
