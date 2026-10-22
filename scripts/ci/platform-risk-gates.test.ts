import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  classifyChanges,
  macosGroupsForPlan,
  platformExecutionPlan,
  toGitHubOutputPlan
} from './classify-pr-changes.mjs'
import { runModuleImpactAuthorityCli } from './module-impact-authority.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'
import {
  createModuleImpactModel,
  resolveModuleImpactModel,
  productionFullReasonContracts
} from './module-impact-model.test-support'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { windowsCoreChecks } from './windows-core-plan.mjs'

const full = classifyChanges([{ path: 'package.json', status: 'modified' }])
const changes = (path: string): Array<{ path: string; status: string }> => [
  { path, status: 'modified' }
]

// Sources and evidence are deliberately bounded examples, independent of production research edges.
const boundedPlatformModel = (): ReturnType<typeof createModuleImpactModel> =>
  createModuleImpactModel({
    renderer_ui: {
      ownerPaths: ['src/renderer/src/components/ui/button.tsx'],
      ownerTests: ['src/renderer/src/components/ui/control-primitives.render.test.tsx'],
      fallbackCapability: 'renderer_view'
    },
    i18n_main_adapter: {
      ownerPaths: ['src/main/locale/main-process-messages.ts'],
      ownerTests: ['src/main/locale/owner.test.ts'],
      fallbackCapability: 'main_runtime'
    },
    connector_builtins: {
      ownerPaths: [
        'packages/connector-builtins/src/genes-ontology.ts',
        'packages/connector-builtins/src/genomes-ensembl.ts'
      ],
      ownerTests: ['packages/connector-builtins/src/genomes-ensembl.test.ts'],
      consumerModules: ['notebook_host'],
      fallbackCapability: 'main_runtime'
    },
    notebook_host: {
      ownerPaths: ['src/main/notebook/host-mcp.integration.test.ts'],
      interfacePaths: ['src/main/notebook/host-mcp.integration.test.ts'],
      ownerTests: ['src/main/notebook/host-mcp.integration.test.ts']
    },
    acp_runtime: {
      ownerPaths: ['src/main/acp/runtime-coordinator.ts', 'src/main/acp/runtime.ts'],
      ownerTests: ['src/main/acp/runtime-coordinator.test.ts', 'src/main/acp/runtime.test.ts'],
      consumerModules: ['reviewer_orchestrator'],
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation']
    },
    reviewer_orchestrator: {
      ownerPaths: [
        'src/main/reviewer/correction-context.ts',
        'src/main/reviewer/correction.ts',
        'src/main/reviewer/fix-loop.test.ts',
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.ts',
        'src/main/reviewer/scope.ts'
      ],
      ownerTests: [
        'src/main/reviewer/correction-context.test.ts',
        'src/main/reviewer/correction.test.ts',
        'src/main/reviewer/fix-loop.test.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.test.ts'
      ]
    }
  })

