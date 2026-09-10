import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { JSONReport } from '@playwright/test/reporter'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const workflows = readdirSync('.github/workflows')
  .filter((file) => file.endsWith('.yml'))
  .map((file) => readFileSync(join('.github/workflows', file), 'utf8'))
  .join('\n')

it('assigns every discovered Electron spec to a workflow-reachable command', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
  const collect = (args: string[]): string[] => {
    const run = spawnSync(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json', ...args],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 10 * 1024 * 1024 }
    )
    expect(run.status, run.stderr).toBe(0)
    const visit = (suites: JSONReport['suites']): string[] =>
      suites.flatMap((suite) => [
        ...suite.specs.map((spec) => spec.file),
        ...visit(suite.suites ?? [])
      ])
    return visit((JSON.parse(run.stdout) as JSONReport).suites)
  }
  const commands = Object.entries(scripts).filter(
    ([name, command]) =>
      command.startsWith('playwright test ') &&
      !command.includes('playwright.browser.config') &&
      new RegExp(`npm run ${name}(?:\\s|$)`).test(workflows)
  )
  // The a11y wrapper owns its exact spec, and resource soak uses a direct CLI invocation.
  expect(workflows).toContain('npm run test:e2e:accessibility:signal')
  expect(workflows).toContain('npm run perf:runtime')
  expect(scripts['perf:runtime']).toContain('scripts/performance/run-runtime-profile.mjs')
  expect(readFileSync('scripts/performance/run-runtime-profile.mjs', 'utf8')).toContain(
    'e2e/runtime-performance.spec.ts'
  )
  const selected = new Set([
    ...commands.flatMap(([, command]) => collect(command.split(/\s+/).slice(2))),
    ...collect(['e2e/accessibility.spec.ts', 'e2e/runtime-performance.spec.ts'])
  ])
  expect([...new Set(collect([]))].filter((file) => !selected.has(file))).toEqual([])
}, 90_000)

it('runs controlled Windows mutations automatically and keeps them outside release gating', () => {
  const workflow = load(readFileSync('.github/workflows/windows-full-test.yml', 'utf8')) as {
    on: { schedule: unknown[]; workflow_dispatch: { inputs: { mode: { options: string[] } } } }
    jobs: Record<string, { 'runs-on': string; if: string; steps: Array<{ run?: string }> }>
  }
  const job = workflow.jobs.notebook_mutation
  expect(job).toBeDefined()
  expect(job['runs-on']).toBe('windows-latest')
  expect(workflow.on.schedule.length).toBeGreaterThan(0)
  expect(workflow.on.workflow_dispatch.inputs.mode.options).toContain('notebook-mutation')
  expect(job.if).toContain("github.event_name != 'workflow_dispatch'")
  expect(job.steps.map(({ run }) => run).join('\n')).toContain('run-notebook-lifecycle-windows.ps1')
  for (const name of ['release.yml', 'nightly.yml', 'pr-gate.yml']) {
    expect(readFileSync(join('.github/workflows', name), 'utf8')).not.toContain('notebook_mutation')
  }
})

it.each(['regressions', 'delegation'])(
  'blocks the aggregate gate unless selected %s completed successfully',
  (group) => {
    const workflow = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
      jobs: Record<
        string,
        { steps: Array<{ name: string; id?: string; if?: string; run?: string }> }
      >
    }
    const steps = workflow.jobs.macos_e2e.steps
    const execution = steps.find(({ id }) => id === `e2e_${group}_macos`)!
    expect(execution.if).toBe(
      `\${{ matrix.group == '${group}' && steps.build_electron.outcome == 'success'${group === 'regressions' ? " && steps.build_web.outcome == 'success'" : ''} }}`
    )
    expect(execution.run).toContain(`npm run test:e2e:${group} -- --fail-on-flaky-tests`)
    const enforce = steps.find(({ name }) => name === 'Enforce selected macOS checks')!
    for (const outcome of ['failure', 'cancelled', 'skipped', '', 'success']) {
      const run = spawnSync('bash', ['-c', enforce.run!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...Object.fromEntries(
            [...enforce.run!.matchAll(/\$([A-Z0-9_]+OUTCOME)/g)].map((match) => [
              match[1],
              'skipped'
            ])
          ),
          E2E_GROUP: group,
          [`E2E_${group.toUpperCase()}_OUTCOME`]: outcome
        }
      })
      expect(run.status, run.stderr).toBe(outcome === 'success' ? 0 : 1)
    }
  }
)
