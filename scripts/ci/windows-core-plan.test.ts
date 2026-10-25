import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  classifyChanges,
  platformExecutionPlan,
  toGitHubOutputPlan
} from './classify-pr-changes.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { resolveAuthoritativePlan } from './module-impact-shadow.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'
import {
  selectWindowsCoreChecks,
  windowsCoreChecks,
  validWindowsCoreChecks
} from './windows-core-plan.mjs'

const manifest = loadModuleImpactManifest()
const select = (
  paths: string[],
  event = 'pull_request',
  status = 'modified'
): ReturnType<typeof selectWindowsCoreChecks> => {
  const changes = paths.map((path) => ({ path, status }))
  const modulePlan = createAffectedTestPlan(
    changes,
    { status: 'unavailable-manifest-only', testFiles: [] },
    manifest
  )
  const plan = platformExecutionPlan(
    resolveAuthoritativePlan(classifyChanges(changes), modulePlan),
    changes,
    event
  )
  return selectWindowsCoreChecks(plan, modulePlan, changes, manifest, event)
}
const core = select(['src/main/literature/catalog.ts'])

describe('Windows core impact and event selection', () => {
  it('keeps all native checks for the reclassified literature boundary on PRs and in queue', () => {
    expect(core.windowsCoreChecks).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
    const queue = select(['src/main/literature/catalog.ts'], 'merge_group')
    expect(queue.windowsCoreChecks).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
  })

  it.each([
    ['scripts/build-notebook-host.mjs', ['windows_runtime']],
    ['scripts/windows-dev-notebook-host.integration.test.ts', ['windows_runtime']],
    [
      'src/main/notebook/shell-runtime.ts',
      ['windows_shell', 'windows_service_timeout', 'windows_sandbox']
    ],
    ['src/main/acp/runtime.ts', ['windows_process']],
    ['src/main/delegation/process-ownership.ts', ['windows_process']],
    ['packages/environment/src/pip-wheel-evidence.ts', ['windows_wheel_evidence']],
    ['packages/notebook-network-sandbox/vendor/windows-src/src/main.rs', ['windows_sandbox']],
    ['src/main/notebook/windows-shell.integration.test.ts', ['windows_shell']]
  ])('retains early native checks for direct input %s', (path, checks) => {
    const plan = select([path])
    expect(plan.windowsCoreChecks).toEqual(expect.arrayContaining(checks))
    expect(validWindowsCoreChecks(plan)).toBe(true)
  })

  it('keeps the native build prerequisite when shell tests are selected', () => {
    expect(select(['src/main/notebook/shell-runtime.ts']).windowsCoreChecks).toEqual(
      expect.arrayContaining(['windows_sandbox_source', 'windows_sandbox_build'])
    )
  })

  it.each(['deleted', 'renamed', 'unknown'])('keeps all core checks for %s changes', (status) => {
    expect(
      select(['src/main/notebook/shell-runtime.ts'], 'pull_request', status).windowsCoreChecks
    ).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
  })

  it.each([
    'package.json',
    'src/main/unregistered-windows-helper.ts',
    'scripts/ci/windows-core-plan.mjs'
  ])('keeps full checks for uncertain or shared input %s', (path) => {
    expect(select([path]).windowsCoreChecks).toEqual(
      expect.arrayContaining(Object.keys(windowsCoreChecks))
    )
  })

  it('keeps manual and reclassified renderer coverage without introducing core for docs', () => {
    expect(
      select(['src/main/literature/catalog.ts'], 'workflow_dispatch').windowsCoreChecks
    ).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
    expect(select(['docs/testing.md']).windowsCoreChecks).toBeUndefined()
    expect(
      select(['src/renderer/src/pages/literature/LiteratureLibraryPage.tsx']).windowsCoreChecks
    ).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
  })

  it('selects the union of stacked merge-group changes', () => {
    const paths = [
      'src/main/literature/catalog.ts',
      'packages/environment/src/pip-wheel-evidence.ts'
    ]
    const union = select(paths, 'merge_group').windowsCoreChecks
    for (const path of paths)
      expect(union).toEqual(expect.arrayContaining(select([path], 'merge_group').windowsCoreChecks))
  })

  it.each(['pull_request', 'merge_group'])(
    'does not widen %s core checks for a Playwright-only input in a mixed diff',
    (event) => {
      const source = select(['src/main/literature/catalog.ts'], event)
      const mixed = select(
        ['src/main/literature/catalog.ts', 'e2e/desktop-runtime-recovery.spec.ts'],
        event
      )
      expect(mixed.windowsCoreChecks).toEqual(source.windowsCoreChecks)
      expect(select(['e2e/fixtures/new-unattributed-helper.ts'], event).mode).toBe('full')
    }
  )

  it('falls back when a platform overlay has no mapped evidence', () => {
    const plan = selectWindowsCoreChecks(
      core,
      { mode: 'selective', testFiles: [] },
      [{ path: 'src/main/example.ts', status: 'modified' }],
      {
        modules: {
          example: { ownerPaths: ['src/main/example.ts'], testFiles: { owner: [], contract: [] } }
        }
      },
      'pull_request'
    )
    expect(plan.windowsCoreChecks).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
  })

  it('preserves compact output and rejects empty, unknown, duplicate, or incomplete selections', () => {
    expect(toGitHubOutputPlan(core).windowsCoreChecks).toEqual(core.windowsCoreChecks)
    for (const checks of [
      [],
      ['unknown'],
      ['windows_path', 'windows_path'],
      ['windows_shell'],
      ['windows_sandbox_build']
    ]) {
      const plan = { ...toGitHubOutputPlan(core), windowsCoreChecks: checks }
      const conclusions = Object.fromEntries(
        ['preflight', ...plan.bundles].map((name) => [name, 'success'])
      )
      expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(false)
    }
    expect(validWindowsCoreChecks(core)).toBe(true)
  })
})