describe('platform risk execution policy', () => {
  it.each([
    ['shared owner', 'M', 'src/shared/settings.ts'],
    ['unknown owner', 'A', 'src/shared/new-unregistered-contract.ts'],
    ['destructive change', 'D', 'src/shared/app-config.ts'],
    ['global input', 'M', 'package.json'],
    ['CI policy', 'M', '.github/workflows/pr-gate.yml']
  ])(
    'defers %s full portable validation to acceptance without weakening other checks',
    (_, status, path) => {
      const classify = (event: string): ReturnType<typeof runModuleImpactAuthorityCli> =>
        runModuleImpactAuthorityCli(
          ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
          { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
          { execute: () => Buffer.from(`${status}\0${path}\0`), write: () => undefined }
        )
      const { plan: pr, report } = classify('pull_request')
      const { plan: queue } = classify('merge_group')
      expect(report.resolved.mode).toBe('full')
      expect(pr.mode).toBe('full')
      expect(pr.bundles).not.toContain('unit')
      expect(pr.lanes).not.toContain('unit_macos')
      expect(pr.roots).toEqual(report.resolved.roots)
      expect(pr.reasonChains).toEqual(expect.arrayContaining(report.resolved.reasonChains))
      expect(pr.reasonChains).toContain(
        'pull_request: full portable tests and coverage deferred to scheduled/manual acceptance'
      )
      expect(pr.bundles).toEqual(
        expect.arrayContaining(['policy', 'static', 'linux_runtime', 'windows_core', 'windows_e2e'])
      )
      expect(pr.lanes).toEqual(
        expect.arrayContaining(['interface_contracts', 'cli_sdk', 'i18n', 'lint', 'typecheck_node'])
      )
      expect(queue.mode).toBe('full')
      expect(queue.bundles).not.toContain('unit')
      expect(queue.lanes).not.toContain('unit_macos')
      for (const plan of [pr, queue]) {
        const conclusions = Object.fromEntries(
          ['preflight', ...plan.bundles].map((name) => [name, 'success'])
        )
        expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(true)
        for (const unit of ['skipped', 'failure', 'cancelled', undefined]) {
          expect(
            evaluatePrGate(plan, { ...conclusions, unit }, { executionMode: 'bundles' }).ok
          ).toBe(unit === 'skipped')
        }
      }
    }
  )

  it.each(['pull_request', 'merge_group'])(
    'keeps bounded module tests and their blocking gate on %s',
    (event) => {
      const { plan } = resolveModuleImpactModel(
        changes('src/renderer/src/components/ui/button.tsx'),
        boundedPlatformModel(),
        event
      )
      expect(plan.mode).toBe('selective')
      expect(plan.bundles).toContain('unit')
      expect(plan.lanes).toContain('unit_macos')
      const conclusions = Object.fromEntries(
        ['preflight', ...plan.bundles].map((name) => [name, 'success'])
      )
      expect(
        evaluatePrGate(plan, { ...conclusions, unit: 'skipped' }, { executionMode: 'bundles' }).ok
      ).toBe(false)
    }
  )

  it('uses Windows business journeys without Mac on ordinary PRs', () => {
    const plan = platformExecutionPlan(
      full,
      changes('src/renderer/src/pages/home.tsx'),
      'pull_request'
    )
    expect(plan.macosProfile).toBe('smoke')
    expect(macosGroupsForPlan(plan)).toEqual([])
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_functional_windows',
        'e2e_workspace_windows',
        'e2e_browser_windows'
      ])
    )
    expect(plan.bundles).toContain('windows_e2e')
    expect(plan.lanes).not.toContain('e2e_regressions_macos')
    expect(plan.lanes).not.toContain('e2e_workspace_macos')
    expect(toGitHubOutputPlan(plan).macosProfile).toBe('smoke')
  })
  it('does not add Windows E2E lanes to PRs without desktop impact', () => {
    const docs = classifyChanges(changes('README.md'))
    const plan = platformExecutionPlan(docs, changes('README.md'), 'pull_request')
    expect(plan.bundles).not.toContain('windows_e2e')
    expect(plan.lanes.some((lane) => lane.endsWith('_windows'))).toBe(false)
  })
  it('keeps Linux and short Mac but removes ordinary Windows E2E from queue', () => {
    const plan = platformExecutionPlan(
      full,
      changes('src/renderer/src/pages/home.tsx'),
      'merge_group'
    )
    expect(plan.bundles).toContain('linux_runtime')
    expect(plan.bundles).toContain('macos_e2e')
    expect(plan.bundles).not.toContain('windows_e2e')
    const conclusions = Object.fromEntries(
      ['preflight', ...plan.bundles].map((name) => [name, 'success'])
    )
    expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(true)
    expect(
      evaluatePrGate(plan, { ...conclusions, macos_e2e: 'skipped' }, { executionMode: 'bundles' })
        .ok
    ).toBe(false)
  })
  it.each([
    'src/main/windows.ts',
    'src/main/shortcuts.ts',
    'src/main/notebook/kernel-executor.ts',
    'src/preload/index.ts',
    'src/shared/notebook-runtime.ts',
    'src/shared/window.ts',
    'packages/notebook-network-sandbox/src/index.ts',
    'packages/process-tree-native/src/process_tree_native.cc',
    'packages/safe-file-publisher-native/src/safe_file_publisher_native.cc',
    'src/main/second-instance-router.ts',
    'package-lock.json',
    'electron.vite.config.ts',
    'tsconfig.node.json'
  ])('expands native coverage for %s', (path) => {
    const plan = platformExecutionPlan(full, changes(path), 'merge_group')
    expect(plan.macosProfile).toBe('expanded')
    expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
    expect(plan.bundles).not.toContain('windows_e2e')
  })
  it('keeps unknown and destructive changes conservative', () => {
    expect(
      platformExecutionPlan(
        { ...full, roots: ['unknown:unowned'] },
        changes('new.ts'),
        'pull_request'
      ).macosProfile
    ).toBe('expanded')
    expect(
      platformExecutionPlan(
        full,
        [{ path: 'ui.ts', previousPath: 'src/main/windows.ts', status: 'renamed' }],
        'pull_request'
      ).macosProfile
    ).toBe('expanded')
  })
  it('preserves explicit manual/nightly suites and leaves docs without desktop jobs', () => {
    expect(platformExecutionPlan(full, changes('ui.ts'), 'workflow_dispatch')).toBe(full)
    expect(platformExecutionPlan(full, changes('ui.ts'), 'schedule')).toBe(full)
    expect(macosGroupsForPlan(full)).toHaveLength(4)
    const docs = classifyChanges(changes('README.md'))
    expect(platformExecutionPlan(docs, changes('README.md'), 'pull_request').bundles).not.toContain(
      'macos_e2e'
    )
  })
  it('rejects unknown profiles and smoke plans that omit the smoke lane', () => {
    const plan = platformExecutionPlan(
      full,
      changes('src/renderer/src/pages/home.tsx'),
      'merge_group'
    )
    const conclusions = Object.fromEntries(
      ['preflight', ...plan.bundles].map((name) => [name, 'success'])
    )
    expect(
      evaluatePrGate({ ...plan, macosProfile: 'skip' }, conclusions, { executionMode: 'bundles' })
        .ok
    ).toBe(false)
    expect(
      evaluatePrGate(
        { ...plan, lanes: plan.lanes.filter((lane) => lane !== 'e2e_smoke_macos') },
        conclusions,
        { executionMode: 'bundles' }
      ).ok
    ).toBe(false)
  })
})

