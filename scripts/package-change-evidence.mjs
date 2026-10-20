/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModuleImpactManifestAtRevision } from './ci/load-module-impact.mjs'

export function changedPackagePaths(base, head, cwd = process.cwd()) {
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
    cwd,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean)
}

export function classifyPackageChange(paths, manifests) {
  const modules = new Set()
  const interfaces = new Set()
  const unknown = []
  for (const path of paths) {
    let owned = false
    for (const manifest of manifests)
      for (const [id, module] of Object.entries(manifest.modules)) {
        if (module.ownerPaths.includes(path)) {
          modules.add(id)
          owned = true
        }
        if (module.interfacePaths?.includes(path)) interfaces.add(path)
      }
    if (!owned) unknown.push(path)
  }
  const host = paths.some((path) => path.startsWith('src/'))
  const packages = paths.some((path) => path.startsWith('packages/'))
  return {
    category: unknown.length
      ? 'mixed-or-uncertain'
      : interfaces.size
        ? 'public-contract-candidate'
        : host && packages
          ? 'mixed-or-uncertain'
          : packages
            ? 'package-implementation'
            : host
              ? 'host-only'
              : 'mixed-or-uncertain',
    changedModules: [...modules].sort(),
    interfaces: [...interfaces].sort(),
    unregisteredPaths: unknown
  }
}

// Inputs are exported evidence, never inferred successes or synthetic productivity measurements.
export function summarizeCi(run) {
  if (!run) return null
  const elapsed = (start, end) =>
    start && end && Date.parse(end) >= Date.parse(start)
      ? Date.parse(end) - Date.parse(start)
      : null
  const jobs = (run.jobs ?? []).map((job) => ({
    name: job.name,
    attempt: job.run_attempt ?? null,
    startedAt: job.started_at,
    conclusion: job.conclusion,
    runner: job.runner_name ?? null,
    durationMs: elapsed(job.started_at, job.completed_at),
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      conclusion: step.conclusion,
      durationMs: elapsed(step.started_at, step.completed_at)
    }))
  }))
  const consistentAttempt = jobs.every(
    (job) =>
      (job.attempt === run.run_attempt || ((run.run_attempt ?? 1) === 1 && job.attempt === null)) &&
      (job.conclusion === 'skipped' ||
        !run.run_started_at ||
        (job.startedAt && Date.parse(job.startedAt) >= Date.parse(run.run_started_at)))
  )
  const executed = jobs.filter((job) => job.conclusion !== 'skipped')
  return {
    url: run.html_url,
    head: run.head_sha,
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    consistentAttempt,
    queueMs: (run.run_attempt ?? 1) === 1 ? elapsed(run.created_at, run.run_started_at) : null,
    // updated_at may include later metadata changes; do not label it execution duration.
    executionMs:
      consistentAttempt && executed.length && executed.every((job) => job.durationMs !== null)
        ? elapsed(
            run.run_started_at,
            run.jobs
              .map((job) => job.completed_at)
              .sort()
              .at(-1)
          )
        : null,
    jobWorkMs:
      consistentAttempt && executed.length && executed.every((job) => job.durationMs !== null)
        ? executed.reduce((sum, job) => sum + job.durationMs, 0)
        : null,
    jobs
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (!option('base') || !option('head') || !option('output'))
    throw new Error(
      'Use --base=SHA --head=SHA --output=report.json [--builds=file.json] [--ci=file.json]'
    )
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const base = git('rev-parse', '--verify', `${option('base')}^{commit}`)
  const head = git('rev-parse', '--verify', `${option('head')}^{commit}`)
  const paths = changedPackagePaths(base, head)
  const read = (name) => (option(name) ? JSON.parse(readFileSync(option(name), 'utf8')) : null)
  const report = {
    base,
    head,
    paths,
    ...classifyPackageChange(paths, [
      loadModuleImpactManifestAtRevision(base),
      loadModuleImpactManifestAtRevision(head)
    ]),
    collectedOn: { platform: process.platform, arch: process.arch, node: process.version },
    builds: read('builds'),
    ci: summarizeCi(read('ci')),
    integrationFailures: null,
    limitations: [
      'Null means evidence unavailable, not zero. Classify integration failures manually from linked logs; failed jobs alone do not prove an integration defect.',
      'For reruns, export jobs from the attempts endpoint. Initial creation time cannot measure rerun queue time.',
      'Changed owner modules differ from selected consumer modules. Category uses declared interfaces and remains uncertain for unregistered paths.'
    ]
  }
  mkdirSync(dirname(resolve(option('output'))), { recursive: true })
  writeFileSync(option('output'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
