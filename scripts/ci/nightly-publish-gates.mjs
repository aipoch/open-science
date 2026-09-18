/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Nightly job ids whose reusable-workflow jobs are advisory for the build but gate publication.
export const DEFAULT_GATING_PREFIXES = ['runtime-certification', 'regression']

// Reusable-workflow jobs appear in the jobs API as `<caller-job> / <callee-job-name>`; a skipped
// caller appears as the bare caller id.
function matchesPrefix(name, prefix) {
  return name === prefix || name.startsWith(`${prefix} / `)
}

// The jobs API reports each job's actual conclusion (`failure`) even when `continue-on-error`
// masked it at the workflow level, which is what lets a `success` Nightly still block here.
// Publication only follows scheduled runs, where no gating job is skipped by input, so anything
// other than `success` (including `skipped` or a missing gate) fails closed.
export function evaluateNightlyPublishGates(jobs, prefixes = DEFAULT_GATING_PREFIXES) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array')
  const blocking = []
  for (const prefix of prefixes) {
    const gated = jobs.filter((job) => matchesPrefix(String(job?.name ?? ''), prefix))
    if (gated.length === 0) {
      blocking.push({ name: prefix, conclusion: 'missing' })
      continue
    }
    for (const job of gated) {
      if (job.conclusion !== 'success') {
        blocking.push({ name: job.name, conclusion: job.conclusion ?? 'unknown' })
      }
    }
  }
  return { ok: blocking.length === 0, blocking }
}

export function formatNightlyPublishGates(result) {
  if (result.ok) return 'All nightly publication gates passed.\n'
  const lines = result.blocking.map(({ name, conclusion }) => `- ${name}: ${conclusion}`)
  return `Nightly publication blocked by advisory jobs that did not succeed:\n${lines.join('\n')}\n`
}

export function runNightlyPublishGatesCli(argv = process.argv.slice(2), environment = process.env) {
  const jobsIndex = argv.indexOf('--jobs')
  const jobsPath = jobsIndex >= 0 ? argv[jobsIndex + 1] : undefined
  if (!jobsPath) throw new Error('Usage: nightly-publish-gates.mjs --jobs <jobs.json>')

  const result = evaluateNightlyPublishGates(JSON.parse(readFileSync(jobsPath, 'utf8')))
  process.stdout.write(formatNightlyPublishGates(result))
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `ok=${result.ok}\n`)
  return result
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runNightlyPublishGatesCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