type Workflow = {
  jobs: Record<
    string,
    { steps: Array<{ name: string; run?: string; env?: Record<string, string> }> }
  >
}
const workflow = (path: string): Workflow => load(readFileSync(path, 'utf8')) as Workflow

it('fails a selected short Mac group when either core or platform checks did not pass', () => {
  const step = workflow('.github/workflows/pr-gate.yml').jobs.macos_e2e.steps.find(
    ({ name }) => name === 'Enforce selected macOS checks'
  )!
  for (const [core, platform, code] of [
    ['success', 'success', 0],
    ['skipped', 'success', 1],
    ['success', 'skipped', 1],
    ['failure', 'success', 1]
  ] as const) {
    const result = spawnSync('bash', ['-c', step.run!], {
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(step.env ?? {}).map((key) => [key, 'skipped'])),
        E2E_GROUP: 'journeys',
        E2E_SMOKE_SELECTED: 'true',
        E2E_SMOKE_OUTCOME: core,
        UNIT_MACOS_SMOKE_OUTCOME: platform
      },
      encoding: 'utf8'
    })
    expect(result.status).toBe(code)
  }
})

it('retains all deferred Mac suites in the nightly job and fails on missing execution', () => {
  const steps = workflow('.github/workflows/source-regression.yml').jobs.regression.steps
  for (const command of [
    'test:e2e:journey',
    'test:e2e:workspace',
    'e2e/playwright.browser.config.ts',
    'test:e2e:visual',
    'test:e2e:accessibility:signal'
  ]) {
    expect(steps.some(({ run }) => run?.includes(command))).toBe(true)
  }
  const enforce = steps.find(({ name }) => name === 'Enforce selected Mac suite')!
  for (const [group, key] of [
    ['functional', 'FUNCTIONAL'],
    ['workspace', 'WORKSPACE'],
    ['presentation', 'PRESENTATION'],
    ['presentation', 'ACCESSIBILITY']
  ]) {
    const env = {
      ...process.env,
      GROUP: group,
      FUNCTIONAL: 'success',
      WORKSPACE: 'success',
      PRESENTATION: 'success',
      ACCESSIBILITY: 'success'
    }
    expect(spawnSync('bash', ['-c', enforce.run!], { env }).status).toBe(0)
    expect(
      spawnSync('bash', ['-c', enforce.run!], { env: { ...env, [key]: 'skipped' } }).status
    ).toBe(1)
  }
})

