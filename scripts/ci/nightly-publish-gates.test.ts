import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateNightlyPublishGates, formatNightlyPublishGates } from './nightly-publish-gates.mjs'

// Job names mirror the GitHub jobs API for a scheduled Nightly run (`<caller> / <callee name>`).
const passing = [
  { name: 'Check for unpublished main changes', conclusion: 'success' },
  { name: 'build / Build macos-arm64', conclusion: 'success' },
  { name: 'runtime-certification / Source runtime chain (Linux)', conclusion: 'success' },
  { name: 'package-smoke / Smoke linux-x64', conclusion: 'success' },
  { name: 'regression / Resolve source build', conclusion: 'success' },
  { name: 'regression / p0 (macos-arm64 artifact)', conclusion: 'success' },
  { name: 'regression / visual (canonical macos-14 source build)', conclusion: 'success' },
  { name: 'Prepare nightly publish artifact', conclusion: 'success' }
]

type Job = { name: string; conclusion: string | null }

const withConclusion = (name: string, conclusion: string | null): Job[] =>
  passing.map((job) => (job.name === name ? { ...job, conclusion } : job))

describe('nightly publication gates', () => {
  it('passes when every runtime-certification and regression job succeeded', () => {
    expect(evaluateNightlyPublishGates(passing)).toEqual({ ok: true, blocking: [] })
  })

  it('blocks on a failed advisory job even though the Nightly run concluded success', () => {
    const result = evaluateNightlyPublishGates(
      withConclusion('runtime-certification / Source runtime chain (Linux)', 'failure')
    )
    expect(result).toEqual({
      ok: false,
      blocking: [
        { name: 'runtime-certification / Source runtime chain (Linux)', conclusion: 'failure' }
      ]
    })
  })

  it.each(['cancelled', 'timed_out', 'skipped', null])(
    'blocks a regression job that concluded %s',
    (conclusion) => {
      const result = evaluateNightlyPublishGates(
        withConclusion('regression / p0 (macos-arm64 artifact)', conclusion)
      )
      expect(result.ok).toBe(false)
      expect(result.blocking).toEqual([
        { name: 'regression / p0 (macos-arm64 artifact)', conclusion: conclusion ?? 'unknown' }
      ])
    }
  )

  it('blocks when a gated caller job was skipped and appears as its bare id', () => {
    const jobs = [
      { name: 'Check for unpublished main changes', conclusion: 'success' },
      { name: 'runtime-certification', conclusion: 'skipped' },
      { name: 'regression', conclusion: 'skipped' }
    ]
    expect(evaluateNightlyPublishGates(jobs).blocking).toEqual([
      { name: 'runtime-certification', conclusion: 'skipped' },
      { name: 'regression', conclusion: 'skipped' }
    ])
  })

  it('fails closed when a gated job family is absent from the run', () => {
    const jobs = passing.filter((job) => !job.name.startsWith('regression'))
    expect(evaluateNightlyPublishGates(jobs).blocking).toEqual([
      { name: 'regression', conclusion: 'missing' }
    ])
  })

  it('does not treat unrelated jobs sharing a word as gates', () => {
    const jobs = [
      ...passing,
      { name: 'regression-notes', conclusion: 'failure' },
      { name: 'build / regression fixtures', conclusion: 'failure' }
    ]
    expect(evaluateNightlyPublishGates(jobs).ok).toBe(true)
  })

  it('reports every blocking job in the summary', () => {
    const summary = formatNightlyPublishGates({
      ok: false,
      blocking: [
        { name: 'regression / visual (canonical macos-14 source build)', conclusion: 'failure' },
        { name: 'runtime-certification', conclusion: 'skipped' }
      ]
    })
    expect(summary).toContain('- regression / visual (canonical macos-14 source build): failure')
    expect(summary).toContain('- runtime-certification: skipped')
  })

  it('writes ok to GITHUB_OUTPUT from the CLI without failing the step', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-publish-gates-'))
    try {
      const jobsPath = join(root, 'jobs.json')
      const outputPath = join(root, 'output.txt')
      writeFileSync(
        jobsPath,
        JSON.stringify(
          withConclusion('regression / visual (canonical macos-14 source build)', 'failure')
        )
      )
      writeFileSync(outputPath, '')
      const run = spawnSync(
        process.execPath,
        [resolve('scripts/ci/nightly-publish-gates.mjs'), '--jobs', jobsPath],
        { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputPath } }
      )
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('regression / visual (canonical macos-14 source build): failure')
      expect(readFileSync(outputPath, 'utf8')).toBe('ok=false\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports advisory failures but ignores absent or skipped gates', () => {
    const failed = withConclusion('runtime-certification / Source runtime chain (Linux)', 'failure')
    expect(
      evaluateNightlyPublishGates(failed, undefined, { requireCoverage: false })
    ).toMatchObject({
      ok: false,
      blocking: [{ name: 'runtime-certification / Source runtime chain (Linux)' }]
    })

    // A run that skipped the build has nothing to report, unlike publication which fails closed.
    const skipped = [{ name: 'Check for unpublished main changes', conclusion: 'success' }]
    expect(evaluateNightlyPublishGates(skipped, undefined, { requireCoverage: false })).toEqual({
      ok: true,
      blocking: []
    })
    expect(evaluateNightlyPublishGates(skipped)).toMatchObject({ ok: false })
    expect(
      evaluateNightlyPublishGates(
        withConclusion('regression / p0 (macos-arm64 artifact)', null),
        undefined,
        { requireCoverage: false }
      )
    ).toEqual({ ok: true, blocking: [] })
  })

  it('exits non-zero when the jobs file is not provided', () => {
    const run = spawnSync(process.execPath, [resolve('scripts/ci/nightly-publish-gates.mjs')], {
      encoding: 'utf8'
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('--jobs')
  })
})