type Step = { id?: string; name: string; if?: string; run?: string; env?: Record<string, string> }
const workflow = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>
}
const steps = workflow.jobs.windows_core.steps
it('keeps every Windows core test registered with its actual workflow step', () => {
  const selectedSteps = steps.filter(({ id }) => id && Object.hasOwn(windowsCoreChecks, id))
  expect(selectedSteps).toHaveLength(Object.keys(windowsCoreChecks).length)
  for (const step of selectedSteps) {
    const tests = [...new Set(step.run?.match(/[\w./-]+\.test\.ts/g) ?? [])]
    expect(windowsCoreChecks[step.id!].tests).toEqual(tests)
    expect(step.if).toContain(`windowsCoreChecks, '${step.id}'`)
    expect(step.if).toContain('!fromJSON(needs.preflight.outputs.plan).windowsCoreChecks')
  }
})

it.skipIf(process.platform === 'win32')(
  'fails selected-but-skipped checks and accepts only intentional omissions',
  () => {
    const enforce = steps.find(({ name }) => name === 'Enforce selected Windows core checks')!
    const outcomes = Object.fromEntries(
      Object.keys(enforce.env!)
        .filter((key) => key.endsWith('_OUTCOME'))
        .map((key) => [key, 'skipped'])
    )
    const run = (extra: Record<string, string>): ReturnType<typeof spawnSync> =>
      spawnSync('bash', ['-c', enforce.run!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...outcomes,
          WINDOWS_CORE_CHECKS: '["windows_process"]',
          WINDOWS_PROCESS_ONLY: 'false',
          WINDOWS_RUNTIME_SELECTED: 'true',
          WINDOWS_PATH_SELECTED: 'false',
          ...extra
        }
      })
    expect(run({}).status).toBe(1)
    expect(run({ WINDOWS_PROCESS_OUTCOME: 'success' }).status).toBe(0)
    expect(
      run({ WINDOWS_PROCESS_OUTCOME: 'success', WINDOWS_SHELL_OUTCOME: 'failure' }).status
    ).toBe(1)
    expect(run({ WINDOWS_CORE_CHECKS: 'null' }).status).toBe(1)
    expect(
      run({
        WINDOWS_CORE_CHECKS: 'null',
        WINDOWS_PROCESS_ONLY: 'true',
        WINDOWS_PROCESS_OUTCOME: 'success'
      }).status
    ).toBe(0)
  }
)
