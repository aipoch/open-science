import { defineConfig } from 'vitest/config'
import applicationConfig from '../../../vitest.config'

// This native suite belongs to run.mjs, not to portable module-test routing. Reuse application
// resolution/setup, but do not inherit its projects, sharding or passWithNoTests behavior.
export default defineConfig({
  server: applicationConfig.server,
  resolve: applicationConfig.resolve,
  test: {
    include: ['scripts/ci/process-lifecycle/lifecycle.suite.ts'],
    setupFiles: applicationConfig.test.setupFiles,
    environment: 'node',
    allowOnly: false,
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
    silent: 'passed-only'
  }
})
