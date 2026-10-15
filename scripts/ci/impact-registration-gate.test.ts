import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import config from './vitest.registration.config'

type Step = {
  name?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  env?: Record<string, string>
  uses?: string
  with?: Record<string, unknown>
}
type Job = {
  if?: string
  needs?: string[]
  'continue-on-error'?: boolean
  steps: Step[]
}
const workflow = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
  jobs: Record<string, Job>
  on: Record<string, unknown>
}
const gate = workflow.jobs.gate.steps.find(
  ({ name }) => name === 'Evaluate deterministic gate from trusted base'
)!

describe('fixed impact-registration gate', () => {
  it('keeps the complete registration inventory independent of affected-test selection', () => {
    expect(config.test?.include).toEqual([
      'scripts/ci/impact-registration-gate.test.ts',
      'scripts/ci/validate-module-impact.test.ts',
      'scripts/ci/audit-module-ownership.test.ts',
      'scripts/ci/module-consumer-coverage.test.ts',
      'scripts/ci/package-boundaries.test.ts',
      'scripts/ci/classify-pr-changes.test.ts',
      'scripts/ci/platform-risk-gates.test.ts',
      'scripts/ci/windows-core-plan.test.ts'
    ])
    for (const path of config.test!.include!) expect(existsSync(path), path).toBe(true)
    expect(config.test).toMatchObject({
      environment: 'node',
      setupFiles: [],
      allowOnly: false,
      passWithNoTests: false
    })
  })

  it('runs on PRs and merge groups without preflight selection or application builds', () => {
    expect(workflow.on).toHaveProperty('pull_request')
    expect(workflow.on).toHaveProperty('merge_group')
    const job = workflow.jobs.registration
    expect(job.if).toBeUndefined()
    expect(job.needs).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    for (const step of job.steps) {
      expect(step.if).toBeUndefined()
      expect(step['continue-on-error']).toBeUndefined()
    }
    expect(job.steps.flatMap(({ run }) => (run ? [run] : []))).toEqual([
      'npm ci --ignore-scripts --no-audit',
      'npx vitest run --config scripts/ci/vitest.registration.config.ts'
    ])
    expect(job.steps.find(({ uses }) => uses?.startsWith('actions/checkout@'))?.with).toEqual({
      'persist-credentials': false
    })
    expect(workflow.jobs.gate.needs).toContain('registration')
    expect(gate.env?.REGISTRATION_RESULT).toBe('${{ needs.registration.result }}')
  })

  it.each(['pull_request', 'merge_group'])(
    'requires registration success before the trusted evaluator for %s',
    (event) => {
      const root = mkdtempSync(join(tmpdir(), 'registration-gate-'))
      try {
        mkdirSync(join(root, 'scripts/ci'), { recursive: true })
        writeFileSync(join(root, 'scripts/ci/evaluate-pr-gate.mjs'), "console.log('evaluated')")
        for (const result of ['failure', 'cancelled', 'skipped', '', 'success']) {
          const run = spawnSync('bash', ['-c', gate.run!], {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              EVENT_NAME: event,
              PREFLIGHT_RESULT: 'success',
              REGISTRATION_RESULT: result,
              RUNTIME_REQUIRED: 'false',
              PACKAGE_RESULT: 'success'
            }
          })
          expect(run.status, `${result}: ${run.stderr}`).toBe(result === 'success' ? 0 : 1)
          if (result === 'success') expect(run.stdout).toContain('evaluated')
          else {
            expect(run.stderr).toContain('Impact registration ended with')
            expect(run.stdout).not.toContain('evaluated')
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