it.each(['pull_request', 'merge_group'])(
  'runs a workflow-contract-only change without desktop jobs for %s',
  (event) => {
    const { plan, report } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      {
        execute: () => Buffer.from('M\0scripts/ci/pr-gate-workflow.test.ts\0'),
        write: () => undefined
      }
    )
    expect(plan.mode).toBe('selective')
    expect(plan.bundles).toEqual(['policy', 'static', 'unit'])
    expect(macosGroupsForPlan(plan)).toEqual([])
    expect(report.shadow.testFiles).toEqual(['scripts/ci/pr-gate-workflow.test.ts'])
  }
)

it.each(['pull_request', 'merge_group'])(
  'does not let a workflow contract expand an ordinary UI change on %s',
  (event) => {
    const { plan, report } = resolveModuleImpactModel(
      [
        ...changes('src/renderer/src/components/ui/button.tsx'),
        ...changes('scripts/ci/pr-gate-workflow.test.ts')
      ],
      boundedPlatformModel(),
      event
    )
    expect(plan.mode).toBe('selective')
    expect(plan.macosProfile).toBe('smoke')
    expect(macosGroupsForPlan(plan)).toEqual(event === 'merge_group' ? ['journeys'] : [])
    expect(report.shadow.testFiles).toContain('scripts/ci/pr-gate-workflow.test.ts')
    if (event === 'merge_group') expect(plan.bundles).not.toContain('windows_e2e')
  }
)

it('applies the platform policy only when explicitly enabled', () => {
  for (const policy of [undefined, 'risk-v1']) {
    const { plan } = resolveModuleImpactModel(
      changes('src/renderer/src/components/ui/button.tsx'),
      boundedPlatformModel(),
      'pull_request',
      policy ?? null
    )
    expect(plan.macosProfile).toBe(policy ? 'smoke' : undefined)
    expect(macosGroupsForPlan(plan)).toHaveLength(policy ? 0 : 3)
  }
})

it('applies the policy opt-in at the real CLI entry point without changing full impact', () => {
  for (const policy of [undefined, 'risk-v1']) {
    const { plan } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: 'pull_request', PR_GATE_PLATFORM_POLICY: policy },
      {
        execute: () => Buffer.from('M\0src/renderer/src/components/ui/button.tsx\0'),
        write: () => undefined
      }
    )
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains.join('\n')).toContain(productionFullReasonContracts.renderer_ui)
    expect(plan.macosProfile).toBe(policy ? 'smoke' : undefined)
    expect(macosGroupsForPlan(plan)).toHaveLength(policy ? 0 : 4)
    expect(plan.bundles.includes('unit')).toBe(policy === undefined)
    expect(
      plan.reasonChains.includes(
        'pull_request: full portable tests and coverage deferred to scheduled/manual acceptance'
      )
    ).toBe(policy === 'risk-v1')
  }
})

it.each([
  'src/main/locale/main-process-messages.ts',
  'packages/connector-builtins/src/genes-ontology.ts'
])('uses Windows business coverage without Mac for known non-native main changes: %s', (path) => {
  const { plan } = resolveModuleImpactModel(changes(path), boundedPlatformModel())
  expect(plan.macosProfile).toBe('smoke')
  expect(plan.bundles).toContain('windows_e2e')
  expect(macosGroupsForPlan(plan)).toEqual([])
})

it.each(['pull_request', 'merge_group'])(
  'keeps second-instance launch routing on expanded Mac coverage for %s',
  (event) => {
    const changed = changes('src/main/second-instance-router.ts')
    const candidate = classifyChanges(changed)
    expect(candidate.mode).toBe('selective')
    expect(platformExecutionPlan(candidate, changed, event).macosProfile).toBe('expanded')
    const { plan } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      {
        execute: () => Buffer.from('M\0src/main/second-instance-router.ts\0'),
        write: () => undefined
      }
    )
    expect(plan.macosProfile).toBe('expanded')
    expect(macosGroupsForPlan(plan)).toEqual(event === 'merge_group' ? ['journeys'] : [])
    expect(plan.lanes).not.toContain('e2e_regressions_macos')
    if (event === 'merge_group') expect(plan.lanes).toContain('e2e_smoke_macos')
  }
)

it.each([
  'src/main/new-native-helper.ts',
  'src/main/permission-grants/registry.ts',
  'src/main/storage/data-path.ts',
  'src/main/acp/runtime.ts',
  'src/main/menu.ts',
  'src/main/process-tree.ts',
  'src/main/net/network-info.ts'
])('keeps unowned main code and native/security boundaries expanded: %s', (path) => {
  const { plan } = runModuleImpactAuthorityCli(
    ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
    { EVENT_NAME: 'merge_group', PR_GATE_PLATFORM_POLICY: 'risk-v1' },
    { execute: () => Buffer.from(`M\0${path}\0`), write: () => undefined }
  )
  expect(plan.macosProfile).toBe('expanded')
})

