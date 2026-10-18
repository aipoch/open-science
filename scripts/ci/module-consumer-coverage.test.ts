import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

// Whole-tree TypeScript parsing is a structural guard, outside the application's coverage scope.
// Run the same assertions without inheriting Vitest's V8 profiler: precise coverage makes this
// scan exceed 120 seconds even when the uninstrumented guard finishes in a fraction of that time.
it('retains every statically reachable consumer test and declared runtime-loading edge', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { checkModuleConsumerCoverage } from './scripts/ci/check-module-consumer-coverage.mjs'; checkModuleConsumerCoverage()`
    ],
    { cwd: process.cwd(), timeout: 110_000, stdio: 'pipe' }
  )
}, 120_000)
