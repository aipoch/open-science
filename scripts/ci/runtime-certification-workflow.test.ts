import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  'continue-on-error'?: string
  if?: string
  needs?: string | string[]
  'runs-on'?: string
  steps?: Step[]
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const workflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')) as Workflow

const step = (job: Job, name: string): Step => {
  const result = job.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing step: ${name}`)
  return result
}

describe('runtime certification workflow', () => {
  it('provides one reusable, manually dispatchable, read-only Linux source lane', () => {
    const runtime = workflow('runtime-certification.yml')
    const source = runtime.jobs.source

    expect(runtime.on).toHaveProperty('workflow_call')
    expect(runtime.on).toHaveProperty('workflow_dispatch')
    expect(runtime.permissions).toEqual({ contents: 'read' })
    expect(runtime.concurrency).toEqual({
      group: 'runtime-certification-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(source).toMatchObject({
      'continue-on-error': '${{ inputs.allow_failure }}',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20
    })
  })

  it('uses pinned micromamba to provision real Python and R prerequisites', () => {
    const source = workflow('runtime-certification.yml').jobs.source
    const install = step(source, 'Install test dependencies')
    const fetch = step(source, 'Fetch pinned micromamba')
    const create = step(source, 'Create real Python and R environments')
    const verify = step(source, 'Verify runtime prerequisites')

    expect(install.run).toBe('node scripts/ci/npm-ci.mjs')
    expect(fetch.run).toContain('scripts/fetch-micromamba.mjs linux-64')
    expect(create.run).toContain('python=3.12 matplotlib-base nomkl')
    expect(create.run).toContain('r-base=4.4 r-jsonlite r-ggplot2')
    expect(create.run).toContain('OPEN_SCIENCE_TEST_PY_ENV=')
    expect(create.run).toContain('OPEN_SCIENCE_TEST_R_ENV=')
    expect(verify.run).toContain('library(jsonlite)')
    expect(verify.run).toContain('library(ggplot2)')
  })

  it('activates the explicit real runtime suites without package or publication side effects', () => {
    const source = workflow('runtime-certification.yml').jobs.source
    const test = step(source, 'Test real source runtime chain')
    const allRuns = source.steps?.map(({ run }) => run ?? '').join('\n') ?? ''

    expect(test.env).toEqual({ RUN_KERNEL: '1' })
    for (const file of [
      'repl-loop.integration.test.ts',
      'host-compute.integration.test.ts',
      'host-mcp.integration.test.ts',
      'python-loop.integration.test.ts',
      'r-loop.integration.test.ts',
      'e2e.certification.test.ts',
      'agents-repl.integration.test.ts',
      'agents-repl.mutations.integration.test.ts',
      'agents-repl.privileged.integration.test.ts',
      'agents-repl.runtime-consumption.integration.test.ts'
    ]) {
      expect(test.run).toContain(file)
    }
    expect(test.run).not.toContain('full-stack.smoke.test.ts')
    expect(allRuns).not.toMatch(/aws s3|gh release|npm publish|softprops\/action-gh-release/)
  })

  it('exposes the exact Nightly caller as a focused dry-run without gating publication', () => {
    const nightly = workflow('nightly.yml')
    const dispatch = nightly.on?.workflow_dispatch as {
      inputs?: { dry_run?: { default?: string; options?: string[] } }
    }
    const runtime = nightly.jobs['runtime-certification']

    expect(dispatch.inputs?.dry_run).toMatchObject({
      default: 'full',
      options: ['full', 'runtime-source', 'macos-x64']
    })
    expect(nightly.jobs.build.if).toContain("inputs.dry_run != 'runtime-source'")
    expect(runtime).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_build == 'true' && inputs.dry_run != 'macos-x64'",
      uses: './.github/workflows/runtime-certification.yml',
      with: { allow_failure: "${{ github.event_name != 'workflow_dispatch' }}" }
    })
    expect(nightly.jobs.prepare.needs).toEqual(['plan', 'build', 'package-smoke'])
    expect(workflow('release.yml').jobs).not.toHaveProperty('runtime-certification')
  })
})
