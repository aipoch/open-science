import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { JSONReport } from '@playwright/test/reporter'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
type Job = {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on': string
  'timeout-minutes'?: number
  strategy?: { 'fail-fast': boolean; matrix: { shard: number[] | string } }
  steps: Step[]
}
const readWorkflow = (
  file: string
): {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, Job>
} => load(readFileSync(`.github/workflows/${file}`, 'utf8')) as ReturnType<typeof readWorkflow>
const workflow = readWorkflow('windows-e2e-regression.yml')
const pr = readWorkflow('pr-gate.yml')
const step = (job: Job, name: string): Step =>
  job.steps.find((candidate) => candidate.name === name)!
const suites = [
  ['renderer_layout', 'test:e2e:browser', 0],
  ['e2e_functional_windows', 'test:e2e:journey', 11],
  ['e2e_workspace_windows', 'test:e2e:workspace', 6]
] as const

it('schedules independent complete Windows E2E and keeps the manual full entry point', () => {
  expect(workflow.on.schedule).toEqual([{ cron: '17 18 * * *' }])
  expect(workflow.on.workflow_dispatch).toEqual({
    inputs: {
      workspace_test_pattern: {
        description:
          'Optional workspace test regex for a single-runner diagnostic (10 repetitions)',
        type: 'string',
        default: ''
      }
    }
  })
  expect(workflow.jobs.windows_e2e).toMatchObject({
    'runs-on': 'windows-latest',
    needs: ['plan', 'windows_e2e_setup'],
    strategy: {
      'fail-fast': false,
      matrix: {
        shard:
          "${{ fromJSON(github.event_name == 'workflow_dispatch' && inputs.workspace_test_pattern != '' && '[1]' || '[1,2,3]') }}"
      }
    }
  })
  const preparation = workflow.jobs.windows_e2e_setup
  expect(preparation.needs).toEqual(['plan', 'windows_notebook_runtime'])
  expect(workflow.jobs.windows_notebook_runtime).toMatchObject({
    needs: 'plan',
    if: "${{ needs.plan.outputs.should_test == 'true' }}",
    uses: './.github/workflows/windows-notebook-runtime.yml'
  })
  expect(preparation.if).toContain("needs.plan.outputs.should_test == 'true'")
  expect(preparation.steps).toEqual(pr.jobs.windows_e2e_setup.steps)
  const execution = workflow.jobs.windows_e2e
  expect(execution.if).toContain("needs.windows_e2e_setup.result == 'success'")
  for (const name of ['Setup Node', 'Download E2E setup', 'Restore E2E setup']) {
    expect(step(execution, name)).toEqual(step(pr.jobs.windows_e2e, name))
  }
  for (const [id, command] of suites) {
    const run = execution.steps.find((candidate) => candidate.id === id)!
    expect(run.if).toBe(
      "${{ steps.setup.outcome == 'success' && (github.event_name != 'workflow_dispatch' || inputs.workspace_test_pattern == '') }}"
    )
    expect(run.run).toContain(`npm run ${command} --`)
    expect(run.run).toContain('--workers=1')
    expect(run.run).toContain('--shard=${{ matrix.shard }}/3')
    expect(run.run).toContain('--fail-on-flaky-tests')
    expect(run.run).not.toContain('--grep')
    expect(run.run).not.toContain('--pass-with-no-tests')
  }
  expect(step(execution, 'Upload E2E timing and blob reports')).toMatchObject({
    if: '${{ always() }}',
    with: { name: 'e2e-reports-windows-${{ matrix.shard }}', 'retention-days': 5 }
  })
})

it('budgets complete serial journeys and teardown within the shard job', () => {
  const execution = workflow.jobs.windows_e2e
  const budgets = suites.map(([id]) => {
    const run = execution.steps.find((candidate) => candidate.id === id)!.run!
    return Number(run.match(/--global-timeout=(\d+)/)![1])
  })
  expect(budgets).toEqual([420000, 900000, 900000])
  // Leave time for restore, Chromium installation, uploads and teardown beyond suite budgets.
  expect(
    execution['timeout-minutes']! * 60000 - budgets.reduce((a, b) => a + b, 0)
  ).toBeGreaterThanOrEqual(180000)
})

it('fails a scheduled shard when setup or any required suite does not succeed', () => {
  const enforce = step(workflow.jobs.windows_e2e, 'Enforce complete Windows E2E suites')
  expect(enforce.if).toBe(
    "${{ always() && (github.event_name != 'workflow_dispatch' || inputs.workspace_test_pattern == '') }}"
  )
  const baseline = Object.fromEntries(Object.keys(enforce.env!).map((key) => [key, 'success']))
  for (const key of Object.keys(baseline)) {
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const result = spawnSync('bash', ['-c', enforce.run!], {
        encoding: 'utf8',
        env: { ...process.env, ...baseline, [key]: outcome }
      })
      expect(result.status, `${key}: ${outcome}`).toBe(outcome === 'success' ? 0 : 1)
    }
  }
})

