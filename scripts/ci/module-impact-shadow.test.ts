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
import { createModuleImpactModel } from './module-impact-model.test-support'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { reviewedBoundaries } from './module-graph/policy.mjs'

const changeImpactManifest = JSON.parse(
  readFileSync(resolve('scripts/ci/change-impact.json'), 'utf8')
) as { laneOrder: string[] }

const manifestOnlyGraph = {
  status: 'unavailable-manifest-only',
  reason: 'CI shadow uses the repository manifest only',
  testFiles: []
}

// Policy-mechanics fixtures use fresh declared nodes and the protected source cohorts as
// inventory. Their evidence and edges are explicit below; they do not certify the expanded
// production research graph. Real full-classification contracts are checked separately.
const shadowModel = (): ReturnType<typeof createModuleImpactModel> => {
  type Owner = Parameters<typeof createModuleImpactModel>[0][string]
  const reviewed = (id: string, evidence: Omit<Owner, 'ownerPaths'>): Owner => ({
    ownerPaths: [
      ...reviewedBoundaries[id].sources,
      ...(reviewedBoundaries[id].resourcePaths ?? [])
    ],
    ...evidence
  })
  const lifecycleTests = [
    'src/main/projects/deletion-coordinator.test.ts',
    'src/main/projects/ipc.test.ts',
    'src/main/projects/project-owned-data.catalog.architecture.test.ts',
    'src/main/projects/repository.test.ts',
    'src/main/projects/project-runtime-quiescence-owner.test.ts',
    'src/main/session-persistence/deletion-integration.test.ts',
    'src/main/data-content-application-commands.test.ts',
    'src/main/application-command-wiring.test.ts',
    'src/main/compute/job-deletion-runtime-isolation.test.ts',
    'src/main/permission-grants/registry.test.ts',
    'src/renderer/src/stores/project-store.test.ts',
    'src/renderer/src/pages/home/HomePage.persistence.test.tsx'
  ]
  const sandboxTests = [
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
    'packages/notebook-network-sandbox/src/windows-appcontainer.test.ts',
    'packages/notebook-network-sandbox/src/local-service.test.ts'
  ]
  return createModuleImpactModel({
    main_pdf_translation: {
      ownerPaths: [
        'src/main/literature/pdf-translation/index.ts',
        'scripts/pdf-translation-corpus.test.ts'
      ],
      ownerTests: ['scripts/pdf-translation-corpus.test.ts'],
      capabilityOverlays: ['notebook_network_sandbox']
    },
    project_lifecycle: reviewed('project_lifecycle', {
      ownerTests: lifecycleTests,
      consumerTests: ['src/main/session-persistence/ipc.test.ts'],
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation']
    }),
    session_persistence: reviewed('session_persistence', {
      ownerTests: [
        'src/main/session-persistence/coordinator.test.ts',
        'src/main/session-persistence/ipc.test.ts'
      ],
      consumerTests: lifecycleTests,
      consumerModules: ['project_lifecycle'],
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation']
    }),
    session_renderer: reviewed('session_renderer', {
      ownerTests: ['src/renderer/src/stores/session-store.test.ts'],
      consumerModules: ['compute_service'],
      fallbackCapability: 'renderer_view',
      capabilityOverlays: ['renderer_state']
    }),
    compute_service: {
      ownerPaths: ['src/main/compute/compute-service.ts'],
      ownerTests: ['src/main/compute/compute-service.test.ts'],
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation']
    },
    artifact_storage: reviewed('artifact_storage', {
      ownerTests: ['src/main/artifacts/repository.test.ts'],
      consumerModules: ['artifact_provenance']
    }),
    artifact_provenance: {
      ownerPaths: ['src/main/artifacts/provenance-repository.ts'],
      ownerTests: ['src/main/artifacts/provenance-repository.test.ts'],
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation']
    },
    notebook_network_sandbox: {
      ownerPaths: ['packages/notebook-network-sandbox/src/config.ts'],
      ownerTests: sandboxTests,
      consumerModules: ['notebook_execution'],
      fallbackCapability: 'notebook_network_sandbox'
    },
    notebook_execution: {
      ownerPaths: ['src/main/notebook/runtime-service.ts'],
      ownerTests: [
        'src/main/notebook/local-service-lease.test.ts',
        'src/main/notebook/local-service.macos.integration.test.ts',
        'src/main/notebook/research-service.macos.integration.test.ts'
      ],
      capabilityOverlays: ['notebook_network_sandbox', 'windows_sensitive']
    },
    i18n_catalog: reviewed('i18n_catalog', {
      ownerTests: [
        'scripts/build-backend.integration.test.ts',
        'src/main/locale/owner.test.ts',
        'src/renderer/src/i18n/resources.test.ts'
      ],
      fallbackCapability: 'shared_contract',
      capabilityOverlays: ['i18n_catalog']
    }),
    i18n_main_adapter: reviewed('i18n_main_adapter', {
      ownerTests: ['src/main/locale/owner.test.ts'],
      capabilityOverlays: ['i18n_catalog']
    }),
    i18n_renderer_adapter: reviewed('i18n_renderer_adapter', {
      ownerTests: ['src/renderer/src/i18n/resources.test.ts'],
      fallbackCapability: 'renderer_view',
      capabilityOverlays: ['i18n_catalog']
    })
  })
}

