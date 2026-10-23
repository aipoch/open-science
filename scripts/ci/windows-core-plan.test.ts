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
  createModuleImpactModel,
  productionFullReasonContracts
} from './module-impact-model.test-support'
import {
  selectWindowsCoreChecks,
  windowsCoreChecks,
  validWindowsCoreChecks
} from './windows-core-plan.mjs'

// This model isolates direct Windows evidence from indirect consumers. The production
// manifest remains separately exercised below, including its conservative full owners.
const windowsCoreModel = (): ReturnType<typeof createModuleImpactModel> =>
  createModuleImpactModel({
    main_literature: {
      ownerPaths: ['src/main/literature/catalog.ts'],
      ownerTests: ['src/main/literature/smart-collections.test.ts'],
      consumerTests: ['src/main/process-tree.windows.integration.test.ts'],
      capabilityOverlays: ['windows_sensitive']
    },
    page_literature: {
      ownerPaths: ['src/renderer/src/pages/literature/LiteratureLibraryPage.tsx'],
      ownerTests: ['src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx'],
      fallbackCapability: 'renderer_view'
    },
    shell_runtime: {
      ownerPaths: [
        'src/main/notebook/shell-runtime.ts',
        'src/main/notebook/windows-shell.integration.test.ts'
      ],
      ownerTests: ['src/main/notebook/windows-shell.integration.test.ts'],
      capabilityOverlays: ['windows_sensitive', 'notebook_network_sandbox']
    },
    acp_runtime: {
      ownerPaths: ['src/main/acp/runtime.ts'],
      ownerTests: ['src/main/acp/runtime.test.ts'],
      capabilityOverlays: ['windows_sensitive']
    },
    delegation_execution: {
      ownerPaths: ['src/main/delegation/process-ownership.ts'],
      ownerTests: ['src/main/delegation/process-ownership.test.ts'],
      capabilityOverlays: ['windows_sensitive']
    },
    environment_engine: {
      ownerPaths: ['packages/environment/src/pip-wheel-evidence.ts'],
      ownerTests: ['packages/environment/src/pip-wheel-evidence.test.ts'],
      capabilityOverlays: ['windows_sensitive']
    },
    notebook_network_sandbox: {
      ownerPaths: ['packages/notebook-network-sandbox/vendor/windows-src/src/main.rs'],
      ownerTests: [
        'packages/notebook-network-sandbox/src/windows-notebook-runtime.integration.test.ts'
      ],
      fallbackCapability: 'notebook_network_sandbox'
    }
  })
const select = (
  paths: string[],
  event = 'pull_request',
  status = 'modified'
): ReturnType<typeof selectWindowsCoreChecks> => {
  const manifest = windowsCoreModel()
  const changes = paths.map((path) => ({ path, status }))
  const modulePlan = createAffectedTestPlan(
    changes,
    { status: 'unavailable-manifest-only', testFiles: [] },
    manifest
  )
  const plan = platformExecutionPlan(
    resolveAuthoritativePlan(
      classifyChanges(changes, undefined, { moduleManifest: manifest }),
      modulePlan
    ),
    changes,
    event
  )
  return selectWindowsCoreChecks(plan, modulePlan, changes, manifest, event)
}
const core = select(['src/main/literature/catalog.ts'])

describe('Windows core impact and event selection', () => {
  it('keeps literature regressions and defers indirect process integration to queue', () => {
    expect(core.windowsCoreChecks).toContain('windows_regressions')
    expect(core.windowsCoreChecks).not.toContain('windows_process')
    expect(core.windowsCoreChecks).not.toContain('windows_wheel_evidence')
    expect(core.windowsCoreChecks).not.toContain('windows_shell')
    expect(core.windowsCoreChecks).not.toContain('windows_sandbox')
    const queue = select(['src/main/literature/catalog.ts'], 'merge_group')
    expect(queue.windowsCoreChecks).toEqual(
      expect.arrayContaining([...core.windowsCoreChecks, 'windows_process'])
    )
    expect(core.reasonChains).toEqual(
      expect.arrayContaining([expect.stringContaining('deferred to merge queue')])
    )
  })

  it.each([
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

  it('keeps manual coverage and does not introduce core for renderer/docs changes', () => {
    expect(
      select(['src/main/literature/catalog.ts'], 'workflow_dispatch').windowsCoreChecks
    ).toEqual(expect.arrayContaining(Object.keys(windowsCoreChecks)))
    expect(select(['docs/testing.md']).windowsCoreChecks).toBeUndefined()
    expect(
      select(['src/renderer/src/pages/literature/LiteratureLibraryPage.tsx']).windowsCoreChecks
    ).toBeUndefined()
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

it.each(
  ['pull_request', 'merge_group'].flatMap((event) => [
    {
      event,
      owner: 'main_literature',
      path: 'src/main/literature/catalog.ts',
      explanation: productionFullReasonContracts.main_literature
    },
    {
      event,
      owner: 'page_literature',
      path: 'src/renderer/src/pages/literature/LiteratureLibraryPage.tsx',
      explanation:
        'Supplementary lookup and shared download rows expand the reviewed literature renderer boundary; require full CI validation until the expanded sources and interaction contracts are reviewed.'
    }
  ])
)(
  'retains every Windows core check for the real full $owner on $event',
  ({ event, owner, path, explanation }) => {
    const manifest = loadModuleImpactManifest()
    const changes = [{ path, status: 'modified' }]
    const modulePlan = createAffectedTestPlan(
      changes,
      { status: 'not-requested', testFiles: [] },
      manifest
    )
    expect(manifest.modules[owner].fullTestReason).toBe(explanation)
    const reason = `${owner} -> ${explanation} -> full`
    expect(modulePlan.mode).toBe('full')
    expect(modulePlan.reasonChains.join('\n')).toContain(reason)
    const selected = selectWindowsCoreChecks(
      platformExecutionPlan(
        resolveAuthoritativePlan(
          classifyChanges(changes, undefined, { moduleManifest: manifest }),
          modulePlan
        ),
        changes,
        event
      ),
      modulePlan,
      changes,
      manifest,
      event
    )
    expect(selected.mode).toBe('full')
    expect(selected.windowsCoreChecks).toEqual(
      expect.arrayContaining(Object.keys(windowsCoreChecks))
    )
    expect(validWindowsCoreChecks(selected)).toBe(true)
    const conclusions = Object.fromEntries(
      ['preflight', ...selected.bundles].map((name) => [name, 'success'])
    )
    expect(
      evaluatePrGate(
        selected,
        { ...conclusions, windows_core: 'skipped' },
        { executionMode: 'bundles' }
      ).ok
    ).toBe(false)
  }
)