it('isolates manual workspace diagnostics while retaining full scheduled coverage', () => {
  const execution = workflow.jobs.windows_e2e
  const diagnostic = step(execution, 'Diagnose selected workspace journey')
  const diagnosticGate = step(execution, 'Enforce workspace diagnostic')
  const fullGate = step(execution, 'Enforce complete Windows E2E suites')
  const evaluate = (expression: string, event: string, pattern: string): unknown =>
    runInNewContext(expression.slice(3, -2), {
      github: { event_name: event },
      inputs: { workspace_test_pattern: pattern },
      steps: { setup: { outcome: 'success' } },
      always: () => true,
      fromJSON: JSON.parse
    })
  for (const event of ['schedule', 'workflow_dispatch']) {
    for (const pattern of ['', 'finds offscreen cells']) {
      const focused = event === 'workflow_dispatch' && pattern !== ''
      expect(evaluate(String(execution.strategy!.matrix.shard), event, pattern)).toEqual(
        focused ? [1] : [1, 2, 3]
      )
      expect(evaluate(diagnostic.if!, event, pattern)).toBe(focused)
      expect(evaluate(diagnosticGate.if!, event, pattern)).toBe(focused)
      expect(evaluate(fullGate.if!, event, pattern)).toBe(!focused)
      for (const [id] of suites) {
        expect(
          evaluate(execution.steps.find((candidate) => candidate.id === id)!.if!, event, pattern)
        ).toBe(!focused)
      }
    }
  }
  expect(diagnostic.env?.TEST_PATTERN).toBe('${{ inputs.workspace_test_pattern }}')
  expect(diagnostic.run).toContain('--grep "$TEST_PATTERN"')
  expect(diagnostic.run).toContain('--repeat-each=10 --retries=0')
  expect(diagnostic.run).not.toContain('--pass-with-no-tests')
  expect(diagnostic.run).not.toContain('--shard')
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = spawnSync('bash', ['-c', diagnosticGate.run!], {
      encoding: 'utf8',
      env: { ...process.env, SETUP: 'success', DIAGNOSTIC: outcome }
    })
    expect(result.status).toBe(outcome === 'success' ? 0 : 1)
  }
})

it('reports scheduled failures with the shared issue lifecycle and never closes on skipped coverage', () => {
  const { report, ...jobs } = workflow.jobs
  expect(report.needs).toEqual(Object.keys(jobs))
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
  expect(report.permissions).toEqual({ contents: 'read', issues: 'write' })
  for (const job of Object.values(jobs)) expect(job.permissions).toBeUndefined()
  const reporter = step(report, 'Open, refresh, or close the tracking issue')
  expect(reporter.with?.script).toContain("workflowFile: 'windows-e2e-regression.yml'")
  expect(reporter.with?.script).toContain('await reportScheduledOutcome({')
  expect(reporter.with?.script).toContain('/scripts/ci/report-scheduled-failure.mjs')
  const evaluate = (
    expression: string,
    event: string,
    results: Record<string, string>,
    selected = 'true'
  ): unknown =>
    runInNewContext(expression.slice(3, -2), {
      github: { event_name: event },
      always: () => true,
      needs: Object.fromEntries(
        Object.entries(results).map(([id, result]) => [
          id,
          { result, outputs: { should_test: selected } }
        ])
      )
    })
  const successful = Object.fromEntries(Object.keys(jobs).map((id) => [id, 'success']))
  expect(evaluate(report.if!, 'schedule', successful)).toBe(true)
  expect(evaluate(report.if!, 'workflow_dispatch', successful)).toBe(false)
  expect(evaluate(report.if!, 'schedule', successful, 'false')).toBe(false)
  expect(evaluate(reporter.env!.CONCLUSION, 'schedule', successful)).toBe('success')
  for (const id of Object.keys(jobs)) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const results = { ...successful, [id]: result }
      expect(evaluate(reporter.env!.CONCLUSION, 'schedule', results)).toBe('failure')
    }
  }
  expect(evaluate(report.if!, 'schedule', { ...successful, plan: 'failure' }, '')).toBe(true)
  for (const job of Object.values(workflow.jobs)) {
    for (const candidate of job.steps ?? []) {
      if (candidate.uses && !candidate.uses.startsWith('./')) {
        expect(candidate.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/)
      }
    }
  }
})

it('discovers the reviewed mainline subset and retains every other case in the full commands', () => {
  const require = createRequire(import.meta.url)
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
  const collect = (command: string, grep?: string): string[] => {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        ...scripts[command].split(/\s+/).slice(1),
        '--list',
        '--reporter=json',
        ...(grep ? ['--grep', grep] : [])
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }
    )
    expect(result.status, result.stderr).toBe(0)
    const visit = (suites: JSONReport['suites']): string[] =>
      suites.flatMap((suite) => [
        ...suite.specs.map((spec) => `${spec.file}: ${spec.title}`),
        ...visit(suite.suites ?? [])
      ])
    return visit((JSON.parse(result.stdout) as JSONReport).suites).sort()
  }
  for (const [group, count] of Object.entries({
    projects: 3,
    conversation: 2,
    files: 5,
    notebook: 1,
    windows: 6
  })) {
    const selected = collect('test:e2e', `@pr-mainline-${group}(?:\\s|$)`)
    expect(selected).toHaveLength(count)
    if (group === 'windows') {
      expect(selected.join('\n')).toContain(
        'opens the whole-window find overlay with Ctrl+F in a workspace @pr-mainline-windows'
      )
    }
  }
  for (const [, command, count] of suites) {
    const full = collect(command)
    const mainline = count ? collect(command, '@pr-mainline-') : []
    expect(mainline).toHaveLength(count)
    expect(mainline).toEqual(full.filter((title) => title.includes(' @pr-mainline-')))
    expect(full.length).toBeGreaterThan(mainline.length)
    expect(new Set(mainline).size).toBe(mainline.length)
  }
}, 90_000)
