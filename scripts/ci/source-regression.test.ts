import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { classifyChanges, macosGroupsForPlan, toGitHubOutputPlan } from './classify-pr-changes.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { resolveAuthoritativePlan } from './module-impact-shadow.mjs'

type Step = {
  'continue-on-error'?: boolean
  id?: string
  name: string
  run?: string
  if?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
type Job = {
  permissions?: Record<string, string>
  'timeout-minutes'?: number
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  'runs-on': string
  'continue-on-error'?: boolean
  steps: Step[]
  strategy?: {
    matrix: {
      group?: string
      shard?: string
      include?: Array<{ scope: string; shard: number; total: number }>
    }
  }
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

it('uses the packaging heap budget for Web builds in every workflow', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  expect(scripts['build:web']).toBe('npm run build:packages && npm run build:web:compiled')
  expect(scripts['build:web:compiled']).toBe(
    'npm run gen:web-api-map && node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --config vite.web.config.ts'
  )
})

it('checks the reported Windows failures in the blocking PR core job', () => {
  const step = pr.jobs.windows_core.steps.find(
    ({ name }) => name === 'Test scheduled Windows validation regressions'
  )!
  expect(step.if).toContain("'windows_runtime'")
  expect(step.if).toContain("inputs.dry_run != 'windows-process'")
  expect(step['continue-on-error']).toBe(true)
  const enforce = pr.jobs.windows_core.steps.find(
    ({ name }) => name === 'Enforce selected Windows core checks'
  )!
  expect(enforce.run).toContain('check windows_regressions')
  for (const path of [
    'src/main/database/migration-service.test.ts',
    'scripts/ci/package-boundaries.test.ts',
    'src/main/desktop-startup-recovery.test.ts',
    'src/main/update/installation-protection.test.ts',
    'src/main/update/deb-systemd-gate.test.ts',
    'src/main/session-diagnostics/collector.test.ts',
    'src/main/literature/smart-collections.test.ts',
    'src/main/literature/pdf-structure/owner.test.ts',
    'src/main/notebook/kernel-startup-retry.integration.test.ts'
  ])
    expect(step.run).toContain(path)
  expect(step.run).toContain('--testNamePattern')
  for (const name of [
    'fills derived literature text',
    'persisted path spelling',
    'queued automatic inference',
    'startup Recover settles'
  ])
    expect(step.run).toContain(name)
  expect(step.run).toContain('--maxWorkers=1 --testTimeout=60000 --hookTimeout=60000')
  expect(step.env).toMatchObject({ VITEST_WINDOWS_FULL_TEST: '1' })
})

describe('trusted supplemental selection', () => {
  it.each([
    'packages/connector-builtins/src/genes-ontology.ts',
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
      changesFor(['packages/connector-builtins/src/genes-ontology.ts'])
    )
    expect(macosGroupsForPlan(candidate)).toEqual(['journeys'])
    const plan = resolveAuthoritativePlan(candidate, modules)
    expect(plan.mode).toBe('selective')
    expect(macosGroupsForPlan(plan)).toEqual(expect.arrayContaining(['regressions', 'delegation']))
  })

  it('omits idle presentation jobs but retains runtime and delegation coverage for mixed ontology/Notebook changes', () => {
    const changes = changesFor([
      'packages/connector-builtins/src/genes-ontology.ts',
      'packages/connector-builtins/src/genes-ontology.test.ts',
      'src/main/notebook/host-mcp.integration.test.ts'
    ])
    const modules = createAffectedTestPlan(changes, graph)
    const plan = resolveAuthoritativePlan(classifyChanges(changes), modules)
    expect(plan.mode).toBe('selective')
    expect(modules.modules).toEqual(['connector_builtins', 'notebook_application'])
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
      'packages/connector-builtins/src/genes-ontology.ts'
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

  it('installs Chromium before every Mac group that launches a browser', () => {
    const steps = scheduled.jobs.regression.steps
    const install = steps.find(({ name }) => name === 'Install headless Chromium')!
    expect(install.run).toBe('npx playwright install chromium --only-shell')
    expect(install.if).toBe(
      "${{ matrix.group == 'functional' || matrix.group == 'presentation' || matrix.group == 'presentation-screening' }}"
    )
    for (const id of ['functional', 'presentation', 'presentation_screening'])
      expect(steps.indexOf(install)).toBeLessThan(steps.findIndex((step) => step.id === id))
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
    'e2e/playwright.browser.config.ts',
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
      resolvePlan(['packages/connector-builtins/src/genes-ontology.ts'])
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

it('shares one immutable setup across independent Mac jobs', () => {
  expect(scheduled.jobs.macos_setup).toBeDefined()
  expect(scheduled.jobs.regression.needs).toEqual(['macos_setup'])
  expect(scheduled.jobs.regression.strategy).toMatchObject({ 'fail-fast': false })
  expect(
    scheduled.jobs.regression.steps.some(({ run }) =>
      run?.includes('e2e-setup-snapshot.mjs restore')
    )
  ).toBe(true)
})

describe('independent source regression', () => {
  const select = scheduled.jobs.macos_setup.steps.find(({ id }) => id === 'select')!
  const enforce = scheduled.jobs.regression.steps.find(
    ({ name }) => name === 'Enforce selected Mac suite'
  )!
  const regression = action.runs.steps.find(({ name }) => name === 'Run supplemental regressions')!
  const full = [
    { group: 'functional', shard: 1 },
    { group: 'workspace', shard: 1 },
    { group: 'presentation', shard: 1 },
    ...[1, 2, 3].map((shard) => ({ group: 'regressions', shard })),
    { group: 'capacity', shard: 1 },
    { group: 'delegation', shard: 1 }
  ]
  const selectGroups = (
    mode: string,
    shard = 'all'
  ): { status: number | null; matrix?: unknown } => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-regression-selection-'))
    try {
      const output = join(dir, 'output')
      const result = spawnSync(process.execPath, ['-e', select.run!], {
        env: { ...process.env, MODE: mode, SHARD: shard, GITHUB_OUTPUT: output },
        encoding: 'utf8'
      })
      return {
        status: result.status,
        matrix:
          result.status === 0
            ? JSON.parse(readFileSync(output, 'utf8').trim().slice('matrix='.length))
            : undefined
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('selects all eight jobs for full coverage even with a diagnostic shard input', () => {
    for (const shard of ['all', '1', '2', '3'])
      expect(selectGroups('full', shard)).toEqual({ status: 0, matrix: { include: full } })
    expect(scheduled.jobs.regression.strategy?.matrix).toBe(
      '${{ fromJSON(needs.macos_setup.outputs.matrix) }}'
    )
    expect(select.env).toEqual({
      MODE: "${{ inputs.mode || 'full' }}",
      SHARD: "${{ inputs.shard || 'all' }}"
    })
  })

  it('runs focused modes through the same jobs without unrelated groups', () => {
    for (const group of [
      'functional',
      'workspace',
      'presentation',
      'capacity',
      'delegation',
      'scheduled-fixes',
      'workspace-images',
      'presentation-screening'
    ])
      expect(selectGroups(group)).toEqual({ status: 0, matrix: { include: [{ group, shard: 1 }] } })
    for (const shard of ['1', '2', '3'])
      expect(selectGroups('regressions', shard)).toEqual({
        status: 0,
        matrix: { include: [{ group: 'regressions', shard: Number(shard) }] }
      })
    expect(selectGroups('regressions').matrix).toEqual({
      include: full.filter(({ group }) => group === 'regressions')
    })
    for (const [mode, shard] of [
      ['invalid', 'all'],
      ['full', '4'],
      ['full', '$(exit 0)']
    ])
      expect(selectGroups(mode, shard).status).not.toBe(0)
  })

  it('retains both daily rounds and diagnostic modes without publication', () => {
    expect(scheduled.on.schedule).toEqual([{ cron: '37 5,17 * * *' }])
    const dispatch = scheduled.on.workflow_dispatch as {
      inputs: { mode: { options: string[] }; shard: { options: string[] } }
    }
    expect(dispatch.inputs.mode.options).toEqual([
      'full',
      'portable',
      'functional',
      'workspace',
      'regressions',
      'capacity',
      'delegation',
      'scheduled-fixes',
      'presentation',
      'workspace-images',
      'presentation-screening',
      'runtime-evidence',
      'static-impact'
    ])
    expect(dispatch.inputs.shard.options).toEqual(['all', '1', '2', '3'])
    expect(scheduled.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(scheduled.on).not.toHaveProperty('push')
    expect(scheduled.jobs).not.toHaveProperty('plan')
    expect(scheduled.jobs.macos_setup.if).toBe(
      "${{ (github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main') && inputs.mode != 'portable' && inputs.mode != 'runtime-evidence' && inputs.mode != 'static-impact' }}"
    )
    expect(scheduled.concurrency).toEqual({
      group: 'source-regression-${{ github.event_name }}-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(scheduled.jobs.report.if).toBe("${{ always() && github.event_name == 'schedule' }}")
  })

  it('builds once and restores the exact producer snapshot and Node version in every Mac job', () => {
    const setup = scheduled.jobs.macos_setup
    const consumer = scheduled.jobs.regression
    expect(setup['runs-on']).toBe('macos-15')
    expect(consumer['runs-on']).toBe(setup['runs-on'])
    expect(setup.needs).toBeUndefined()
    expect(setup.steps.filter(({ run }) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(setup.steps.filter(({ run }) => run === 'npm run build:web')).toHaveLength(1)
    expect(
      consumer.steps.some(({ run }) => run?.includes('npm-ci') || run?.includes('npm run build:'))
    ).toBe(false)
    expect(consumer.steps.find(({ name }) => name === 'Setup Node')?.with?.['node-version']).toBe(
      '${{ needs.macos_setup.outputs.node_version }}'
    )
    expect(
      consumer.steps.find(({ name }) => name === 'Download E2E setup')?.with?.['artifact-ids']
    ).toBe('${{ needs.macos_setup.outputs.artifact_id }}')
    expect(consumer.if).toBe("${{ !cancelled() && needs.macos_setup.result == 'success' }}")
    const upload = consumer.steps.find(({ name }) => name === 'Upload diagnostics')!
    expect(upload.if).toBe('always()')
    expect(upload.with?.name).toBe(
      'source-regression-${{ matrix.group }}-${{ matrix.shard }}-${{ github.run_attempt }}'
    )
    expect(upload.with?.['if-no-files-found']).toBe('error')
  })

  it.skipIf(process.platform === 'win32')(
    'preserves PR defaults and separates capacity from all three ordinary shards',
    () => {
      const run = (group: string, capacity: string, shard = ''): SpawnSyncReturns<string> =>
        spawnSync('bash', ['-e', '-c', 'npm() { printf "%s\\n" "$@"; };\n' + regression.run!], {
          env: { ...process.env, GROUP: group, INCLUDE_CAPACITY: capacity, SHARD: shard },
          encoding: 'utf8'
        })
      expect(
        pr.jobs.macos_e2e.steps.find((step) => step.with?.group === 'regressions')?.with?.[
          'include-capacity'
        ]
      ).toBe('false')
      expect(run('regressions', 'true').stdout).toContain('--global-timeout=4500000')
      const ordinary = run('regressions', 'false')
      expect(ordinary.status).toBe(0)
      expect(ordinary.stdout).toContain('--grep-invert\n@capacity')
      expect(ordinary.stdout).toContain('--global-timeout=1200000')
      for (const shard of ['1/3', '2/3', '3/3']) {
        const result = run('regressions', 'false', shard)
        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`--shard=${shard}`)
        expect(result.stdout).toContain('--grep-invert\n@capacity')
        expect(result.stdout).toContain('--global-timeout=1800000')
      }
      const capacity = run('capacity', 'false')
      expect(capacity.status).toBe(0)
      expect(capacity.stdout).toContain('--grep\n@capacity')
      expect(capacity.stdout).not.toContain('--grep-invert')
      expect(capacity.stdout).not.toContain('--shard')
      for (const [group, capacity, shard] of [
        ['regressions', '', ''],
        ['regressions', 'false', '4/3'],
        ['regressions', 'false', '$(exit 0)'],
        ['capacity', 'false', '1/3']
      ])
        expect(run(group, capacity, shard).status).not.toBe(0)
      const call = scheduled.jobs.regression.steps.find(({ id }) => id === 'regressions')!
      expect(call.uses).toBe('./.github/actions/source-regression')
      expect(call.with).toEqual({
        group: '${{ matrix.group }}',
        'include-capacity': 'false',
        shard: "${{ matrix.group == 'regressions' && format('{0}/3', matrix.shard) || '' }}"
      })
    }
  )

  it.skipIf(process.platform === 'win32')('rejects invalid action groups', () => {
    const validate = action.runs.steps.find(({ name }) => name === 'Validate suite')!
    for (const group of [
      'regressions',
      'capacity',
      'delegation',
      'unknown',
      '$(exit 0)',
      'regressions; exit 0'
    ]) {
      const result = spawnSync('bash', ['-e', '-c', validate.run!], {
        env: { ...process.env, GROUP: group }
      })
      expect(result.status).toBe(['regressions', 'capacity', 'delegation'].includes(group) ? 0 : 1)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'fails each selected job on failed, cancelled or absent suite execution',
    () => {
      const required = {
        functional: ['FUNCTIONAL'],
        workspace: ['WORKSPACE'],
        presentation: ['PRESENTATION', 'ACCESSIBILITY'],
        regressions: ['REGRESSIONS'],
        capacity: ['REGRESSIONS'],
        delegation: ['DELEGATION'],
        'scheduled-fixes': ['SCHEDULED_FIXES'],
        'workspace-images': ['WORKSPACE_IMAGES'],
        'presentation-screening': ['PRESENTATION_SCREENING']
      }
      expect(enforce.if).toBe('always()')
      for (const [group, keys] of Object.entries(required)) {
        const env = {
          ...process.env,
          ...Object.fromEntries(Object.keys(enforce.env!).map((key) => [key, 'skipped'])),
          GROUP: group,
          ...Object.fromEntries(keys.map((key) => [key, 'success']))
        }
        expect(spawnSync('bash', ['-e', '-c', enforce.run!], { env }).status).toBe(0)
        for (const key of keys)
          for (const result of ['failure', 'cancelled', 'skipped', ''])
            expect(
              spawnSync('bash', ['-e', '-c', enforce.run!], { env: { ...env, [key]: result } })
                .status
            ).toBe(1)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'runs visual coverage after browser failure and fails either result',
    () => {
      const step = scheduled.jobs.regression.steps.find(({ id }) => id === 'presentation')!
      for (const browser of [0, 1])
        for (const visual of [0, 1]) {
          const result = spawnSync(
            'bash',
            [
              '-e',
              '-c',
              `npx() { echo browser; return ${browser}; }\nnpm() { echo visual; return ${visual}; }\n${step.run}`
            ],
            { encoding: 'utf8' }
          )
          expect(result.stdout).toContain('visual')
          expect(result.status).toBe(browser || visual)
        }
      expect(step.run).toContain('blob-report/browser')
      expect(step.run).toContain('blob-report/visual')
      expect(
        scheduled.jobs.regression.steps.find(({ id }) => id === 'accessibility')?.env
          ?.PLAYWRIGHT_BLOB_OUTPUT_DIR
      ).toBe('blob-report/accessibility')
      expect(
        scheduled.jobs.regression['timeout-minutes']! * 60000 - (900000 + 600000 + 600000)
      ).toBeGreaterThanOrEqual(10 * 60000)
    }
  )

  it('retains focused regression, workspace image and screening commands', () => {
    const steps = scheduled.jobs.regression.steps
    const cases = [
      ['scheduled_fixes', 'scheduled-fixes', 'e2e/desktop-runtime-restart.spec.ts'],
      ['workspace_images', 'workspace-images', 'normalizes OpenCode inline thinking'],
      ['presentation_screening', 'presentation-screening', '--repeat-each=5']
    ]
    for (const [id, group, command] of cases) {
      const step = steps.find((step) => step.id === id)!
      expect(step.if).toBe(`\${{ matrix.group == '${group}' }}`)
      expect(step.run).toContain(command)
      expect(step.run).toContain('--fail-on-flaky-tests')
    }
  })

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

it('shares complete installed-consumer checks with queue/manual runs and reports scheduled failures', () => {
  expect(scheduled.jobs.packages.if).toBe(
    "${{ github.event_name == 'schedule' || inputs.mode == 'full' }}"
  )
  expect(scheduled.jobs.packages['runs-on']).toBe('ubuntu-latest')
  expect(
    scheduled.jobs.packages.steps.some((step) => step.uses === './.github/actions/verify-packages')
  ).toBe(true)
  expect(scheduled.jobs.report.needs).toEqual([
    'macos_setup',
    'regression',
    'packages',
    'portable',
    'portable_report'
  ])
  const manual = load(
    readFileSync('.github/workflows/package-test-policy-dry-run.yml', 'utf8')
  ) as Workflow
  expect(Object.keys(manual.on)).toEqual(['workflow_dispatch'])
  expect(
    manual.jobs.isolation.steps.find((step) => step.uses === './.github/actions/verify-packages')
      ?.with
  ).toEqual({ selection: '${{ inputs.packages }}' })
})

it('runs complete portable discovery with no package exclusions and defers thresholds until all host and package reports', () => {
  const portable = scheduled.jobs.portable
  expect(portable.if).toContain("github.event_name == 'schedule'")
  expect(portable.if).toContain("inputs.mode == 'portable'")
  expect(portable['continue-on-error']).toBeUndefined()
  expect(portable.strategy?.matrix.include).toEqual([
    ...[1, 2, 3, 4].map((shard) => ({ scope: 'host', shard, total: 4 })),
    ...[1, 2].map((shard) => ({ scope: 'packages', shard, total: 2 }))
  ])
  expect(portable.env).toMatchObject({
    OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]',
    OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]',
    VITEST_DEFER_COVERAGE_THRESHOLDS: '1',
    OPEN_SCIENCE_CI_PORTABLE_SCOPE: '${{ matrix.scope }}'
  })
  const test = portable.steps.find(({ name }) => name === 'Test complete portable shard')!
  expect(test.run).toContain('npm test -- --coverage')
  expect(test.run).not.toContain('test:affected')
  expect(portable.steps.some(({ uses }) => uses === './.github/actions/select-package-tests')).toBe(
    false
  )
  const report = scheduled.jobs.portable_report
  expect(report.env).toMatchObject({
    OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]',
    OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]'
  })
  expect(report.env).not.toHaveProperty('VITEST_DEFER_COVERAGE_THRESHOLDS')
  expect(report.env).not.toHaveProperty('OPEN_SCIENCE_CI_PORTABLE_SCOPE')
  for (const step of report.steps)
    expect(step.env ?? {}).not.toHaveProperty('VITEST_DEFER_COVERAGE_THRESHOLDS')
  expect(report.if).toContain('always()')
  expect(report.needs).toEqual(['portable'])
  expect(report.steps.find(({ name }) => name === 'Require every portable shard')?.run).toBe(
    'test "$PORTABLE_RESULT" = success'
  )
  expect(
    report.steps.find(({ name }) => name === 'Require all host and package reports')?.run
  ).toContain('for shard in 1 2 3 4')
  expect(report.steps.find(({ name }) => name === 'Merge complete coverage')?.run).toContain(
    '--merge-reports=vitest-reports --coverage'
  )
  expect(
    report.steps.find(({ name }) => name === 'Test i18n catalog excluded from portable shards')?.env
      ?.VITEST_PORTABLE_CI
  ).toBe('0')
  const outcome = scheduled.jobs.report.steps.find(({ env }) => env?.CONCLUSION)?.env?.CONCLUSION
  for (const job of ['regression', 'packages', 'portable', 'portable_report'])
    expect(outcome).toContain(`needs.${job}.result == 'success'`)
  expect(scheduled.jobs.macos_setup.if).toContain("inputs.mode != 'portable'")
  expect(scheduled.jobs.packages.if).not.toContain("inputs.mode == 'portable'")
})

it.skipIf(process.platform === 'win32')(
  'never reports skipped, failed or cancelled portable shards as complete coverage',
  () => {
    const step = scheduled.jobs.portable_report.steps.find(
      ({ name }) => name === 'Require every portable shard'
    )!
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const run = spawnSync('bash', ['-e', '-c', step.run!], {
        env: { ...process.env, PORTABLE_RESULT: result }
      })
      expect(run.status).toBe(result === 'success' ? 0 : 1)
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'rejects missing or empty host and package reports before merging coverage',
  () => {
    const step = scheduled.jobs.portable_report.steps.find(
      ({ name }) => name === 'Require all host and package reports'
    )!
    const cwd = mkdtempSync(join(tmpdir(), 'portable-reports-'))
    const reports = scheduled.jobs.portable.strategy!.matrix.include!.map(({ scope, shard }) =>
      join(cwd, 'vitest-reports', `blob-${scope}-${shard}.json`)
    )
    const run = (): number | null => spawnSync('bash', ['-e', '-c', step.run!], { cwd }).status
    try {
      mkdirSync(join(cwd, 'vitest-reports'))
      for (const file of reports) writeFileSync(file, '{}')
      expect(run()).toBe(0)
      for (const file of reports) {
        rmSync(file)
        expect(run(), `missing ${file}`).not.toBe(0)
        writeFileSync(file, '')
        expect(run(), `empty ${file}`).not.toBe(0)
        writeFileSync(file, '{}')
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)

it('runs the same isolated test-impact verifier on three operating systems only on explicit dispatch', () => {
  const job = scheduled.jobs.static_impact
  expect(job.if).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'static-impact' }}"
  )
  expect(job.permissions).toEqual({ contents: 'read' })
  expect(job.strategy).toEqual({
    'fail-fast': false,
    matrix: { os: ['ubuntu-latest', 'windows-latest', 'macos-15'] }
  })
  expect(job.steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    'npm run check:test-impact-package'
  ])
  expect(
    job.steps.some(
      (step) => step.uses?.startsWith('actions/setup-node@') && step.with?.['node-version'] === 24
    )
  ).toBe(true)
  expect(scheduled.jobs.macos_setup.if).toContain("inputs.mode != 'static-impact'")
  for (const name of ['portable', 'portable_report', 'packages', 'report'])
    expect(scheduled.jobs[name].if).not.toContain('static-impact')
})

it('offers a focused scheduled-fixes dry-run on the real Mac job', () => {
  const step = scheduled.jobs.regression.steps.find(
    ({ name }) => name === 'Test scheduled regression fixes'
  )!
  expect(step.if).toContain("matrix.group == 'scheduled-fixes'")
  expect(scheduled.on.workflow_dispatch).toHaveProperty(
    'inputs.test_pattern',
    expect.objectContaining({
      type: 'string',
      default: ''
    })
  )
  expect(step.env?.TEST_PATTERN).toBe('${{ inputs.test_pattern }}')
  expect(step.run).toContain('--grep "$TEST_PATTERN"')
  for (const file of [
    'session-turn-outcome',
    'auto-review-stop-resume',
    'transcript-capacity',
    'desktop-runtime-restart'
  ])
    expect(step.run).toContain(`e2e/${file}.spec.ts`)
  expect(step.run).toContain('--retries=0 --fail-on-flaky-tests')
  expect(step['continue-on-error']).toBe(true)
})