function reportFor(
  changes: Array<{ path: string; previousPath?: string; status: string }>
): ReturnType<typeof createModuleImpactShadowReport> {
  const manifest = shadowModel()
  return createModuleImpactShadowReport(
    classifyChanges(changes, undefined, { moduleManifest: manifest }),
    createAffectedTestPlan(changes, manifestOnlyGraph, manifest)
  )
}

describe('module impact shadow', () => {
  it('retains Linux sandbox certification when the PDF corpus test itself changes', () => {
    const plan = createAffectedTestPlan(
      [{ path: 'scripts/pdf-translation-corpus.test.ts', status: 'modified' }],
      manifestOnlyGraph,
      shadowModel()
    )
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toEqual(['scripts/pdf-translation-corpus.test.ts'])
    expect(plan.capabilityOverlays).toContain('notebook_network_sandbox')
    expect(requiredLanesForModulePlan(plan)).toContain('linux_runtime')
  })

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

    expect(report.resolved.reasonChains).toContain(
      'session_persistence -> project_lifecycle -> capability routing only'
    )
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
      modules: ['session_renderer']
    })
    expect(report.shadow.testFiles).toEqual([...report.shadow.testFiles].sort())
    expect(report.shadow.capabilityOverlays).toEqual([
      'e2e_delegation',
      'e2e_regressions',
      'renderer_state',
      'windows_sensitive'
    ])
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
      manifestOnlyGraph,
      shadowModel()
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
      modules: ['notebook_execution', 'notebook_network_sandbox'],
      fallbackCapabilities: ['main_runtime', 'notebook_network_sandbox'],
      capabilityOverlays: ['notebook_network_sandbox', 'windows_sensitive']
    })
    expect(report.shadow.testFiles).toEqual(
      expect.arrayContaining([
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
        'packages/notebook-network-sandbox/src/windows-appcontainer.test.ts',
        'packages/notebook-network-sandbox/src/local-service.test.ts',
        'src/main/notebook/local-service-lease.test.ts',
        'src/main/notebook/local-service.macos.integration.test.ts',
        'src/main/notebook/research-service.macos.integration.test.ts'
      ])
    )
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
        modules: ['i18n_catalog']
      })
      expect(report.shadow.testFiles).toEqual([
        'scripts/build-backend.integration.test.ts',
        'src/main/locale/owner.test.ts',
        'src/renderer/src/i18n/resources.test.ts'
      ])
      expect(report.shadow.fallbackCapabilities).toEqual(['shared_contract'])
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
    // This real static provider owner remains selective. The expanded artifact owner is
    // covered separately below and correctly reports unused graph evidence for full fallback.
    const authoritativePlan = classifyChanges([
      { path: 'src/main/settings/backend-resolver.ts', status: 'modified' }
    ])
    const execute = vi
      .fn()
      .mockReturnValue(Buffer.from('M\0src/main/settings/backend-resolver.ts\0'))
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

it('ignores legacy blanket PR deferral when emitting a risk-based plan', () => {
  const execute = vi.fn().mockReturnValue(Buffer.from('M\0package.json\0'))
  const append = vi.fn()
  const { plan } = runModuleImpactAuthorityCli(
    ['--base', '1'.repeat(40), '--head', '2'.repeat(40)],
    { EVENT_NAME: 'pull_request', PR_GATE_MERGE_QUEUE_ENABLED: 'true', GITHUB_OUTPUT: '/output' },
    { cwd: '/repo', execute, append }
  )
  expect(plan.mode).toBe('full')
  expect(plan.bundles).toContain('macos_e2e')
  expect(append).toHaveBeenCalledWith('/output', expect.not.stringContaining('stage='))
})