// Real diffs that previously fell back to all three portable shards.
it.each(['pull_request', 'merge_group'])('keeps known PR diffs selective for %s', (event) => {
  for (const fixture of [
    {
      number: 2696,
      paths: [
        'packages/connector-builtins/src/genomes-ensembl.test.ts',
        'packages/connector-builtins/src/genomes-ensembl.ts',
        'src/main/notebook/host-mcp.integration.test.ts'
      ]
    },
    {
      number: 2682,
      paths: [
        'src/main/acp/runtime-coordinator.test.ts',
        'src/main/acp/runtime-coordinator.ts',
        'src/main/acp/runtime.test.ts',
        'src/main/acp/runtime.ts',
        'src/main/reviewer/correction-context.test.ts',
        'src/main/reviewer/correction-context.ts',
        'src/main/reviewer/correction.test.ts',
        'src/main/reviewer/correction.ts',
        'src/main/reviewer/fix-loop.test.ts',
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.ts',
        'src/main/reviewer/scope.ts'
      ]
    }
  ]) {
    const { plan, report } = resolveModuleImpactModel(
      fixture.paths.map((path) => ({ path, status: 'modified' })),
      boundedPlatformModel(),
      event
    )
    expect(plan.mode, `PR ${fixture.number}: ${plan.reasonChains.join('\n')}`).toBe('selective')
    expect(plan.macosProfile).toBe('expanded')
    expect(plan.bundles).toContain('unit')
    expect(report.shadow.testFiles).toEqual(
      expect.arrayContaining(fixture.paths.filter((path) => path.endsWith('.test.ts')))
    )
    expect(report.shadow.modules).toContain(
      fixture.number === 2696 ? 'connector_builtins' : 'acp_runtime'
    )
  }
})

