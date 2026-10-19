import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { createPackageTestPlan, validatePackageTestRegistry } from './package-test-impact.mjs'

import {
  collectCodeGraphTests,
  createAffectedTestPlan,
  createModuleTestPlan,
  executeModuleTestPlan,
  formatModuleTestPlan,
  runModuleTestCli
} from './module-test-impact.mjs'

type NpmInvocation = (command: string, args: string[], options: object) => { status: number }

// Selection assertions inspect the same logical npm invocation for either transport.
function captureNpmInvocation(): {
  spawn: NpmInvocation
  invocation: ReturnType<typeof vi.fn<NpmInvocation>>
} {
  const invocation = vi.fn<NpmInvocation>(() => ({ status: 0 }))
  const spawn: NpmInvocation = (command, args, options) => {
    const script = args.indexOf('test:module:arguments')
    if (script !== -1) {
      const restored = JSON.parse(readFileSync(args[script + 2], 'utf8')) as string[]
      args = [...args.slice(0, script - 1), 'test', '--', ...restored.slice(1)]
    }
    return invocation(command, args, options)
  }
  return { spawn, invocation }
}

const currentStatus = JSON.stringify({
  initialized: true,
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  worktreeMismatch: null,
  index: { state: 'complete', reindexRecommended: false }
})

