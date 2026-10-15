import { defineConfig } from 'vitest/config'

// Deliberately independent of both impact manifests and the application's test setup/builds.
export default defineConfig({
  test: {
    include: [
      'scripts/ci/impact-registration-gate.test.ts',
      'scripts/ci/validate-module-impact.test.ts',
      'scripts/ci/audit-module-ownership.test.ts',
      'scripts/ci/module-consumer-coverage.test.ts',
      'scripts/ci/package-boundaries.test.ts',
      'scripts/ci/classify-pr-changes.test.ts',
      'scripts/ci/platform-risk-gates.test.ts',
      'scripts/ci/windows-core-plan.test.ts'
    ],
    environment: 'node',
    setupFiles: [],
    allowOnly: false,
    passWithNoTests: false,
    // Whole-repository dependency scans share the runner; keep their memory use bounded.
    maxWorkers: 1,
    testTimeout: 15000,
    silent: 'passed-only'
  }
})
