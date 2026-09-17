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

const full = classifyChanges([{ path: 'package.json', status: 'modified' }])
const changes = (path: string): Array<{ path: string; status: string }> => [
  { path, status: 'modified' }
]

describe('platform risk execution policy', () => {
  it('uses a short Mac group and full Windows business journeys on ordinary PRs', () => {
    const plan = platformExecutionPlan(
      full,
      changes('src/renderer/src/pages/home.tsx'),
      'pull_request'
    )
    expect(plan.macosProfile).toBe('smoke')
    expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
    expect(plan.lanes).toEqual(
      expect.arrayContaining(['e2e_smoke_macos', 'e2e_functional_windows', 'e2e_workspace_windows'])
    )
    expect(plan.lanes).not.toContain('e2e_regressions_macos')
    expect(plan.lanes).not.toContain('e2e_workspace_macos')
    expect(toGitHubOutputPlan(plan).macosProfile).toBe('smoke')
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
    expect(macosGroupsForPlan(plan)).toEqual([
      'journeys',
      'presentation',
      'regressions',
      'delegation'
    ])
    expect(plan.bundles).toContain('windows_e2e')
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
  it('preserves manual/nightly and old plans and leaves docs without desktop jobs', () => {
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
      'pull_request'
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
    'playwright.browser.config.ts',
    'test:e2e:visual',
    'test:e2e:accessibility:signal'
  ]) {
    expect(steps.some(({ run }) => run?.includes(command))).toBe(true)
  }
  const enforce = steps.find(
    ({ name }) => name === 'Enforce complete Mac core and presentation suites'
  )!
  const env = {
    ...process.env,
    FUNCTIONAL: 'success',
    WORKSPACE: 'success',
    PRESENTATION: 'success',
    ACCESSIBILITY: 'success'
  }
  expect(spawnSync('bash', ['-c', enforce.run!], { env }).status).toBe(0)
  for (const key of ['FUNCTIONAL', 'WORKSPACE', 'PRESENTATION', 'ACCESSIBILITY']) {
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
    const { plan, report } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      {
        execute: () =>
          Buffer.from(
            'M\0src/renderer/src/components/ui/button.tsx\0M\0scripts/ci/pr-gate-workflow.test.ts\0'
          ),
        write: () => undefined
      }
    )
    expect(plan.mode).toBe('selective')
    expect(plan.macosProfile).toBe('smoke')
    expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
    expect(report.shadow.testFiles).toContain('scripts/ci/pr-gate-workflow.test.ts')
    if (event === 'merge_group') expect(plan.bundles).not.toContain('windows_e2e')
  }
)

it('does not give old PR workflows a smoke lane they cannot execute', () => {
  const changes = Buffer.from('M\0src/renderer/src/components/ui/button.tsx\0')
  for (const policy of [undefined, 'risk-v1']) {
    const { plan } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: 'pull_request', PR_GATE_PLATFORM_POLICY: policy },
      { execute: () => changes, write: () => undefined }
    )
    expect(plan.macosProfile).toBe(policy ? 'smoke' : undefined)
    expect(macosGroupsForPlan(plan)).toHaveLength(policy ? 1 : 3)
  }
})

it.each([
  'src/main/locale/main-process-messages.ts',
  'src/main/connectors/descriptors/genes-ontology.ts'
])(
  'keeps known non-native main changes on short Mac while retaining Windows business coverage: %s',
  (path) => {
    const { plan } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: 'pull_request', PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      { execute: () => Buffer.from(`M\0${path}\0`), write: () => undefined }
    )
    expect(plan.macosProfile).toBe('smoke')
    expect(plan.bundles).toContain('windows_e2e')
    expect(macosGroupsForPlan(plan)).toEqual(['journeys'])
  }
)

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
    expect(plan.bundles).toContain('macos_e2e')
    expect(plan.lanes).toContain('e2e_regressions_macos')
    expect(macosGroupsForPlan(plan)).toContain('regressions')
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
        'src/main/connectors/descriptors/genomes-ensembl.test.ts',
        'src/main/connectors/descriptors/genomes-ensembl.ts',
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
    const { plan, report } = runModuleImpactAuthorityCli(
      ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
      { EVENT_NAME: event, PR_GATE_PLATFORM_POLICY: 'risk-v1' },
      {
        execute: () => Buffer.from(fixture.paths.map((path) => `M\0${path}\0`).join('')),
        write: () => undefined
      }
    )
    expect(plan.mode, `PR ${fixture.number}: ${plan.reasonChains.join('\n')}`).toBe('selective')
    expect(plan.macosProfile).toBe('expanded')
    expect(plan.bundles).toContain('unit')
    expect(report.shadow.testFiles).toEqual(
      expect.arrayContaining(fixture.paths.filter((path) => path.endsWith('.test.ts')))
    )
    expect(report.shadow.modules).toContain(
      fixture.number === 2696 ? 'genomes_ensembl_connector' : 'acp_runtime'
    )
  }
})
