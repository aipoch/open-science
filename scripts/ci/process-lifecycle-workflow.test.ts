import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

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

it('runs the three-platform fixed collection daily without an unchanged-SHA bypass or PR trigger', () => {
  expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
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
  expect(run.run).toContain('node scripts/ci/run-process-lifecycle.mjs')
  expect(run.if).toContain("github.event_name == 'schedule'")
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
