import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { classifyChanges, macosGroupsForPlan, toGitHubOutputPlan } from './classify-pr-changes.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { resolveAuthoritativePlan } from './module-impact-shadow.mjs'

type Step = {
  id?: string
  name: string
  run?: string
  if?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
type Job = {
  if?: string
  needs?: string
  'runs-on': string
  'continue-on-error'?: boolean
  steps: Step[]
  strategy?: { matrix: { group?: string; shard?: string } }
}
type Workflow = {
  on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, Job>
}
const scheduled = load(readFileSync('.github/workflows/source-regression.yml', 'utf8')) as Workflow
const pr = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as Workflow
const action = load(readFileSync('.github/actions/source-regression/action.yml', 'utf8')) as {
  runs: { using: string; steps: Step[] }
}
const graph = { status: 'unavailable-manifest-only', testFiles: [] }
const changesFor = (paths: string[]): Array<{ path: string; status: string }> =>
  paths.map((path) => ({ path, status: 'modified' }))
const resolvePlan = (paths: string[]): ReturnType<typeof classifyChanges> => {
  const changes = changesFor(paths)
  const candidate = classifyChanges(changes)
  return resolveAuthoritativePlan(candidate, createAffectedTestPlan(changes, graph))
}

describe('trusted supplemental selection', () => {
  it.each([
    'src/main/connectors/descriptors/genes-ontology.ts',
    'src/main/locale/main-process-messages.ts'
  ])(
    'keeps portable and core journey coverage without unrelated supplemental groups: %s',
    (path) => {
      const plan = resolvePlan([path])
      expect(plan.mode).toBe('selective')
      expect(plan.bundles).toContain('unit')
      expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
      const mixed = resolvePlan([path, 'src/main/acp/runtime.ts'])
      expect(macosGroupsForPlan(mixed)).toEqual(
        expect.arrayContaining(['regressions', 'delegation'])
      )
    }
  )

  it.each([
    'src/main/delegation/production-composition.ts',
    'src/main/agent-framework/opencode.ts',
    'src/main/agent-framework/codex.ts',
    'src/main/acp/runtime.ts',
    'src/main/session-persistence/coordinator.ts',
    'src/main/permission-grants/registry.ts',
    'src/main/notebook/kernel-executor.ts'
  ])('retains critical lifecycle and security coverage: %s', (path) => {
    for (const plan of [classifyChanges(changesFor([path])), resolvePlan([path])]) {
      expect(macosGroupsForPlan(plan)).toEqual(
        expect.arrayContaining(['regressions', 'delegation'])
      )
    }
  })

  it('carries supplemental coverage through module consumers as well as changed paths', () => {
    const modules = createAffectedTestPlan(
      changesFor(['src/main/settings/provider-accounts.ts']),
      graph
    )
    expect(modules.mode).toBe('selective')
    expect(modules.modules).toContain('settings_backend_resolution')
    // Even a candidate with no supplemental lanes must gain its consumers' mandatory coverage.
    const candidate = classifyChanges(
      changesFor(['src/main/connectors/descriptors/genes-ontology.ts'])
    )
    expect(macosGroupsForPlan(candidate)).toEqual(['journeys'])
    const plan = resolveAuthoritativePlan(candidate, modules)
    expect(plan.mode).toBe('selective')
    expect(macosGroupsForPlan(plan)).toEqual(expect.arrayContaining(['regressions', 'delegation']))
  })

  it('omits idle presentation jobs but retains runtime and delegation coverage for mixed ontology/Notebook changes', () => {
    const changes = changesFor([
      'src/main/connectors/descriptors/genes-ontology.ts',
      'src/main/connectors/descriptors/genes-ontology.test.ts',
      'src/main/notebook/host-mcp.integration.test.ts'
    ])
    const modules = createAffectedTestPlan(changes, graph)
    const plan = resolveAuthoritativePlan(classifyChanges(changes), modules)
    expect(plan.mode).toBe('selective')
    expect(modules.modules).toEqual(['connector_ontology', 'notebook_application'])
    expect(modules.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/connectors/registry.test.ts',
        'src/main/connectors/service.test.ts',
        'src/main/connectors/skill-doc.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts'
      ])
    )
    expect(toGitHubOutputPlan(plan).macosGroups).toEqual(['journeys', 'regressions', 'delegation'])
  })

  it('runs the whole browser lane without forcing unrelated Vitest or Electron groups', () => {
    const plan = resolvePlan(['e2e/browser/settings-undo.spec.ts'])
    expect(plan.mode).toBe('selective')
    // Keep real Windows font, clipboard and browser-startup behavior in the existing bundle.
    expect(plan.bundles).toEqual(['policy', 'static', 'macos_e2e', 'windows_e2e'])
    expect(plan.lanes).toContain('e2e_browser_windows')
    expect(plan.lanes).not.toContain('e2e_functional_windows')
    expect(plan.lanes).not.toContain('e2e_workspace_windows')
    expect(toGitHubOutputPlan(plan).macosGroups).toEqual(['presentation'])
    expect(plan.lanes).toContain('e2e_visual_macos')
    const mixed = resolvePlan([
      'e2e/browser/settings-undo.spec.ts',
      'src/main/connectors/descriptors/genes-ontology.ts'
    ])
    expect(mixed.mode).toBe('selective')
    expect(mixed.lanes).toContain('e2e_visual_macos')
    expect(mixed.bundles).toContain('unit')
    const native = resolvePlan([
      'e2e/browser/settings-undo.spec.ts',
      'src/main/notebook/kernel-executor.ts'
    ])
    expect(native.lanes).toEqual(
      expect.arrayContaining(['e2e_functional_windows', 'e2e_workspace_windows'])
    )
  })

  it.skipIf(process.platform === 'win32')(
    'requires the complete Windows browser regression on every scheduled shard',
    () => {
      const regression = load(
        readFileSync('.github/workflows/windows-e2e-regression.yml', 'utf8')
      ) as Workflow
      const enforce = regression.jobs.windows_e2e.steps.find(
        ({ name }) => name === 'Enforce complete Windows E2E suites'
      )!
      expect(enforce.env?.E2E_SHARD).toBeUndefined()
      for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const result = spawnSync('bash', ['-e', '-c', enforce.run!], {
          encoding: 'utf8',
          env: {
            ...process.env,
            BROWSER: outcome,
            SETUP: 'success',
            FUNCTIONAL: 'success',
            WORKSPACE: 'success'
          }
        })
        expect(result.status, result.stderr).toBe(outcome === 'success' ? 0 : 1)
      }
    }
  )

  it.each([
    'src/main/artifacts/unregistered-export.ts',
    'src/renderer/src/pages/settings/unregistered-page.tsx',
    'e2e/fixtures/electron-app.ts',
    'e2e/new-unknown.spec.ts',
    'package.json',
    'playwright.browser.config.ts',
    '.github/actions/source-regression/action.yml',
    '.github/workflows/source-regression.yml'
  ])('keeps full fallback for unknown ownership or global input: %s', (path) => {
    const plan = resolvePlan([path])
    expect(plan.mode).toBe('full')
    expect(macosGroupsForPlan(plan)).toEqual([
      'journeys',
      'presentation',
      'regressions',
      'delegation'
    ])
  })

  it('adds delegation through state and shared consumers while views retain supplemental regressions', () => {
    for (const path of [
      'src/renderer/src/stores/session-store.ts',
      'src/main/acp/runtime.ts',
      'src/shared/acp.ts'
    ]) {
      expect(macosGroupsForPlan(classifyChanges(changesFor([path])))).toContain('delegation')
    }
    const view = classifyChanges(changesFor(['src/renderer/src/components/ui/button.tsx']))
    expect(macosGroupsForPlan(view)).toContain('regressions')
    expect(macosGroupsForPlan(classifyChanges(changesFor(['README.md'])))).toEqual([])
  })

  it('rejects omitted, extra, reordered or empty group plans even when jobs report success', () => {
    const plan = toGitHubOutputPlan(
      resolvePlan(['src/main/connectors/descriptors/genes-ontology.ts'])
    )
    const conclusions = Object.fromEntries(
      ['preflight', ...plan.bundles].map((job) => [job, 'success'])
    )
    for (const groups of [
      [],
      ['regressions'],
      ['delegation', 'journeys', 'regressions'],
      [...plan.macosGroups, 'presentation']
    ]) {
      expect(
        evaluatePrGate({ ...plan, macosGroups: groups }, conclusions, { executionMode: 'bundles' })
          .ok
      ).toBe(false)
    }
    expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(true)
    const legacy = { ...plan, macosGroups: undefined }
    expect(evaluatePrGate(legacy, conclusions, { executionMode: 'bundles' }).ok).toBe(true)
    expect(pr.jobs.macos_e2e.strategy?.matrix.group).toContain(
      `|| fromJSON('["journeys","presentation","regressions","delegation"]')`
    )
  })
})