describe('queue-only Mac policy', () => {
  const inputs = [
    'src/renderer/src/components/ui/button.tsx',
    'src/main/acp/runtime.ts',
    'src/main/second-instance-router.ts',
    'src/main/notebook/kernel-executor.ts',
    'package.json',
    'unknown/new-runtime.ts'
  ]
  const resolve = (
    path: string,
    event: string
  ): ReturnType<typeof runModuleImpactAuthorityCli>['plan'] =>
    runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      { execute: () => Buffer.from(`M\0${path}\0`), write: () => undefined }
    ).plan
  it.each(inputs)('keeps PR %s on portable and Windows checks with no Mac bundle', (path) => {
    const plan = resolve(path, 'pull_request')
    expect(plan.bundles).not.toContain('macos_e2e')
    expect(macosGroupsForPlan(plan)).toEqual([])
    expect(plan.bundles).toContain('windows_e2e')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_functional_windows',
        'e2e_workspace_windows',
        'e2e_browser_windows'
      ])
    )
    expect(
      plan.lanes.filter((lane: string) => lane.startsWith('e2e_') && lane.endsWith('_macos'))
    ).toEqual([])
    const conclusions = Object.fromEntries(
      ['preflight', ...plan.bundles].map((key) => [key, 'success'])
    )
    expect(
      evaluatePrGate(
        toGitHubOutputPlan(plan),
        { ...conclusions, macos_e2e: 'skipped' },
        { executionMode: 'bundles' }
      ).ok
    ).toBe(true)
  })
  it.each(inputs)('limits queue %s to one Mac group without repeated Windows E2E', (path) => {
    const plan = resolve(path, 'merge_group')
    expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
    expect(plan.lanes).toContain('e2e_smoke_macos')
    expect(plan.bundles).not.toContain('windows_e2e')
    expect(plan.lanes).not.toContain('e2e_delegation_macos')
    expect(plan.lanes).not.toContain('e2e_regressions_macos')
    expect(plan.macosProfile).toBe(path.includes('/ui/') ? 'smoke' : 'expanded')
    const conclusions = Object.fromEntries(
      ['preflight', ...plan.bundles].map((key) => [key, 'success'])
    )
    expect(
      evaluatePrGate(toGitHubOutputPlan(plan), conclusions, { executionMode: 'bundles' }).ok
    ).toBe(true)
    expect(
      evaluatePrGate(
        toGitHubOutputPlan(plan),
        { ...conclusions, macos_e2e: 'skipped' },
        { executionMode: 'bundles' }
      ).ok
    ).toBe(false)
  })
  it.each(['pull_request', 'merge_group'])(
    'keeps docs and contract-only %s without Mac',
    (event) => {
      for (const path of ['README.md', 'scripts/ci/pr-gate-workflow.test.ts']) {
        expect(resolve(path, event).bundles).not.toContain('macos_e2e')
      }
    }
  )
  it.each(['pull_request', 'merge_group'])(
    'passes the actual gate CLI for %s platform plans',
    (event) => {
      const plan = toGitHubOutputPlan(resolve('src/main/acp/runtime.ts', event))
      const needs = Object.fromEntries(
        ['preflight', ...plan.bundles].map((key) => [key, { result: 'success' }])
      )
      const run = spawnSync(process.execPath, ['scripts/ci/evaluate-pr-gate.mjs'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PR_GATE_PLATFORM_POLICY: 'risk-v1',
          PR_GATE_EXECUTION_MODE: 'bundles',
          PR_GATE_PLAN: JSON.stringify(plan),
          PR_GATE_NEEDS: JSON.stringify(needs)
        }
      })
      expect(run.status, run.stderr).toBe(0)
    }
  )

  it('requires risk-selected native checks in the same core job', () => {
    const step = workflow('.github/workflows/pr-gate.yml').jobs.macos_e2e.steps.find(
      ({ name }) => name === 'Enforce selected macOS checks'
    )!
    for (const outcome of ['success', 'skipped', 'failure', 'cancelled', '']) {
      const result = spawnSync('bash', ['-c', step.run!], {
        env: {
          ...process.env,
          ...Object.fromEntries(Object.keys(step.env ?? {}).map((key) => [key, 'skipped'])),
          E2E_GROUP: 'journeys',
          E2E_SMOKE_SELECTED: 'true',
          E2E_SMOKE_OUTCOME: 'success',
          UNIT_MACOS_SMOKE_OUTCOME: 'success',
          MACOS_PROFILE: 'expanded',
          UNIT_MACOS_NATIVE_OUTCOME: outcome
        }
      })
      expect(result.status).toBe(outcome === 'success' ? 0 : 1)
    }
  })
})

it.each(['pull_request', 'merge_group'])(
  'keeps real reclassified owners on explained full platform gates for %s',
  (event) => {
    const manifest = loadModuleImpactManifest()
    for (const [id, path, profile] of [
      ['renderer_ui', 'src/renderer/src/components/ui/button.tsx', 'smoke'],
      ['i18n_main_adapter', 'src/main/locale/main-process-messages.ts', 'expanded'],
      ['connector_builtins', 'packages/connector-builtins/src/genes-ontology.ts', 'smoke']
    ] as const) {
      const { plan, report } = runModuleImpactAuthorityCli(
        ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
        { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
        { execute: () => Buffer.from(`M\0${path}\0`), write: () => undefined }
      )
      const explanation = productionFullReasonContracts[id]
      expect(manifest.modules[id].fullTestReason, id).toBe(explanation)
      const reason = `${id} -> ${explanation} -> full`
      expect(report.resolved.mode, id).toBe('full')
      expect(plan.mode, id).toBe('full')
      expect(plan.reasonChains.join('\n'), id).toContain(reason)
      expect(plan.bundles, id).toEqual(expect.arrayContaining(['linux_runtime', 'windows_core']))
      expect(plan.windowsCoreChecks, id).toEqual(
        expect.arrayContaining(Object.keys(windowsCoreChecks))
      )
      expect(plan.macosProfile, id).toBe(profile)
      expect(macosGroupsForPlan(plan), id).toEqual(event === 'merge_group' ? ['journeys'] : [])
      expect(plan.bundles.includes('windows_e2e'), id).toBe(event === 'pull_request')
      const conclusions = Object.fromEntries(
        ['preflight', ...plan.bundles].map((name) => [name, 'success'])
      )
      for (const gate of ['linux_runtime', 'windows_core'])
        expect(
          evaluatePrGate(plan, { ...conclusions, [gate]: 'skipped' }, { executionMode: 'bundles' })
            .ok,
          `${id}: ${gate} remains blocking`
        ).toBe(false)
    }
  }
)