// Actual registrations retain full validation independently of the bounded mechanics above.
// These literal reasons deliberately fail if the reviewed classification explanation changes.
describe('production module shadow contracts', () => {
  it.each([
    {
      module: 'project_lifecycle',
      path: 'src/main/projects/deletion-coordinator.ts',
      reason:
        'The project_lifecycle owner retains 17 explicit research consumer obligations beyond its reviewed source-derived edges, including session-research-membership-migration.test.ts, research-reproduction.integration.test.ts, managed-execution-entrypoints.integration.test.ts. 17 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    },
    {
      module: 'session_persistence',
      path: 'src/main/session-persistence/coordinator.ts',
      reason:
        'Research membership and local or managed session creation extend persistence across runtime admission, package restoration and lifecycle recovery; validate the expanded persisted session boundary in full.'
    },
    {
      module: 'session_renderer',
      path: 'src/renderer/src/stores/session-store.ts',
      reason:
        'The session_renderer owner retains 2 explicit research consumer obligations beyond its reviewed source-derived edges, including index-fatal-errors.test.ts, index-startup-failure.test.ts. 2 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full renderer_view validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    },
    {
      module: 'artifact_storage',
      path: 'src/main/artifacts/repository.ts',
      reason:
        'The artifact_storage owner retains 1 explicit research consumer obligation beyond its reviewed source-derived edges, including run-observation-external-port.test.ts. 1 consumer cone has opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    },
    {
      module: 'notebook_execution',
      path: 'src/main/notebook/shell-process.ts',
      reason:
        'Removing the shell search preflight changes the trusted source boundary; retain full validation until the reduced boundary is reviewed and trusted.'
    },
    {
      module: 'notebook_network_sandbox',
      path: 'packages/notebook-network-sandbox/src/config.ts',
      reason:
        'Managed execution adds local-service and confinement gateways to the reviewed sandbox sources and a Notebook execution consumer edge; validate the expanded native, worker and host boundary in full.'
    },
    {
      module: 'i18n_main_adapter',
      path: 'src/main/locale/resources.ts',
      reason:
        'The i18n_main_adapter owner retains 21 explicit research consumer obligations beyond its reviewed source-derived edges, including research-reproduction.integration.test.ts, managed-auxiliary-output.test.ts, managed-execution-output.test.ts. 18 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    }
  ])(
    'keeps the actual $module owner fully validated with its exact reason',
    ({ module, path, reason }) => {
      const manifest = loadModuleImpactManifest()
      expect(manifest.modules[module].ownerPaths).toContain(path)
      expect(manifest.modules[module].fullTestReason).toBe(reason)
      const changes = [{ path, status: 'modified' }]
      const report = createModuleImpactShadowReport(
        classifyChanges(changes),
        createAffectedTestPlan(changes, manifestOnlyGraph)
      )
      expect(report.authoritative.mode).toBe('selective')
      expect(report.shadow.mode).toBe('full')
      expect(report.resolved.mode).toBe('full')
      expect(report.shadow.reasonChains).toContain(`${module} -> ${reason} -> full`)
      expect(report.comparison.requiredLanes).toEqual(changeImpactManifest.laneOrder)
      expect(report.resolved.lanes).toEqual(changeImpactManifest.laneOrder)
      expect(report.resolved.lanes).toEqual(
        expect.arrayContaining([
          'unit_macos',
          'linux_runtime',
          'windows_runtime',
          'windows_path',
          'e2e_functional_windows',
          'e2e_workspace_windows'
        ])
      )
    }
  )

  it('retains full production validation for the PDF corpus shared consumer evidence', () => {
    const plan = createAffectedTestPlan(
      [{ path: 'scripts/pdf-translation-corpus.test.ts', status: 'modified' }],
      manifestOnlyGraph
    )
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains).toEqual([expect.stringContaining(' -> full')])
    expect(requiredLanesForModulePlan(plan)).toEqual(changeImpactManifest.laneOrder)
  })

  it.each(['pull_request', 'merge_group'])(
    'keeps the real artifact authority CLI full with blocking platform lanes for %s',
    (event) => {
      const execute = vi.fn().mockReturnValue(Buffer.from('M\0src/main/artifacts/repository.ts\0'))
      const { plan, report } = runModuleImpactAuthorityCli(
        ['--base', '1'.repeat(40), '--head', '2'.repeat(40)],
        { EVENT_NAME: event },
        { cwd: '/repo', execute, write: vi.fn() }
      )
      expect(plan.mode).toBe('full')
      expect(plan.lanes).toEqual(changeImpactManifest.laneOrder)
      expect(report.shadow.graphStatus).toBe('not-used')
      expect(report.shadow.reasonChains).toContain(
        'artifact_storage -> The artifact_storage owner retains 1 explicit research consumer obligation beyond its reviewed source-derived edges, including run-observation-external-port.test.ts. 1 consumer cone has opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes. -> full'
      )
      expect(execute).not.toHaveBeenCalledWith('codegraph', expect.anything(), expect.anything())
    }
  )
})