describe('independent source regression', () => {
  it.skipIf(process.platform === 'win32')(
    'selects nightly profiling explicitly and rejects invalid selections',
    () => {
      const command = action.runs.steps.find(
        (step) => step.name === 'Run supplemental regressions'
      )!
      expect(
        pr.jobs.macos_e2e.steps.find((step) => step.with?.group === 'regressions')?.with?.[
          'include-capacity'
        ]
      ).toBe('false')
      expect(
        scheduled.jobs.regression.steps.find((step) => step.with?.group === 'regressions')?.with?.[
          'include-capacity'
        ]
      ).toBe('true')
      for (const selection of ['true', 'false', '', 'invalid']) {
        const result = spawnSync(
          'bash',
          ['-e', '-c', 'npm() { printf "%s\\n" "$@"; };\n' + command.run!],
          {
            encoding: 'utf8',
            env: { ...process.env, INCLUDE_CAPACITY: selection }
          }
        )
        expect(result.status).toBe(['true', 'false'].includes(selection) ? 0 : 1)
        if (selection === 'true') {
          expect(result.stdout).toContain('--global-timeout=2400000')
          expect(result.stdout).not.toContain('--grep-invert')
        }
        if (selection === 'false') {
          expect(result.stdout).toContain('--global-timeout=1200000')
          expect(result.stdout).toContain('--grep-invert\n@capacity')
        }
      }
    }
  )

  it('batches main on a read-only schedule with one native runner and no package prerequisite', () => {
    expect(scheduled.on.schedule).toEqual([{ cron: '37 5,17 * * *' }])
    expect(scheduled.on).toHaveProperty('workflow_dispatch')
    expect(scheduled.on.workflow_dispatch).toEqual({
      inputs: {
        mode: {
          description: 'Validation scope',
          required: true,
          type: 'choice',
          default: 'full',
          options: ['full', 'workspace-images', 'presentation-screening']
        }
      }
    })
    expect(scheduled.on).not.toHaveProperty('push')
    expect(scheduled.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(scheduled.jobs.regression.if).toContain("github.ref == 'refs/heads/main'")
    expect(scheduled.concurrency).toEqual({
      group: 'source-regression-${{ github.event_name }}-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(Object.keys(scheduled.jobs)).toEqual(['regression', 'report'])
    expect(scheduled.jobs.regression.needs).toBeUndefined()
    expect(scheduled.jobs.regression['runs-on']).toBe(pr.jobs.macos_e2e['runs-on'])
    expect(scheduled.jobs.regression['continue-on-error']).toBeUndefined()
    expect(
      scheduled.jobs.regression.steps.filter((step) => step.run === 'npm run build:e2e')
    ).toHaveLength(1)
  })

  it.each(['regressions', 'delegation'])(
    'shares actual %s execution between PR and main',
    (group) => {
      expect(action.runs.using).toBe('composite')
      const command = action.runs.steps.find((step) => step.name === `Run supplemental ${group}`)!
      if (group === 'regressions') {
        expect(command.run).toContain(
          'npm run test:e2e:regressions -- --fail-on-flaky-tests --global-timeout="$regression_timeout" --output=test-results/regressions_macos'
        )
        expect(command.run).toContain('regression_timeout=1200000')
        expect(command.run).toContain('true) regression_timeout=2400000')
      } else {
        expect(command.run).toContain(
          'npm run test:e2e:delegation -- --fail-on-flaky-tests --global-timeout=1200000 --output=test-results/delegation_macos'
        )
      }
      for (const job of [pr.jobs.macos_e2e, scheduled.jobs.regression]) {
        expect(job.steps.find((step) => step.with?.group === group)?.uses).toBe(
          './.github/actions/source-regression'
        )
      }
    }
  )

  it('runs both scheduled rounds even when main has not changed', () => {
    expect(scheduled.jobs).not.toHaveProperty('plan')
    expect(scheduled.jobs.regression.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main'"
    )
    expect(scheduled.jobs.regression.steps.some(({ run }) => run?.includes('previous'))).toBe(false)
  })

  it('keeps the workspace image dry-run focused and blocking', () => {
    const steps = scheduled.jobs.regression.steps
    const focused = steps.find(({ name }) => name === 'Test workspace message images')!
    const gate = steps.find(({ name }) => name === 'Enforce workspace image dry-run')!
    expect(focused.if).toContain("inputs.mode == 'workspace-images'")
    expect(focused.run).toContain('e2e/workspace-files.spec.ts')
    expect(focused.run).toContain('--fail-on-flaky-tests')
    expect(gate.if).toContain("inputs.mode == 'workspace-images'")
    expect(gate.env?.WORKSPACE_IMAGES).toBe('${{ steps.workspace_images.outcome }}')
    expect(gate.run).toContain('"$WORKSPACE_IMAGES" == "success"')
    for (const name of [
      'Build web application',
      'Install headless Chromium',
      'Run complete Mac functional journeys',
      'Run complete Mac workspace journeys',
      'Run complete Mac browser and visual coverage',
      'Run complete Mac accessibility checks',
      'Run supplemental regressions',
      'Run supplemental delegation',
      'Enforce complete Mac core and presentation suites',
      'Enforce both supplemental suites'
    ]) {
      expect(steps.find((step) => step.name === name)?.if).toContain("inputs.mode == 'full'")
    }
  })

  it('keeps the screening flight dry-run focused and blocking', () => {
    const steps = scheduled.jobs.regression.steps
    const focused = steps.find(({ name }) => name === 'Test concurrent screening flights')!
    const gate = steps.find(({ name }) => name === 'Enforce screening flight dry-run')!
    expect(focused.if).toContain("inputs.mode == 'presentation-screening'")
    expect(focused.run).toContain('e2e/browser/smart-screening.spec.ts')
    expect(focused.run).toContain('--repeat-each=5')
    expect(focused.run).toContain('--fail-on-flaky-tests')
    expect(gate.if).toContain("inputs.mode == 'presentation-screening'")
    expect(gate.env?.PRESENTATION_SCREENING).toBe('${{ steps.presentation_screening.outcome }}')
    expect(gate.run).toContain('"$PRESENTATION_SCREENING" == "success"')
    expect(steps.find(({ name }) => name === 'Build Electron application')?.if).toContain(
      "inputs.mode != 'presentation-screening'"
    )
    expect(steps.find(({ name }) => name === 'Install headless Chromium')?.if).toContain(
      "inputs.mode == 'presentation-screening'"
    )
  })

  it.skipIf(process.platform === 'win32')(
    'cannot pass when either scheduled suite fails, cancels or never executes',
    () => {
      const enforce = scheduled.jobs.regression.steps.find(
        ({ name }) => name === 'Enforce both supplemental suites'
      )!
      expect(enforce.if).toBe(
        "${{ always() && (github.event_name != 'workflow_dispatch' || inputs.mode == 'full') }}"
      )
      for (const regressions of ['success', 'failure', 'cancelled', 'skipped', '']) {
        for (const delegation of ['success', 'failure', 'cancelled', 'skipped', '']) {
          const result = spawnSync('bash', ['-e', '-c', enforce.run!], {
            env: { ...process.env, REGRESSIONS: regressions, DELEGATION: delegation }
          })
          expect(result.status).toBe(regressions === 'success' && delegation === 'success' ? 0 : 1)
        }
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'validates action inputs without executing injected shell text',
    () => {
      const validate = action.runs.steps.find(({ name }) => name === 'Validate suite')!
      for (const group of [
        'regressions',
        'delegation',
        'unknown',
        '$(exit 0)',
        'regressions; exit 0'
      ]) {
        const result = spawnSync('bash', ['-e', '-c', validate.run!], {
          env: { ...process.env, GROUP: group }
        })
        expect(result.status).toBe(['regressions', 'delegation'].includes(group) ? 0 : 1)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the real PR jobs for the focused supplemental dry-run',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'supplemental-dryrun-'))
      try {
        const output = join(dir, 'output')
        const step = pr.jobs.preflight.steps.find(({ id }) => id === 'classify')!
        const result = spawnSync('bash', ['-eu', '-c', step.run!], {
          encoding: 'utf8',
          env: {
            ...process.env,
            EVENT_NAME: 'workflow_dispatch',
            DRY_RUN_MODE: 'source-regressions',
            GITHUB_OUTPUT: output
          }
        })
        expect(result.status, result.stderr).toBe(0)
        const line = readFileSync(output, 'utf8')
          .split('\n')
          .find((value) => value.startsWith('plan='))!
        const plan = JSON.parse(line.slice(5))
        expect(plan.macosGroups).toEqual(['regressions', 'delegation'])
        expect(plan.bundles).toEqual(['policy', 'macos_e2e'])
        expect(
          evaluatePrGate(
            plan,
            { preflight: 'success', policy: 'success', macos_e2e: 'success' },
            { executionMode: 'bundles' }
          ).ok
        ).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
