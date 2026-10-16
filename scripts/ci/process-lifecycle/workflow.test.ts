import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import lifecycleConfig from './vitest.config'

const text = readFileSync('.github/workflows/process-lifecycle.yml', 'utf8')
const workflow = load(text) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string
      permissions?: Record<string, string>
      strategy?: { 'fail-fast': boolean; matrix: { include: Array<{ platform: string }> } }
      steps: Array<{
        name: string
        uses?: string
        if?: string
        run?: string
        env?: Record<string, string>
        with?: Record<string, unknown>
      }>
    }
  >
}

it('discovers the native suite only through its dedicated configuration', () => {
  const discover = (args: string[]): string[] => {
    const result = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json', ...args],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout).map((file: { file: string }) =>
      file.file.replaceAll('\\', '/')
    )
  }
  const suite = 'scripts/ci/process-lifecycle/lifecycle.suite.ts'
  expect(discover(['--config', 'scripts/ci/process-lifecycle/vitest.config.ts'])).toEqual([
    expect.stringContaining(suite)
  ])
  const portable = discover([])
  expect(portable.some((file) => file.endsWith(suite))).toBe(false)
  expect(portable.some((file) => file.endsWith('process-lifecycle/workflow.test.ts'))).toBe(true)
  expect(lifecycleConfig.test.allowOnly).toBe(false)
  expect(lifecycleConfig.test.passWithNoTests).toBe(false)
}, 60000)

it('runs the three-platform fixed collection daily without an unchanged-SHA bypass', () => {
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch'])
  expect(workflow.on.schedule).toEqual([{ cron: '23 19 * * *' }])
  expect(workflow.jobs.lifecycle.strategy?.matrix.include.map((row) => row.platform)).toEqual([
    'macos',
    'linux',
    'windows'
  ])
  expect(workflow.jobs.lifecycle.strategy?.['fail-fast']).toBe(false)
  expect(text).not.toMatch(/skip-unchanged|continue-on-error|contents: write|perf:runtime/)
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const run = workflow.jobs.lifecycle.steps.find((step) => step.name === 'Run lifecycle checks')!
  expect(run.run).toContain('node scripts/ci/process-lifecycle/run.mjs')
  expect(run.if).toContain("github.event_name != 'workflow_dispatch'")
})

it('validates only lifecycle PR changes at the exact head and retains manual platform selection', () => {
  expect(workflow.on.pull_request).toEqual({
    paths: ['.github/workflows/process-lifecycle.yml', 'scripts/ci/process-lifecycle/**']
  })
  const checkout = workflow.jobs.lifecycle.steps.find((step) => step.name === 'Checkout')!
  expect(checkout.with?.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}')
  expect(checkout.with?.['persist-credentials']).toBe(false)
  for (const step of workflow.jobs.lifecycle.steps) {
    expect(step.if).toContain("github.event_name != 'workflow_dispatch'")
    expect(step.if).toContain("inputs.platform == 'all' || inputs.platform == matrix.platform")
  }
})

it('retains evidence on failure and uses the existing reporter only for complete scheduled outcomes', () => {
  const upload = workflow.jobs.lifecycle.steps.find(
    (step) => step.name === 'Upload process evidence'
  )!
  expect(upload.if).toContain('always()')
  expect(upload.with?.['if-no-files-found']).toBe('error')
  expect(workflow.jobs.report.needs).toBe('lifecycle')
  expect(workflow.jobs.report.if).toBe("${{ always() && github.event_name == 'schedule' }}")
  expect(workflow.jobs.report.permissions).toEqual({ contents: 'read', issues: 'write' })
  const reporter = workflow.jobs.report.steps.at(-1)!
  expect(reporter.env?.CONCLUSION).toBe(
    "${{ needs.lifecycle.result == 'success' && 'success' || 'failure' }}"
  )
  expect(reporter.with?.script).toContain('report-scheduled-failure.mjs')
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
    }
})
