import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['test/native/*.suite.ts'],
    setupFiles: ['test/native/setup.ts'],
    environment: 'node',
    testTimeout: 15000,
    maxWorkers: 4,
    passWithNoTests: false,
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/notebook-analysis-native.json' }
  }
})