describe('module test impact commands', () => {
  it.each(['added', 'modified', 'deleted'])(
    'selects regression suites for an unregistered %s fixture',
    (status) => {
      const plan = createAffectedTestPlan(
        [{ path: 'test/fixtures/pdf-translation/new-regression-case.jsonl', status }],
        { status: 'unavailable-manifest-only', testFiles: [] }
      )
      expect(plan.mode).toBe('selective')
      expect(plan.modules).toEqual([])
      expect(plan.capabilityOverlays).toEqual([])
      expect(plan.testFiles).toEqual(
        expect.arrayContaining([
          'packages/pdf-translation/test/writer.test.ts',
          'src/main/literature/pdf-translation/api-target.test.ts',
          'packages/pdf-translation/test/reader/pdf-translation-extraction.test.ts',
          'packages/pdf-translation/test/recovery.test.ts',
          'test/pdf-translation-native-verification.test.ts'
        ])
      )
      expect(plan.testFiles).not.toContain('src/main/windows.test.ts')
    }
  )

  it('unions fixture suites for renames and mixed changes without weakening global boundaries', () => {
    const graph = { status: 'unavailable-manifest-only', testFiles: [] }
    const fixture = { path: 'test/fixtures/nbformat.v4.5.schema.json', status: 'modified' }
    const source = { path: 'src/main/notebook/ipynb-export.ts', status: 'modified' }
    const sourcePlan = createAffectedTestPlan([source], graph)
    const mixed = createAffectedTestPlan([source, fixture], graph)
    expect(mixed.mode).toBe(sourcePlan.mode)
    expect(mixed.testFiles).toEqual(expect.arrayContaining(sourcePlan.testFiles))
    const packageFixture = createAffectedTestPlan(
      [
        { path: 'src/main/literature/pdf-translation/api-target.ts', status: 'modified' },
        { path: 'test/fixtures/pdf-translation/new-regression-case.jsonl', status: 'modified' }
      ],
      graph
    )
    expect(packageFixture.testFiles).toContain(
      'packages/pdf-translation/test/reader/pdf-translation-extraction.test.ts'
    )
    const renamed = createAffectedTestPlan(
      [
        {
          ...fixture,
          status: 'renamed',
          previousPath: 'test/fixtures/reviewer-model-evaluation.json'
        }
      ],
      graph
    )
    expect(renamed.mode).toBe('selective')
    expect(renamed.testFiles).toEqual([
      'scripts/reviewer-model-evaluation.test.mjs',
      'src/main/notebook/ipynb-export.test.ts'
    ])
    for (const change of [
      { path: 'package.json', status: 'modified' },
      { path: 'test/fixtures/unknown-domain/new.json', status: 'added' },
      { path: 'test/fixtures/pdf-translation/helper.ts', status: 'added' },
      { ...fixture, status: 'type-changed' },
      { ...fixture, status: 'renamed', previousPath: 'src/main/removed.ts' }
    ])
      expect(createAffectedTestPlan([fixture, change], graph).mode).toBe('full')
  })

  it('collects an empty shard report without discovering the full suite for an empty selection', () => {
    const plan = createAffectedTestPlan([], { status: 'unavailable-manifest-only', testFiles: [] })
    const { spawn, invocation } = captureNpmInvocation()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const testArguments = ['--shard=1/3', '--reporter=blob', '--outputFile=reports/blob-1.json']
    try {
      expect(plan.testFiles).toEqual([])
      executeModuleTestPlan(plan, {
        spawn,
        testArguments,
        environment: { npm_execpath: '/npm/bin/npm-cli.js' },
        nodeExecutable: '/node'
      })
      expect(invocation).toHaveBeenCalledWith(
        '/node',
        ['/npm/bin/npm-cli.js', 'test', '--', ...testArguments, '__no_selected_module_tests__'],
        expect.anything()
      )
      invocation.mockClear()
      // Ordinary local invocations still do no work for an empty selection. Pass a controlled
      // environment: under CI the job exports OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS, and an
      // ambient non-empty selection would make the plan spawn despite the empty module list.
      executeModuleTestPlan(plan, { spawn, environment: {} })
      expect(invocation).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it.each(['package.json', 'src/shared/unregistered.ts'])(
    'blocks unexpected full execution for %s in an explicitly selective job',
    async (source) => {
      const { spawn, invocation } = captureNpmInvocation()
      const options = {
        execute: (command: string, args: string[]) => {
          if (command === 'git' && args[0] === 'merge-base') return 'base\n'
          if (command === 'git' && args[0] === 'diff') return Buffer.from(`M\0${source}\0`)
          throw new Error('CodeGraph unavailable in CI')
        },
        spawn,
        environment: { npm_execpath: '/npm/bin/npm-cli.js' }
      }
      const args = ['affected', '--base', 'base', '--head', 'head']
      await expect(runModuleTestCli([...args, '--require-selective'], options)).rejects.toThrow(
        'Selective test plan required; refusing full execution.'
      )
      expect(invocation).not.toHaveBeenCalled()
      // Local and explicit full callers retain the existing fallback.
      expect(await runModuleTestCli(args, options)).toBe(0)
      expect(invocation).toHaveBeenCalledOnce()
    }
  )

  it.each([1, null])('preserves failed or interrupted selective test status %s', (status) => {
    const spawn = vi.fn(() => ({ status }))
    expect(
      executeModuleTestPlan(createModuleTestPlan('artifact_storage'), {
        spawn,
        environment: { npm_execpath: '/npm/bin/npm-cli.js' }
      })
    ).toBe(1)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it.each([
    ['--shard=2/3', '--reporter=blob', '--outputFile=vitest-reports/blob-2.json'],
    ['--merge-reports=vitest-reports', '--passWithNoTests']
  ])(
    'preserves module selection and changed coverage when forwarding %j',
    async (...vitestArguments) => {
      const { spawn, invocation } = captureNpmInvocation()
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const source = 'src/main/notebook/mcp-server.ts'
      const plan = createAffectedTestPlan([{ path: source, status: 'modified' }], {
        status: 'unavailable-manifest-only',
        testFiles: []
      })
      try {
        await runModuleTestCli(
          [
            'affected',
            '--base',
            'base',
            '--head',
            'head',
            '--coverage-changed',
            'base',
            '--require-selective',
            '--',
            ...vitestArguments
          ],
          {
            execute: (command: string, args: string[]) => {
              if (command === 'git' && args[0] === 'merge-base') return 'base\n'
              if (command === 'git' && args[0] === 'diff') return Buffer.from(`M\0${source}\0`)
              throw new Error('CodeGraph unavailable in CI')
            },
            spawn,
            environment: { npm_execpath: '/npm/bin/npm-cli.js' }
          }
        )
        const merging = vitestArguments[0].startsWith('--merge-reports')
        expect(invocation.mock.calls[0]?.[1]).toEqual([
          '/npm/bin/npm-cli.js',
          ...(merging ? ['exec', '--', 'vitest', 'run'] : ['test', '--']),
          '--coverage',
          `--coverage.include=${source}`,
          ...vitestArguments,
          ...(merging ? [] : plan.testFiles)
        ])
        expect(invocation.mock.calls[0]?.[2]?.env).toMatchObject({
          VITEST_CHANGED_COVERAGE_THRESHOLDS: '1'
        })
      } finally {
        write.mockRestore()
      }
    }
  )

  it('selects the standalone workflow contract instead of the global fallback', () => {
    const plan = createAffectedTestPlan(
      [{ path: 'scripts/ci/pr-gate-workflow.test.ts', status: 'modified' }],
      { status: 'unavailable-manifest-only', testFiles: [] }
    )
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toEqual(['scripts/ci/pr-gate-workflow.test.ts'])
    expect(plan.capabilityOverlays).toEqual([])
    expect(plan.fallbackCapabilities).toEqual([])
  })

  it('builds a deterministic declared-test plan for one module', () => {
    const plan = createModuleTestPlan('artifact_storage')

    expect(plan.mode).toBe('selective')
    expect(plan.modules).toEqual(['artifact_storage'])
    expect(plan.testFiles).toEqual([...plan.testFiles].sort())
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/artifacts/repository.test.ts',
        'src/main/artifacts/ipc.test.ts',
        'src/main/artifacts/provenance-repository.test.ts'
      ])
    )
    expect(() => createModuleTestPlan('unknown_module')).toThrow('Unknown module: unknown_module')
  })

  it('builds the Compute service contract and fallback plan', () => {
    const plan = createModuleTestPlan('compute_service')

    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts',
        'src/main/compute/compute-service.test.ts',
        'src/main/compute/connection-broker.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts'
      ])
    )
    expect(plan.capabilityOverlays).toEqual([
      'e2e_delegation',
      'e2e_regressions',
      'windows_sensitive'
    ])
    expect(plan.fallbackCapabilities).toEqual(['main_runtime'])

    const affected = createAffectedTestPlan(
      [{ path: 'src/main/compute/dispatch-evidence.ts', status: 'added' }],
      { status: 'current', testFiles: [] }
    )
    expect(affected.modules).toEqual(['compute_service', 'workspace_page'])
    expect(affected.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/concurrency-integration.test.ts'
      ])
    )
  })

  it.each([
    'packages/compute/src/compute-job-lifecycle.ts',
    'packages/compute/src/job-deletion-owner.ts',
    'src/main/compute/job-repository.ts',
    'packages/compute/src/concurrency-manager.ts',
    'packages/compute/src/job-dispatcher.ts',
    'packages/compute/src/job-poller.ts'
  ])('routes Compute lifecycle changes through its complete certification set for %s', (path) => {
    const affected = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'current',
      testFiles: []
    })

    expect(affected.mode).toBe('selective')
    expect(affected.modules).toEqual(
      path.startsWith('packages/')
        ? ['compute_package', 'compute_service', 'workspace_page']
        : ['compute_service', 'workspace_page']
    )
    if (path.startsWith('packages/'))
      expect(affected.testFiles).toEqual(
        expect.arrayContaining([
          'packages/compute/src/concurrency-manager.test.ts',
          'packages/compute/src/job-deletion-owner.test.ts'
        ])
      )
    else
      expect(affected.testFiles.filter((file) => file.startsWith('packages/compute/'))).toEqual([])
    expect(affected.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-service.architecture.test.ts',
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts',
        'src/main/compute/concurrency-integration.test.ts',
        'src/main/compute/job-dispatcher.test.ts',
        'src/main/compute/job-poller.test.ts',
        'src/main/compute/compute-jobs.integration.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/compute/application-commands.test.ts',
        'src/main/notebook/local-rpc-server.test.ts'
      ])
    )
  })

  it('expands User Skill repository changes through Settings and cross-surface consumers', () => {
    const manifest = loadModuleImpactManifest()
    const packageTests = manifest.modules.skill_package.testFiles.owner
    expect(packageTests.length).toBeGreaterThan(0)
    const registry = validatePackageTestRegistry(
      JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
    )
    // Check local module plans too: CI's package exclusions must not hide stale host evidence.
    // A primitive package may legitimately register Skills as its downstream consumer.
    for (const [id, module] of Object.entries(manifest.modules)) {
      const packagePaths = module.ownerPaths.filter((path) =>
        registry.packages.some((entry) => path.startsWith(entry.root + '/'))
      )
      if (createPackageTestPlan(packagePaths, registry).selected.includes('packages/skills'))
        continue
      expect(
        Object.values(module.testFiles)
          .flat()
          .filter((path) => path.startsWith('packages/skills/')),
        `${id} must not register unchanged upstream Skill package units`
      ).toEqual([])
    }
    for (const path of [
      'src/main/skills/catalog.ts',
      'src/main/skill-marketplace/service.ts',
      'src/renderer/src/pages/settings/SkillEditor.tsx',
      'src/main/compute/skill-provisioning.ts'
    ]) {
      const hostPlan = createAffectedTestPlan([{ path, status: 'modified' }], {
        status: 'unavailable-manifest-only',
        testFiles: []
      })
      expect(hostPlan.mode, path).toBe('selective')
      expect(
        hostPlan.testFiles.some((file) => file.startsWith('packages/skills/')),
        path
      ).toBe(false)
    }
    const direct = createModuleTestPlan('user_skills_repository')
    expect(direct.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/skills/user-skill-repository.architecture.test.ts',
        'src/main/skills/host-skills-service.test.ts',
        'src/main/skills/conversation-import.test.ts',
        'src/main/notebook/local-rpc-server.test.ts',
        'src/main/notebook/local-rpc-server.skill-import.test.ts',
        'src/main/notebook/local-rpc-server.skills.test.ts',
        'src/main/skills/catalog.test.ts',
        'src/main/settings/service.test.ts',
        'src/main/specialist/package/release-certification.test.ts',
        'src/main/specialist/package/service.test.ts',
        'src/preload/index.test.ts',
        'src/renderer/src/pages/settings/SkillsPanel.render.test.tsx',
        'src/renderer/src/stores/settings-skills-slice.test.ts'
      ])
    )

    for (const { path, status } of [
      { path: 'packages/skills/src/user-skill-catalog-observer.ts', status: 'modified' },
      { path: 'packages/skills/src/user-skill-compatibility-index.ts', status: 'added' },
      { path: 'src/main/skills/user-skill-repository.ts', status: 'modified' },
      { path: 'packages/skills/src/user-skill-store.ts', status: 'modified' },
      { path: 'packages/skills/src/agent-home-skill-owner.ts', status: 'added' },
      { path: 'packages/skills/src/skill-bundle-import-owner.ts', status: 'modified' },
      { path: 'packages/skills/src/user-skill-import-contracts.ts', status: 'added' },
      { path: 'packages/skills/src/skill-mutation-owner.ts', status: 'modified' },
      { path: 'packages/skills/src/skill-package-transaction-owner.ts', status: 'modified' }
    ] as const) {
      const affected = createAffectedTestPlan([{ path, status }], {
        status: 'current',
        testFiles: []
      })
      const prefix = path.startsWith('packages/skills/') ? 'skill_package -> ' : ''
      expect([...affected.modules].sort()).toEqual([
        ...(prefix ? ['settings_operations'] : []),
        'settings_service_facade',
        ...(prefix ? ['skill_marketplace', 'skill_package'] : []),
        'user_skills_repository',
        'workspace_page',
        'workspace_runtime'
      ])
      expect(affected.reasonChains).toEqual(
        expect.arrayContaining([
          `${prefix}user_skills_repository -> settings_service_facade`,
          `${prefix}user_skills_repository -> settings_service_facade -> workspace_runtime`,
          `${prefix}user_skills_repository -> settings_service_facade -> workspace_runtime -> workspace_page`
        ])
      )
      expect(
        affected.testFiles.filter((file) => file.startsWith('packages/skills/')).sort()
      ).toEqual(prefix ? [...packageTests].sort() : [])
      if (prefix) {
        expect(affected.reasonChains).toEqual(
          expect.arrayContaining([
            'skill_package -> skill_marketplace',
            'skill_package -> skill_marketplace -> settings_operations'
          ])
        )
        expect(affected.testFiles).toEqual(
          expect.arrayContaining([
            'src/main/skill-marketplace/installation.test.ts',
            'src/main/skill-marketplace/service.test.ts',
            'src/main/settings/workflows.test.ts'
          ])
        )
      }
      expect(affected.testFiles).not.toContain('packages/open-science/cli.test.ts')
      expect(affected.testFiles).not.toContain('packages/open-science/client.test.ts')
      expect(affected.testFiles).toEqual(
        expect.arrayContaining([
          'src/main/acp/task-agent-port.test.ts',
          'src/main/notebook/local-rpc-notebook-adapter.test.ts',
          'src/main/notebook/local-rpc-server.mcpcall.test.ts',
          'src/main/notebook/local-rpc-server.skill-import.test.ts',
          'src/main/notebook/local-rpc-server.skills.test.ts',
          'src/main/notebook/mcp-server.test.ts',
          'src/main/settings/ipc.test.ts',
          'src/main/web-service/http-server.test.ts',
          'src/preload/electron-renderer-contract-adapter.test.ts',
          'src/preload/index.test.ts',
          'src/renderer/src/pages/settings/SkillsPanel.render.test.tsx',
          'src/renderer/src/stores/settings-skills-slice.test.ts',
          'src/renderer/src/stores/settings-store.test.ts',
          'src/renderer/web/api-installer.test.ts',
          'src/shared/renderer-surface-inventory.test.ts',
          'src/shared/renderer-surface-matrix.test.ts',
          'src/shared/web-rpc-contract.test.ts'
        ])
      )
    }
  })

  it('expands changed owners through consumer modules and graph candidates', () => {
    const plan = createAffectedTestPlan(
      [{ path: 'src/main/artifacts/repository.ts', status: 'modified' }],
      { status: 'current', testFiles: ['src/main/reviewer/ipc.test.ts'] }
    )

    expect(plan.mode).toBe('selective')
    expect(plan.modules).toEqual([
      'artifact_provenance',
      'artifact_storage',
      'project_lifecycle',
      'session_persistence'
    ])
    expect(plan.testFiles).toContain('src/main/reviewer/ipc.test.ts')
    expect(plan.reasonChains).toContain('artifact_storage -> artifact_provenance')
  })

  it.each(['src/main/reviewer/reviewer-session-driver.ts'])(
    'expands Reviewer changes through downstream consumers for %s',
    (path) => {
      const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
        status: 'current',
        testFiles: []
      })

      expect([...plan.modules].sort()).toEqual([
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'session_replay',
        'workspace_page',
        'workspace_runtime'
      ])
      expect(plan.reasonChains).toEqual(
        expect.arrayContaining([
          'reviewer_orchestrator -> session_replay',
          'reviewer_orchestrator -> workspace_runtime',
          'reviewer_orchestrator -> workspace_page',
          'reviewer_orchestrator -> artifact_provenance',
          'reviewer_orchestrator -> artifact_provenance -> session_persistence'
        ])
      )
      expect(plan.testFiles).toEqual(
        expect.arrayContaining([
          'src/main/artifacts/provenance-repository.architecture.test.ts',
          'src/main/session-persistence/coordinator.architecture.test.ts',
          'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.architecture.test.ts',
          'src/renderer/src/pages/workspace/workspace-page.architecture.test.ts'
        ])
      )
    }
  )

  it.each([
    [
      'src/main/settings/repository.ts',
      [
        'artifact_provenance',
        'compute_service',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_provider_accounts',
        'settings_repository',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/compute-grant-port.ts',
      [
        'artifact_provenance',
        'compute_service',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_provider_accounts',
        'settings_repository',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/provider-accounts.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_provider_accounts',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/responses-to-chat-completions-bridge.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'packages/providers/src/responses/request.ts',
      [
        'acp_runtime',
        'artifact_provenance',
        'compute_service',
        'desktop_composition',
        'host_command_runtime',
        'main_agent_framework',
        'main_pdf_translation',
        'main_session_details',
        'main_web_service',
        'project_lifecycle',
        'provider_credentials',
        'provider_transport',
        'providers_package',
        'renderer_acp',
        'renderer_model_selection',
        'renderer_settings_state',
        'reviewer_orchestrator',
        'reviewer_tool_contracts',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_model_owners',
        'settings_model_presentation',
        'settings_operations',
        'settings_page_composition',
        'settings_presentation_primitives',
        'settings_provider_accounts',
        'settings_provider_resolution',
        'settings_record_contracts',
        'settings_repository',
        'settings_service_facade',
        'shared_application_contracts',
        'shared_conversation_contracts',
        'web_renderer_bridge',
        'workspace_conversation',
        'workspace_page',
        'workspace_previews',
        'workspace_runtime',
        'workspace_shell'
      ]
    ],
    [
      'packages/providers/src/responses/response.ts',
      [
        'acp_runtime',
        'artifact_provenance',
        'compute_service',
        'desktop_composition',
        'host_command_runtime',
        'main_agent_framework',
        'main_pdf_translation',
        'main_session_details',
        'main_web_service',
        'project_lifecycle',
        'provider_credentials',
        'provider_transport',
        'providers_package',
        'renderer_acp',
        'renderer_model_selection',
        'renderer_settings_state',
        'reviewer_orchestrator',
        'reviewer_tool_contracts',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_model_owners',
        'settings_model_presentation',
        'settings_operations',
        'settings_page_composition',
        'settings_presentation_primitives',
        'settings_provider_accounts',
        'settings_provider_resolution',
        'settings_record_contracts',
        'settings_repository',
        'settings_service_facade',
        'shared_application_contracts',
        'shared_conversation_contracts',
        'web_renderer_bridge',
        'workspace_conversation',
        'workspace_page',
        'workspace_previews',
        'workspace_runtime',
        'workspace_shell'
      ]
    ],
    [
      'packages/providers/src/responses/types.ts',
      [
        'acp_runtime',
        'artifact_provenance',
        'compute_service',
        'desktop_composition',
        'host_command_runtime',
        'main_agent_framework',
        'main_pdf_translation',
        'main_session_details',
        'main_web_service',
        'project_lifecycle',
        'provider_credentials',
        'provider_transport',
        'providers_package',
        'renderer_acp',
        'renderer_model_selection',
        'renderer_settings_state',
        'reviewer_orchestrator',
        'reviewer_tool_contracts',
        'session_persistence',
        'session_replay',
        'settings_backend_resolution',
        'settings_model_owners',
        'settings_model_presentation',
        'settings_operations',
        'settings_page_composition',
        'settings_presentation_primitives',
        'settings_provider_accounts',
        'settings_provider_resolution',
        'settings_record_contracts',
        'settings_repository',
        'settings_service_facade',
        'shared_application_contracts',
        'shared_conversation_contracts',
        'web_renderer_bridge',
        'workspace_conversation',
        'workspace_page',
        'workspace_previews',
        'workspace_runtime',
        'workspace_shell'
      ]
    ],
    [
      'src/main/settings/service.ts',
      ['settings_service_facade', 'workspace_page', 'workspace_runtime']
    ]
  ])('expands Settings ownership through real consumers for %s', (path, expectedModules) => {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'current',
      testFiles: []
    })

    expect(plan.mode).toBe('selective')
    expect([...plan.modules].sort()).toEqual(expectedModules)
    const rootModule = path.startsWith('packages/providers/')
      ? 'providers_package'
      : path === 'src/main/settings/repository.ts' ||
          path === 'src/main/settings/compute-grant-port.ts'
        ? 'settings_repository'
        : path === 'src/main/settings/provider-accounts.ts'
          ? 'settings_provider_accounts'
          : path === 'src/main/settings/responses-to-chat-completions-bridge.ts'
            ? 'settings_backend_resolution'
            : 'settings_service_facade'
    expect(plan.reasonChains).toEqual(
      expect.arrayContaining(
        rootModule === 'settings_service_facade'
          ? [
              'settings_service_facade -> workspace_runtime',
              'settings_service_facade -> workspace_runtime -> workspace_page'
            ]
          : [
              `${rootModule}${rootModule === 'settings_repository' ? ' -> settings_provider_accounts' : ''}${rootModule === 'settings_backend_resolution' ? '' : ' -> settings_backend_resolution'} -> reviewer_orchestrator`,
              `${rootModule} -> settings_service_facade -> workspace_runtime`
            ]
      )
    )
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'src/shared/renderer-surface-inventory.test.ts',
        'src/shared/renderer-surface-matrix.test.ts',
        'src/shared/web-rpc-contract.test.ts',
        'src/main/notebook/local-rpc-notebook-adapter.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/notebook/mcp-server.test.ts',
        'src/main/web-service/http-server.test.ts'
      ])
    )
  })

  it('fails closed for unknown and destructive changes', () => {
    expect(
      createAffectedTestPlan([{ path: 'src/main/unknown-owner.ts', status: 'added' }], {
        status: 'current',
        testFiles: []
      }).mode
    ).toBe('full')
    expect(
      createAffectedTestPlan([{ path: 'src/main/artifacts/repository.ts', status: 'deleted' }], {
        status: 'current',
        testFiles: []
      }).mode
    ).toBe('full')
  })

  it('uses a current CodeGraph index and filters non-Vitest candidates', () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(currentStatus)
      .mockReturnValueOnce(
        JSON.stringify({
          affectedTests: [
            'src/main/artifacts/repository.test.ts',
            'e2e/certification/artifact-provenance.spec.ts',
            '../outside.test.ts',
            'src/main/artifacts/repository.ts'
          ]
        })
      )

    const graph = collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
      cwd: '/repo',
      execute,
      pathExists: () => true
    })

    expect(graph).toEqual({
      status: 'current',
      testFiles: ['src/main/artifacts/repository.test.ts']
    })
    expect(execute).toHaveBeenLastCalledWith(
      'codegraph',
      ['affected', '--json', '--depth', '2', 'src/main/artifacts/repository.ts'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('falls back deterministically to the manifest for stale or unavailable CodeGraph', () => {
    const mismatch = JSON.stringify({
      ...JSON.parse(currentStatus),
      worktreeMismatch: { worktreeRoot: '/worktree', indexRoot: '/repo' }
    })
    expect(
      collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
        execute: () => mismatch
      })
    ).toEqual({
      status: 'unavailable-manifest-only',
      reason: 'worktree index mismatch',
      testFiles: []
    })

    expect(
      collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
        execute: () => {
          throw new Error('spawn codegraph ENOENT')
        }
      })
    ).toEqual({
      status: 'unavailable-manifest-only',
      reason: 'spawn codegraph ENOENT',
      testFiles: []
    })
  })

  it.each(['win32', 'darwin', 'linux'])(
    'transports large selections without dropping filters or options on %s',
    (platform) => {
      const plan = createModuleTestPlan('upload_repository')
      plan.testFiles = Array.from(
        { length: 2200 },
        (_, index) => `src/renderer/src/components/long-consumer-${index}.test.ts`
      )
      plan.deferredPackageRoots = ['packages/compute']
      plan.testFiles.push('packages/compute/deferred.test.ts')
      const testArguments = [
        '--shard=1/3',
        '--coverage',
        '--coverage.include=src/shared/pdf-text.ts'
      ]
      let argumentFile = ''
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        const spawn = vi.fn((_command: string, args: string[]) => {
          expect(args.slice(0, 4)).toEqual([
            '/npm/bin/npm-cli.js',
            'run',
            'test:module:arguments',
            '--'
          ])
          expect(JSON.stringify(args).length).toBeLessThan(6000)
          argumentFile = args[4]
          expect(JSON.parse(readFileSync(argumentFile, 'utf8'))).toEqual([
            'run',
            ...testArguments,
            '--exclude=packages/compute/**',
            ...plan.testFiles.filter((file) => !file.startsWith('packages/compute/')).sort()
          ])
          return { status: 7 }
        })
        expect(
          executeModuleTestPlan(plan, {
            platform,
            spawn,
            environment: { npm_execpath: '/npm/bin/npm-cli.js' },
            testArguments
          })
        ).toBe(7)
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(existsSync(argumentFile)).toBe(false)
        expect(existsSync(resolve(argumentFile, '..'))).toBe(false)
      } finally {
        write.mockRestore()
      }
    }
  )

  it.each(['return', 'throw'])('cleans temporary arguments when spawn errors %s', (failure) => {
    const plan = createModuleTestPlan('upload_repository')
    plan.testFiles = ['x'.repeat(10000) + '.test.ts']
    let argumentFile = ''
    const error = new Error('spawn failed')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(() =>
        executeModuleTestPlan(plan, {
          environment: {},
          platform: 'linux',
          spawn: (_command: string, args: string[]) => {
            argumentFile = args[3]
            expect(existsSync(argumentFile)).toBe(true)
            if (failure === 'throw') throw error
            return { error }
          }
        })
      ).toThrow(error)
      expect(existsSync(resolve(argumentFile, '..'))).toBe(false)
    } finally {
      write.mockRestore()
    }
  })

  it.each([
    ['passes', 0],
    ['fails', 1]
  ] as const)(
    'runs the real Vitest CLI from a large argument file when a selected test %s',
    (name, status) => {
      const directory = mkdtempSync(resolve(tmpdir(), 'vitest-argument-test-'))
      try {
        const config = resolve(directory, 'vitest.config.mjs')
        writeFileSync(config, 'export default { test: { globals: true } }')
        writeFileSync(
          resolve(directory, 'selected file.test.js'),
          "it('passes', () => expect(1).toBe(1)); it('fails', () => expect(1).toBe(2))"
        )
        writeFileSync(
          resolve(directory, 'excluded.test.js'),
          "throw new Error('excluded file ran')"
        )
        const argumentFile = resolve(directory, 'arguments.json')
        writeFileSync(
          argumentFile,
          JSON.stringify([
            'run',
            '--config',
            config,
            '--root',
            directory,
            '--testNamePattern',
            name,
            '--exclude=**/excluded.test.js',
            directory,
            ...Array.from(
              { length: 2200 },
              (_, index) => `never-selected/long-consumer-${index}.test.ts`
            )
          ])
        )
        const result = spawnSync(
          process.execPath,
          ['scripts/ci/run-vitest-arguments.mjs', argumentFile],
          {
            encoding: 'utf8',
            timeout: 30000
          }
        )
        expect(result.error).toBeUndefined()
        expect(result.status, result.stdout + result.stderr).toBe(status)
        expect(result.stdout + result.stderr).not.toContain('excluded file ran')
        expect(result.stdout).toContain('1 skipped')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    40000
  )

  it.each([{}, [], ['watch'], ['run', null], ['run', 'bad\0argument']].map((value) => [value]))(
    'rejects malformed argument files before test discovery: %j',
    (value) => {
      const directory = mkdtempSync(resolve(tmpdir(), 'invalid-vitest-arguments-'))
      try {
        const argumentFile = resolve(directory, 'arguments.json')
        writeFileSync(argumentFile, JSON.stringify(value))
        const result = spawnSync(
          process.execPath,
          ['scripts/ci/run-vitest-arguments.mjs', argumentFile],
          {
            encoding: 'utf8'
          }
        )
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Expected a Vitest run argument array')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['npm_execpath', 'NPM_EXECPATH', 'Npm_ExecPath'])(
    'launches npm through Node with the Windows environment key %s',
    (key) => {
      const plan = createModuleTestPlan('upload_repository')
      const { spawn, invocation } = captureNpmInvocation()
      executeModuleTestPlan(plan, {
        platform: 'win32',
        environment: { [key]: '/npm/bin/npm-cli.js' },
        nodeExecutable: '/node',
        spawn
      })
      expect(invocation).toHaveBeenCalledWith(
        '/node',
        ['/npm/bin/npm-cli.js', 'test', '--', ...plan.testFiles],
        expect.anything()
      )
    }
  )

  it('prints the exact file list before invoking portable npm test arguments', () => {
    const plan = createModuleTestPlan('upload_repository')
    const { spawn, invocation } = captureNpmInvocation()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(
      executeModuleTestPlan(plan, {
        cwd: '/repo',
        spawn,
        environment: { npm_execpath: '/npm/bin/npm-cli.js' },
        nodeExecutable: '/node'
      })
    ).toBe(0)
    expect(write).toHaveBeenCalledWith(formatModuleTestPlan(plan))
    expect(invocation).toHaveBeenCalledWith(
      '/node',
      ['/npm/bin/npm-cli.js', 'test', '--', ...plan.testFiles],
      expect.objectContaining({ cwd: '/repo', stdio: 'inherit' })
    )
    expect(invocation.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      'VITEST_CHANGED_COVERAGE_THRESHOLDS'
    )
    write.mockRestore()
  })

  it('pins coverage to the PR diff when checkout contains newer main changes', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'module-coverage-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      git('init', '-q')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      git('commit', '--allow-empty', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      mkdirSync(resolve(cwd, 'src'), { recursive: true })
      writeFileSync(resolve(cwd, 'src/main-only.ts'), 'export const mainOnly = true\n')
      git('add', '.')
      git('commit', '-qm', 'main change')
      const main = git('rev-parse', 'HEAD')
      git('checkout', '--detach', base)
      mkdirSync(resolve(cwd, 'src/renderer/src/stores'), { recursive: true })
      const changed = 'src/renderer/src/stores/session-store-persistence-merge.ts'
      writeFileSync(resolve(cwd, changed), 'export const changed = true\n')
      git('add', '.')
      git('commit', '-qm', 'PR change')
      const head = git('rev-parse', 'HEAD')
      git('merge', '--no-edit', main)
      // Vitest coverage.changed compares with checkout HEAD, including this unrelated file.
      expect(git('diff', '--name-only', `${base}...HEAD`)).toContain('src/main-only.ts')
      const { spawn, invocation } = captureNpmInvocation()
      await runModuleTestCli(
        ['affected', '--base', base, '--head', head, '--coverage-changed', base],
        {
          cwd,
          execute: (command: string, args: string[]) => {
            if (command === 'codegraph') throw new Error('CodeGraph unavailable in CI')
            return execFileSync(command, args, { cwd, encoding: 'utf8' })
          },
          spawn,
          environment: { npm_execpath: '/npm/bin/npm-cli.js' }
        }
      )
      const args = invocation.mock.calls[0]?.[1]
      expect(args).toContain(`--coverage.include=${changed}`)
      expect(args).not.toContain('--coverage.changed')
      expect(args).not.toContain('--coverage.include=src/main-only.ts')
    } finally {
      write.mockRestore()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'deleted sources',
      diff: 'D\0src/renderer/src/stores/session-store-persistence-merge.ts\0',
      include: '__no_changed_sources__'
    },
    {
      name: 'renamed sources',
      diff: 'R100\0src/renderer/src/stores/session-store-persistence-merge.ts\0src/renderer/src/stores/renamed.ts\0',
      include: 'src/renderer/src/stores/renamed.ts'
    }
  ])('scopes coverage for $name', async ({ diff, include }) => {
    const { spawn, invocation } = captureNpmInvocation()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await runModuleTestCli(
        ['affected', '--base', 'base', '--head', 'head', '--coverage-changed', 'base'],
        {
          execute: (command: string, args: string[]) => {
            if (command === 'git' && args[0] === 'merge-base') return 'base\n'
            if (command === 'git' && args[0] === 'diff') return Buffer.from(diff)
            throw new Error('CodeGraph unavailable in CI')
          },
          spawn,
          environment: { npm_execpath: '/npm/bin/npm-cli.js' }
        }
      )
      expect(invocation.mock.calls[0]?.[1]).toContain(`--coverage.include=${include}`)
      expect(invocation.mock.calls[0]?.[1]).not.toContain('--coverage.changed')
    } finally {
      write.mockRestore()
    }
  })

  it.each(['same', 'different'])('keeps coverage pinned with a %s baseline', async (baseline) => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    const coverageBase = baseline === 'same' ? base : '3'.repeat(40)
    const execute = vi.fn((command: string, arguments_: string[]) => {
      if (command === 'git' && arguments_[0] === 'merge-base') return `${base}\n`
      if (command === 'git' && arguments_[0] === 'diff') {
        return Buffer.from('M\0src/main/artifacts/repository.ts\0')
      }
      if (command === 'codegraph' && arguments_[0] === 'status') return currentStatus
      if (command === 'codegraph' && arguments_[0] === 'affected') {
        return JSON.stringify({ affectedTests: [] })
      }
      throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`)
    })
    const { spawn, invocation } = captureNpmInvocation()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const environment = { npm_execpath: '/npm/bin/npm-cli.js' }
    const expectedPlan = createAffectedTestPlan(
      [{ path: 'src/main/artifacts/repository.ts', status: 'modified' }],
      { status: 'current', testFiles: [] }
    )

    expect(
      await runModuleTestCli(
        ['affected', '--base', base, '--head', head, '--coverage-changed', coverageBase],
        {
          cwd: '/repo',
          execute,
          spawn,
          environment,
          nodeExecutable: '/node'
        }
      )
    ).toBe(0)
    expect(invocation).toHaveBeenCalledWith(
      '/node',
      [
        '/npm/bin/npm-cli.js',
        'test',
        '--',
        '--coverage',
        '--coverage.include=src/main/artifacts/repository.ts',
        ...expectedPlan.testFiles
      ],
      expect.objectContaining({
        cwd: '/repo',
        env: {
          npm_execpath: '/npm/bin/npm-cli.js',
          VITEST_CHANGED_COVERAGE_THRESHOLDS: '1'
        },
        stdio: 'inherit'
      })
    )
    expect(execute).toHaveBeenCalledWith(
      'git',
      ['merge-base', coverageBase, head],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(invocation.mock.calls[0]?.[1]).toContain('src/main/reviewer/ipc.test.ts')
    expect(environment).toEqual({ npm_execpath: '/npm/bin/npm-cli.js' })
    write.mockRestore()
  })

  it('fails with an actionable error instead of spawning a Windows command shim', () => {
    const plan = createModuleTestPlan('artifact_storage')
    const spawn = vi.fn()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(() =>
      executeModuleTestPlan(plan, {
        spawn,
        environment: {},
        platform: 'win32'
      })
    ).toThrow('run this command through npm run test:module or npm run test:affected')
    expect(spawn).not.toHaveBeenCalled()
    write.mockRestore()
  })

  it('retains the PATH-based npm fallback for direct POSIX execution', () => {
    const plan = createModuleTestPlan('artifact_storage')
    const { spawn, invocation } = captureNpmInvocation()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(
      executeModuleTestPlan(plan, {
        cwd: '/repo',
        spawn,
        environment: {},
        platform: 'linux'
      })
    ).toBe(0)
    expect(invocation).toHaveBeenCalledWith(
      'npm',
      ['test', '--', ...plan.testFiles],
      expect.objectContaining({ cwd: '/repo', stdio: 'inherit' })
    )
    write.mockRestore()
  })

  it('keeps delegated-work behavior in the Session persistence Module plan', () => {
    expect(createModuleTestPlan('session_persistence').testFiles).toContain(
      'src/main/session-persistence/delegated-work-records.test.ts'
    )
  })

  it('keeps npm test as the complete portable suite', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

    expect(packageJson.scripts.test).toBe('vitest run')
    expect(packageJson.scripts['pretest:module:arguments']).toBe('npm run pretest')
    expect(packageJson.scripts['test:module:arguments']).toBe(
      'node scripts/ci/run-vitest-arguments.mjs'
    )
    expect(packageJson.scripts['test:module']).toContain('module-test-impact.mjs module')
    expect(packageJson.scripts['test:affected']).toContain('module-test-impact.mjs affected')
  })
})

it.each([
  'src/main/delegation/process-ownership.ts',
  'src/main/delegation/process-ownership.test.ts',
  'src/main/process-tree-windows.ts',
  'src/main/process-tree.windows.integration.test.ts'
])('selects process ownership and lifecycle tests with Windows coverage for %s', (path) => {
  const plan = createAffectedTestPlan([{ path, status: 'added' }], {
    status: 'unavailable-manifest-only',
    testFiles: []
  })

  expect(plan.mode).toBe('selective')
  expect(plan.modules).toContain(
    path.startsWith('src/main/delegation/') ? 'main_delegation' : 'host_process_runtime'
  )
  expect(plan.capabilityOverlays).toContain('windows_sensitive')
  if (path.endsWith('.test.ts')) {
    expect(plan.testFiles).toEqual([path])
    return
  }
  expect(plan.testFiles).toEqual(
    expect.arrayContaining([
      'src/main/delegation/process-ownership.test.ts',
      'src/main/process-tree.windows.integration.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts'
    ])
  )
})

it('uses only declared owner tests to recover colocated implementation ownership', () => {
  const manifest = loadModuleImpactManifest(resolve('scripts/ci/module-impact.json'))
  const graph = { status: 'unavailable-manifest-only', testFiles: [] }
  const module = manifest.modules.connector_builtins
  // Synthetic main-process path exercises owner inference independently of package routing.
  const source = 'src/main/connectors/descriptors/new-known-descriptor.ts'
  const test = source.replace('.ts', '.test.ts')
  const changes = [{ path: source, status: 'added' }]
  module.testFiles.consumer.push(test)
  expect(createAffectedTestPlan(changes, graph, manifest).mode).toBe('full')
  module.testFiles.consumer.pop()
  module.testFiles.owner.push(test)
  const plan = createAffectedTestPlan(changes, graph, manifest)
  expect(plan.mode).toBe('selective')
  expect(plan.modules).toContain('connector_builtins')
  expect(plan.testFiles).toContain(test)
  expect(
    createAffectedTestPlan(
      [{ path: source.replace('new-known', 'unknown'), status: 'added' }],
      graph,
      manifest
    ).mode
  ).toBe('full')
})

it.each([
  [
    'packages/connector-builtins/src/genomes-ensembl.ts',
    'packages/connector-builtins/src/genomes.test.ts'
  ],
  ['src/main/reviewer/correction.ts', 'src/main/reviewer/correction-owner.test.ts']
])('retains the direct owner/aggregate contract when %s changes', (path, testFile) => {
  const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
    status: 'unavailable-manifest-only',
    testFiles: []
  })
  expect(plan.mode).toBe('selective')
  expect(plan.testFiles).toContain(testFile)
})

it.each([
  'src/main/session-diagnostics/notebook.ts',
  'src/main/session-diagnostics/worker-entry.ts',
  'src/main/session-diagnostics/desktop.ts'
])('keeps Session export selective with storage, transport and UI contracts for %s', (path) => {
  const manifest = loadModuleImpactManifest(resolve('scripts/ci/module-impact.json'))
  const plan = createAffectedTestPlan(
    [{ path, status: 'modified' }],
    {
      status: 'unavailable-manifest-only',
      testFiles: []
    },
    manifest
  )
  expect(plan.mode).toBe('selective')
  expect(plan.modules).toEqual(['session_diagnostics'])
  expect(plan.testFiles).toEqual(
    expect.arrayContaining([
      ...Object.values(manifest.modules.session_diagnostics.testFiles).flat(),
      'src/main/session-diagnostics/desktop.test.ts',
      'src/main/session-diagnostics/collector.test.ts',
      'src/main/desktop-runtime-transport.integration.test.ts'
    ])
  )
  expect(plan.capabilityOverlays).toEqual(
    expect.arrayContaining(['e2e_regressions', 'windows_sensitive'])
  )
  expect(plan.testFiles.some((file) => file.startsWith('packages/connector-'))).toBe(false)
})

it.each([
  'packages/diagnostics/src/logger.ts',
  'packages/diagnostics/src/diagnostic-redaction.ts',
  'packages/diagnostics/src/node.ts',
  'packages/diagnostics/package.json'
])('retains full host validation for common diagnostic or build input %s', (path) => {
  const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
    status: 'unavailable-manifest-only',
    testFiles: []
  })
  expect(plan.mode).toBe('full')
})

describe('Notebook package module boundaries', () => {
  const manifest = loadModuleImpactManifest()
  const packageModules = [
    'notebook_syntax',
    'notebook_code_risk',
    'notebook_analysis',
    'notebook_analysis_engine'
  ]
  const packageRoots = [
    'packages/notebook-syntax/',
    'packages/notebook-code-risk/',
    'packages/notebook-analysis/'
  ]
  const packageTests = (tests: string[]): string[] =>
    tests.filter((path) => packageRoots.some((root) => path.startsWith(root)))
  const graph = { status: 'unavailable-manifest-only', testFiles: [] }

  it('never registers upstream Notebook unit tests as downstream host evidence', () => {
    for (const [id, module] of Object.entries(manifest.modules)) {
      if (packageModules.includes(id)) continue
      expect(packageTests(Object.values(module.testFiles).flat()), id).toEqual([])
      expect(
        module.consumerModules.filter((consumer) => packageModules.includes(consumer)),
        id
      ).toEqual([])
      if (!module.fullTestReason)
        expect(packageTests(createModuleTestPlan(id, manifest).testFiles), id).toEqual([])
    }
  })

  it('owns pure path and package-projection regressions inside analysis', () => {
    const units = [
      'input-path-analysis.test.ts',
      'input-resource-analysis.test.ts',
      'dependency-projection.r-packages.test.ts'
    ].map((name) => `packages/notebook-analysis/src/${name}`)
    expect(manifest.modules.notebook_analysis_engine.testFiles.owner).toEqual(
      expect.arrayContaining(units)
    )
    for (const module of Object.values(manifest.modules)) {
      expect(
        Object.values(module.testFiles)
          .flat()
          .filter((path) =>
            units.some(
              (unit) =>
                path === unit.replace('packages/notebook-analysis/src/', 'src/main/notebook/')
            )
          )
      ).toEqual([])
    }
    for (const path of [
      'src/main/notebook/runtime-service.ts',
      'src/main/notebook/dependency-analysis-adapter.ts',
      'src/main/notebook/scientific-output-analysis.ts'
    ]) {
      const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph, manifest)
      expect(plan.mode).toBe('selective')
      expect(packageTests(plan.testFiles)).toEqual([])
      expect(plan.testFiles).toContain('src/main/notebook/code-risk-admission.test.ts')
      expect(plan.testFiles).toContain(
        'src/main/notebook/working-file-observer.write-scope.integration.test.ts'
      )
    }
  })

  it.each([
    ['src/main/notebook/runtime-service.ts', 'src/main/notebook/runtime-service.test.ts'],
    [
      'src/main/notebook/dependency-analysis-adapter.ts',
      'src/main/notebook/dependency-analysis-adapter.test.ts'
    ],
    [
      'src/main/notebook/working-file-observer.ts',
      'src/main/notebook/working-file-observer.test.ts'
    ],
    ['src/main/storage/content-repository.ts', 'src/main/storage/content-repository.test.ts']
  ])('keeps host integrations without upstream package units for %s', (path, integration) => {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph, manifest)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toContain(integration)
    expect(packageTests(plan.testFiles)).toEqual([])
  })

  it.each([
    ['notebook_code_risk', 'packages/notebook-code-risk/src/index.ts', ['notebook_code_risk']],
    [
      'notebook_analysis_engine',
      'packages/notebook-analysis/src/dependency-analysis.ts',
      ['notebook_analysis_engine']
    ],
    [
      'notebook_syntax',
      'packages/notebook-syntax/src/index.ts',
      ['notebook_syntax', 'notebook_code_risk', 'notebook_analysis_engine']
    ]
  ])(
    'selects only downstream package suites and host integrations for %s',
    (id, path, selected) => {
      const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph, manifest)
      expect(plan.mode).toBe('selective')
      for (const candidate of packageModules) {
        const owned = manifest.modules[candidate].testFiles.owner
        if (candidate !== 'notebook_analysis') expect(owned.length).toBeGreaterThan(0)
        if (selected.includes(candidate))
          expect(plan.testFiles).toEqual(expect.arrayContaining(owned))
        else
          expect(
            plan.testFiles.filter((test) => owned.includes(test)),
            `${id} -> ${candidate}`
          ).toEqual([])
      }
      expect(plan.testFiles).toContain('src/main/notebook/runtime-service.test.ts')
      expect(plan.testFiles).toContain('src/main/notebook/code-risk-admission.test.ts')
    }
  )
})

it('separates analysis implementation consumers from broad shared contract consumers', () => {
  const manifest = loadModuleImpactManifest()
  const graph = { status: 'unavailable-manifest-only', testFiles: [] }
  const implementation = createAffectedTestPlan(
    [{ path: 'packages/notebook-analysis/src/dependency-analysis-python.ts', status: 'modified' }],
    graph,
    manifest
  )
  const contract = createAffectedTestPlan(
    [{ path: 'packages/notebook-analysis/src/contracts.ts', status: 'modified' }],
    graph,
    manifest
  )
  expect(implementation.modules).toContain('notebook_analysis_engine')
  expect(implementation.modules).not.toContain('notebook_analysis')
  expect(implementation.modules).not.toContain('session_persistence')
  expect(contract.modules).toEqual(
    expect.arrayContaining(['notebook_analysis', 'notebook_analysis_engine', 'session_persistence'])
  )
  expect(contract.testFiles).toEqual(expect.arrayContaining(implementation.testFiles))
  expect(implementation.testFiles).toContain('src/main/notebook/analysis-file-evidence.test.ts')
  expect(implementation.testFiles).toContain('src/main/notebook/serialized-file-provenance.test.ts')
})
