/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Nightly job ids whose reusable-workflow jobs are advisory for the build but gate publication.
export const DEFAULT_GATING_PREFIXES = ['runtime-certification', 'regression']
export const PUBLICATION_PREFIXES = [
  ...DEFAULT_GATING_PREFIXES,
  'build',
  'package-smoke',
  'cli-artifacts',
  'Prepare nightly publish artifact'
]

export function validateNightlySourceRun(run, repository) {
  if (
    !repository ||
    run?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    run?.path !== '.github/workflows/nightly.yml' ||
    run?.head_branch !== 'main' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    !['schedule', 'workflow_dispatch'].includes(run?.event) ||
    !Number.isSafeInteger(run?.id) ||
    run.id < 1 ||
    !/^[a-f0-9]{40}$/.test(run?.head_sha ?? '')
  )
    throw new Error('Expected a successful same-repository Nightly build on main')
  return { source_run_id: String(run.id), source_sha: run.head_sha }
}

// Reusable-workflow jobs appear in the jobs API as `<caller-job> / <callee-job-name>`; a skipped
// caller appears as the bare caller id.
function matchesPrefix(name, prefix) {
  return name === prefix || name.startsWith(`${prefix} / `)
}

// The jobs API reports each job's actual conclusion (`failure`) even when `continue-on-error`
// masked it at the workflow level, which is what lets a `success` Nightly still block here.
// Publication requires complete runs, where no gating job is skipped by input, so by default
// anything other than `success` (including `skipped` or a missing gate) fails closed. Failure
// reporting passes `requireCoverage: false` instead: a run that skipped the build legitimately has
// nothing to report, so only an actual failed, cancelled, or timed-out job counts.
export function evaluateNightlyPublishGates(
  jobs,
  prefixes = DEFAULT_GATING_PREFIXES,
  { requireCoverage = true } = {}
) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array')
  const blocking = []
  for (const prefix of prefixes) {
    const gated = jobs.filter((job) => matchesPrefix(String(job?.name ?? ''), prefix))
    if (gated.length === 0) {
      if (requireCoverage) blocking.push({ name: prefix, conclusion: 'missing' })
      continue
    }
    for (const job of gated) {
      const conclusion = job.conclusion ?? 'unknown'
      if (conclusion === 'success') continue
      if (!requireCoverage && (conclusion === 'skipped' || conclusion === 'unknown')) continue
      blocking.push({ name: job.name, conclusion })
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
  const sourceIndex = argv.indexOf('--source-run')
  if (sourceIndex >= 0) {
    const source = validateNightlySourceRun(
      JSON.parse(readFileSync(argv[sourceIndex + 1], 'utf8')),
      environment.GITHUB_REPOSITORY
    )
    if (environment.GITHUB_OUTPUT)
      for (const [key, value] of Object.entries(source))
        appendFileSync(environment.GITHUB_OUTPUT, `${key}=${value}\n`)
    return source
  }
  const jobsIndex = argv.indexOf('--jobs')
  const jobsPath = jobsIndex >= 0 ? argv[jobsIndex + 1] : undefined
  if (!jobsPath) throw new Error('Usage: nightly-publish-gates.mjs --jobs <jobs.json> [--report]')

  const requireCoverage = !argv.includes('--report')
  const result = evaluateNightlyPublishGates(
    JSON.parse(readFileSync(jobsPath, 'utf8')),
    argv.includes('--publish') ? PUBLICATION_PREFIXES : DEFAULT_GATING_PREFIXES,
    { requireCoverage }
  )
  process.stdout.write(formatNightlyPublishGates(result))
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `ok=${result.ok}\n`)
  if (argv.includes('--publish') && !result.ok) process.exitCode = 1
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
