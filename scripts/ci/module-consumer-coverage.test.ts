import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it } from 'vitest'

// Run the whole-repository compiler scan outside V8's coverage profiler. The CLI keeps every
// assertion and propagates failures; parser/graph behavior remains covered by focused unit tests.
it('retains every statically reachable consumer test and declared runtime-loading edge', async () => {
  await promisify(execFile)(process.execPath, ['scripts/ci/check-module-consumer-coverage.mjs'], {
    timeout: 110_000
  })
}, 120_000)
