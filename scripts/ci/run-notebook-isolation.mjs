/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NOTEBOOK_ISOLATION_TEST =
  'src/main/notebook/runtime-service.macos-isolation.integration.test.ts'

// A failed teardown retains the sandbox singleton. Vitest's in-worker retry cannot reset it.
export function runNotebookIsolation({ spawn = spawnSync, env = process.env } = {}) {
  const args = [resolve('node_modules/vitest/vitest.mjs'), 'run', NOTEBOOK_ISOLATION_TEST]
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    console.log(`Notebook macOS isolation: attempt ${attempt}/2`)
    const result = spawn(process.execPath, args, { env, stdio: 'inherit' })
    if (result.error) console.error(result.error)
    const status = result.error || result.signal ? 1 : (result.status ?? 1)
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `- Notebook macOS isolation attempt ${attempt}/2: ${status === 0 ? 'passed' : 'failed'} (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}). See this attempt's job log.\n`
      )
    }
    // Cancellation, startup failures and abnormal exits must not turn into a fresh attempt.
    if (result.error || result.signal || result.status !== 1 || attempt === 2) return status
    console.warn(
      '::warning::Notebook macOS isolation failed; retrying only this test file once in a fresh process. The first attempt remains in the job log.'
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runNotebookIsolation()
}
