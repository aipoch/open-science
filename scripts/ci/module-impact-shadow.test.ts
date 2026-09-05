import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { classifyChanges, toGitHubOutputPlan } from './classify-pr-changes.mjs'
import { runModuleImpactAuthorityCli } from './module-impact-authority.mjs'
import {
  createModuleImpactShadowReport,
  formatModuleImpactShadowSummary,
  requiredLanesForModulePlan,
  runModuleImpactShadowCli
} from './module-impact-shadow.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

const changeImpactManifest = JSON.parse(
  readFileSync(resolve('scripts/ci/change-impact.json'), 'utf8')
) as { laneOrder: string[] }

const manifestOnlyGraph = {
  status: 'unavailable-manifest-only',
  reason: 'CI shadow uses the repository manifest only',
  testFiles: []
}

function reportFor(
  changes: Array<{ path: string; previousPath?: string; status: string }>
): ReturnType<typeof createModuleImpactShadowReport> {
  return createModuleImpactShadowReport(
    classifyChanges(changes),
    createAffectedTestPlan(changes, manifestOnlyGraph)
  )
}

describe('module impact shadow', () => {
  it.each([
    [
      'project defaults recovery',
      [
        'src/main/projects/deletion-coordinator.test.ts',
        'src/main/projects/deletion-coordinator.ts',
        'src/main/projects/ipc.test.ts',
        'src/main/projects/project-owned-data.catalog.architecture.test.ts',
        'src/main/projects/repository.test.ts',
        'src/main/projects/repository.ts',
        'src/main/session-persistence/ipc.test.ts'
      ]
    ],
    [
      'deletion compensation',
      [
        'src/main/projects/deletion-coordinator.test.ts',
        'src/main/projects/deletion-coordinator.ts',
        'src/main/session-persistence/coordinator.test.ts',
        'src/main/session-persistence/deletion-owner.ts'
      ]
    ]
  ])('keeps the complete %s diff selective with lifecycle consumers', (_name, paths) => {
    const report = reportFor(paths.map((path) => ({ path, status: 'modified' })))

    expect(report.resolved.mode).toBe('selective')
    expect(report.shadow.modules).toContain('project_lifecycle')
    expect(report.shadow.testFiles).toEqual(
      expect.arrayContaining([
        ...paths.filter((path) => path.endsWith('.test.ts')),
        'src/main/projects/project-runtime-quiescence-owner.test.ts',
        'src/main/session-persistence/deletion-integration.test.ts',
        'src/main/data-content-application-commands.test.ts',
        'src/main/application-command-wiring.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts',
        'src/main/permission-grants/registry.test.ts',
        'src/renderer/src/stores/project-store.test.ts',
        'src/renderer/src/pages/home/HomePage.persistence.test.tsx'
      ])
    )
    expect(report.resolved.lanes).toEqual(
      expect.arrayContaining([
        'unit_macos',
        'interface_contracts',
        'typecheck_node',
        'typecheck_web',
        'build',
        'windows_runtime',
        'windows_path',
        'e2e_functional_macos',
        'e2e_workspace_macos',
        'e2e_functional_windows',
        'e2e_workspace_windows'
      ])
    )
    expect(report.resolved.lanes).not.toContain('linux_runtime')
    expect(report.resolved.lanes).not.toContain('e2e_visual_macos')
    expect(report.resolved.lanes).not.toContain('e2e_accessibility_macos')
  })

  it('expands the session deletion interface to its injected project lifecycle caller', () => {
    const report = reportFor([
      { path: 'src/main/session-persistence/coordinator.ts', status: 'modified' }
    ])

    expect(report.resolved.reasonChains).toContain('session_persistence -> project_lifecycle')
    expect(report.shadow.testFiles).toContain('src/main/projects/deletion-coordinator.test.ts')
    expect(report.shadow.testFiles).toContain('src/main/session-persistence/ipc.test.ts')
  })

  it('keeps documentation in its own lane when accompanying an owned code change', () => {
    const source = { path: 'src/main/projects/deletion-coordinator.ts', status: 'modified' }
    const codeOnly = reportFor([source])
    const report = reportFor([source, { path: 'docs/PRD.md', status: 'modified' }])

    expect(report.resolved.mode).toBe('selective')
    expect(report.shadow.modules).toEqual(codeOnly.shadow.modules)
    expect(report.shadow.testFiles).toEqual(codeOnly.shadow.testFiles)
    expect(report.resolved.lanes).toEqual(
      expect.arrayContaining([...codeOnly.resolved.lanes, 'docs'])
    )
    expect(report.resolved.reasonChains).toContain(
      'docs/PRD.md -> documentation lane -> no module tests'
    )

    const unknown = reportFor([
      source,
      { path: 'README.md', status: 'modified' },
      { path: 'src/main/projects/new-owner.ts', status: 'added' }
    ])
    expect(unknown.resolved.mode).toBe('full')
    expect(unknown.resolved.reasonChains).toContain(
      'src/main/projects/new-owner.ts -> unknown module owner -> full'
    )
    expect(reportFor([source, { path: 'package.json', status: 'modified' }]).resolved.mode).toBe(
      'full'
    )
  })

  it('promotes deterministic module evidence into the resolved plan', () => {
    const report = reportFor([
      { path: 'src/renderer/src/stores/session-store.ts', status: 'modified' }
    ])

    expect(report.enforcement).toBe('blocking')
    expect(report.authoritative.mode).toBe('selective')
    expect(report.shadow).toMatchObject({
      mode: 'selective',
      graphStatus: 'unavailable-manifest-only',
      modules: [
        'compute_service',
        'project_files_view',
        'session_renderer',
        'workspace_page',
        'workspace_runtime'
      ]
    })
    expect(report.shadow.testFiles).toEqual([...report.shadow.testFiles].sort())
    expect(report.shadow.capabilityOverlays).toEqual(['renderer_state', 'windows_sensitive'])
    expect(report.shadow.fallbackCapabilities).toEqual(['main_runtime', 'renderer_view'])
    expect(report.comparison.requiredLanes).toContain('typecheck_web')
    expect(report.comparison.selectedLanes).toEqual(report.authoritative.lanes)
    expect(report.comparison.missingLanes).toEqual([
      'typecheck_node',
      'interface_contracts',
      'windows_runtime',
      'windows_path',
      'e2e_functional_windows',
      'e2e_workspace_windows'
    ])
    expect(report.comparison.coverage).toBe('gap')
    expect(report.resolved.lanes).toEqual(report.comparison.requiredLanes)
  })

  it('records candidate mode and lane disagreements before blocking resolution', () => {
    const modulePlan = createAffectedTestPlan(
      [{ path: 'src/main/artifacts/repository.ts', status: 'modified' }],
      manifestOnlyGraph
    )
    const authoritativePlan = {
      mode: 'full',
      roots: ['global'],
      lanes: ['policy'],
      bundles: ['policy'],
      reasonChains: ['global -> full']
    }
    const report = createModuleImpactShadowReport(authoritativePlan, modulePlan)

    expect(report.enforcement).toBe('blocking')
    expect(report.comparison.modeAgreement).toBe(false)
    expect(report.comparison.coverage).toBe('gap')
    expect(report.comparison.missingLanes).toContain('unit_macos')
    expect(report.comparison.disagreements).toEqual([
      'mode: authoritative full != shadow selective',
      expect.stringContaining('missing authoritative lanes:')
    ])
    expect(formatModuleImpactShadowSummary(report)).toContain('Candidate coverage: **gap**')
  })

  it.each([
    ['global full', { path: 'package.json', status: 'modified' }, 'full'],
    ['unknown', { path: 'src/main/unowned-module.ts', status: 'added' }, 'selective'],
    ['delete', { path: 'src/main/artifacts/repository.ts', status: 'deleted' }, 'full'],
    [
      'rename',
      {
        path: 'src/main/artifacts/repository-renamed.ts',
        previousPath: 'src/main/artifacts/repository.ts',
        status: 'renamed'
      },
      'full'
    ],
    [
      'Windows separator',
      { path: 'src\\main\\artifacts\\repository.ts', status: 'modified' },
      'full'
    ],
    [
      'Windows drive',
      { path: 'C:\\repo\\src\\main\\artifacts\\repository.ts', status: 'modified' },
      'full'
    ]
  ])('fails closed for a %s path change', (_case, change, authoritativeMode) => {
    const report = reportFor([change])

    expect(report.authoritative.mode).toBe(authoritativeMode)
    expect(report.shadow.mode).toBe('full')
    expect(report.comparison.requiredLanes).toHaveLength(changeImpactManifest.laneOrder.length)
    expect(report.comparison.coverage).toBe(authoritativeMode === 'full' ? 'covered' : 'gap')
  })

  it('promotes an unowned added Main file to the complete authoritative Windows plan', () => {
    const report = reportFor([{ path: 'src/main/platform-launcher.ts', status: 'added' }])

    expect(report.enforcement).toBe('blocking')
    expect(report.resolved).toMatchObject({
      mode: 'full',
      lanes: expect.arrayContaining([
        'unit_macos',
        'windows_runtime',
        'windows_path',
        'e2e_functional_windows',
        'e2e_workspace_windows'
      ]),
      bundles: expect.arrayContaining(['unit', 'windows_core', 'windows_e2e'])
    })
    expect(report.resolved.reasonChains).toContain(
      'src/main/platform-launcher.ts -> unknown module owner -> full'
    )
  })

  it('merges a known Module capability overlay into the selective authoritative plan', () => {
    const report = reportFor([{ path: 'src/main/artifacts/repository.ts', status: 'modified' }])

    expect(report.authoritative.lanes).not.toContain('windows_runtime')
    expect(report.resolved).toMatchObject({
      mode: 'selective',
      lanes: expect.arrayContaining(['unit_macos', 'windows_runtime', 'windows_path']),
      bundles: expect.arrayContaining(['unit', 'windows_core'])
    })
    expect(report.resolved.reasonChains).toContain(
      'src/main/artifacts/repository.ts -> artifact_storage'
    )
  })

  it('selects the Notebook network sandbox evidence and platform lanes', () => {
    const report = reportFor([
      { path: 'packages/notebook-network-sandbox/src/config.ts', status: 'modified' }
    ])

    expect(report.shadow).toMatchObject({
      mode: 'selective',
      modules: ['notebook_network_sandbox'],
      fallbackCapabilities: ['notebook_network_sandbox'],
      capabilityOverlays: []
    })
    expect(report.shadow.testFiles).toEqual([
      'packages/notebook-network-sandbox/src/address-policy.test.ts',
      'packages/notebook-network-sandbox/src/config.test.ts',
      'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts',
      'packages/notebook-network-sandbox/src/filesystem-policy.test.ts',
      'packages/notebook-network-sandbox/src/gateway.test.ts',
      'packages/notebook-network-sandbox/src/index.test.ts',
      'packages/notebook-network-sandbox/src/network-enforcement.integration.test.ts',
      'packages/notebook-network-sandbox/src/private-network.test.ts',
      'packages/notebook-network-sandbox/src/proxy-env.test.ts',
      'packages/notebook-network-sandbox/src/resources.test.ts',
      'packages/notebook-network-sandbox/src/runtime-config.test.ts',
      'packages/notebook-network-sandbox/src/windows-appcontainer.test.ts'
    ])
    expect(report.comparison.requiredLanes).toEqual(
      expect.arrayContaining([
        'unit_macos',
        'linux_runtime',
        'windows_runtime',
        'windows_path',
        'build'
      ])
    )
    expect(report.comparison.missingLanes).toEqual([])
  })

  it('publishes the resolved module authority through the existing PR Gate outputs', () => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    const execute = vi.fn().mockReturnValue(Buffer.from('A\0src/main/platform-launcher.ts\0'))
    const append = vi.fn()

    const { plan } = runModuleImpactAuthorityCli(
      ['--base', base, '--head', head],
      { GITHUB_OUTPUT: '/output', GITHUB_STEP_SUMMARY: '/summary' },
      { cwd: '/repo', execute, append }
    )

    expect(execute).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-status', '-z', base, head],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(plan).toMatchObject({
      mode: 'full',
      lanes: expect.arrayContaining(['windows_runtime', 'e2e_workspace_windows'])
    })
    expect(append).toHaveBeenCalledWith(
      '/output',
      expect.stringContaining(`plan=${JSON.stringify(toGitHubOutputPlan(plan))}`)
    )
    expect(append.mock.calls.find(([path]) => path === '/output')?.[1]).not.toContain(
      'reasonChains'
    )
    expect(append).toHaveBeenCalledWith('/summary', expect.stringContaining('Resolved mode'))
  })

  it('does not require module ownership for a documentation-only plan', () => {
    const execute = vi.fn().mockReturnValue(Buffer.from('M\0docs/architecture.md\0'))
    const { plan, report } = runModuleImpactAuthorityCli(
      ['--base', '1'.repeat(40), '--head', '2'.repeat(40)],
      {},
      { cwd: '/repo', execute, write: vi.fn() }
    )

    expect(plan).toMatchObject({
      mode: 'selective',
      lanes: ['policy', 'docs'],
      bundles: ['policy', 'static']
    })
    expect(report.shadow.graphStatus).toBe('not-used')
  })

  it.each(
    readdirSync(resolve('src/shared/i18n/locales'))
      .filter((name) => name.endsWith('.json'))
      .sort()
  )(
    'owns %s catalog edits as a selective i18n module instead of an unknown full plan',
    (catalog) => {
      const report = reportFor([{ path: `src/shared/i18n/locales/${catalog}`, status: 'modified' }])

      expect(report.authoritative.mode).toBe('selective')
      expect(report.shadow).toMatchObject({
        mode: 'selective',
        modules: ['i18n_catalog', 'i18n_main_adapter', 'i18n_renderer_adapter']
      })
      expect(report.shadow.testFiles).toEqual([
        'src/main/locale/owner.test.ts',
        'src/renderer/src/i18n/resources.test.ts'
      ])
      expect(report.shadow.fallbackCapabilities).toEqual([
        'main_runtime',
        'renderer_view',
        'shared_contract'
      ])
      expect(report.comparison.requiredLanes).toContain('i18n')
      expect(report.comparison.selectedLanes).toContain('i18n')
      expect(report.comparison.missingLanes).toEqual([])
      expect(report.comparison.coverage).toBe('covered')
    }
  )

  it.each([
    ['main resources', 'src/main/locale/resources.ts', 'i18n_main_adapter', 'main_runtime'],
    [
      'main translator',
      'src/main/locale/main-process-messages.ts',
      'i18n_main_adapter',
      'main_runtime'
    ],
    ['main locale owner', 'src/main/locale/owner.ts', 'i18n_main_adapter', 'main_runtime'],
    ['renderer', 'src/renderer/src/i18n/resources.ts', 'i18n_renderer_adapter', 'renderer_view']
  ])('uses the %s process fallback for its i18n adapter', (_surface, path, module, fallback) => {
    const report = reportFor([{ path, status: 'modified' }])

    expect(report.shadow).toMatchObject({
      mode: 'selective',
      modules: [module],
      capabilityOverlays: ['i18n_catalog'],
      fallbackCapabilities: [fallback]
    })
    expect(report.comparison.missingLanes).toEqual([])
    expect(report.comparison.coverage).toBe('covered')
  })

  it('keeps slash-based macOS and Linux fixtures portable and handles no diff', () => {
    for (const path of [
      'src/main/artifacts/repository.ts',
      'src/renderer/src/stores/session-store.ts'
    ]) {
      expect(reportFor([{ path, status: 'modified' }]).shadow.mode).toBe('selective')
    }

    const noDiff = reportFor([])
    expect(noDiff.shadow).toMatchObject({ mode: 'selective', modules: [], testFiles: [] })
    expect(noDiff.comparison).toMatchObject({
      requiredLanes: ['policy'],
      selectedLanes: ['policy'],
      missingLanes: [],
      coverage: 'covered'
    })
  })

  it('preserves authoritative owner-ambiguity evidence in a full report', () => {
    const fullLanes = requiredLanesForModulePlan({ mode: 'full' })
    const modulePlan = createAffectedTestPlan(
      [{ path: 'src/main/unowned-module.ts', status: 'added' }],
      manifestOnlyGraph
    )
    const report = createModuleImpactShadowReport(
      {
        mode: 'full',
        roots: ['owner_ambiguity'],
        lanes: fullLanes,
        bundles: [],
        reasonChains: ['ambiguous.ts -> owner ambiguity: a, b -> full']
      },
      modulePlan
    )

    expect(report.authoritative.roots).toEqual(['owner_ambiguity'])
    expect(report.authoritative.reasonChains).toEqual([
      'ambiguous.ts -> owner ambiguity: a, b -> full'
    ])
    expect(report.comparison).toMatchObject({ modeAgreement: true, missingLanes: [] })
  })

  it('expands fallback and overlay capability consumers into required lanes', () => {
    const lanes = requiredLanesForModulePlan({
      mode: 'selective',
      fallbackCapabilities: ['main_runtime'],
      capabilityOverlays: ['windows_sensitive']
    })

    expect(lanes).toEqual(
      expect.arrayContaining([
        'policy',
        'typecheck_node',
        'typecheck_web',
        'unit_macos',
        'windows_runtime',
        'e2e_workspace_windows'
      ])
    )
    expect(lanes.indexOf('policy')).toBeLessThan(lanes.indexOf('unit_macos'))
  })

  it('supports base/head and authoritative JSON while forcing manifest-only graph evidence', () => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    const authoritativePlan = classifyChanges([
      { path: 'src/main/artifacts/repository.ts', status: 'modified' }
    ])
    const execute = vi.fn().mockReturnValue(Buffer.from('M\0src/main/artifacts/repository.ts\0'))
    const write = vi.fn()
    const append = vi.fn()

    const report = runModuleImpactShadowCli(
      ['--base', base, '--head', head, '--authoritative-plan', JSON.stringify(authoritativePlan)],
      { GITHUB_STEP_SUMMARY: '/summary' },
      { cwd: '/repo', execute, write, append }
    )

    expect(execute).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-status', '-z', base, head],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(execute).not.toHaveBeenCalledWith('codegraph', expect.anything(), expect.anything())
    expect(report.shadow.graphStatus).toBe('unavailable-manifest-only')
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(report)}\n`)
    expect(append).toHaveBeenCalledWith(
      '/summary',
      expect.stringContaining('## Module impact authority')
    )
  })

  it('sorts and escapes report evidence before publishing a summary', () => {
    const report = createModuleImpactShadowReport(
      {
        mode: 'selective',
        roots: ['z', '<unsafe>'],
        lanes: ['unit_macos', 'policy'],
        bundles: ['unit', 'policy'],
        reasonChains: ['z', '<unsafe>']
      },
      {
        mode: 'selective',
        modules: [],
        testFiles: [],
        capabilityOverlays: [],
        fallbackCapabilities: [],
        graphStatus: 'unavailable-manifest-only',
        graphReason: '<unavailable>',
        reasonChains: ['z', '<unsafe>']
      }
    )
    const summary = formatModuleImpactShadowSummary(report)

    expect(report.authoritative.roots).toEqual(['<unsafe>', 'z'])
    expect(report.authoritative.lanes).toEqual(['policy', 'unit_macos'])
    expect(summary).toContain('&lt;unsafe&gt;')
    expect(summary).not.toContain('<unsafe>')
  })
})
