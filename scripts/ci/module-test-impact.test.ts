import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  collectCodeGraphTests,
  createAffectedTestPlan,
  createModuleTestPlan,
  executeModuleTestPlan,
  formatModuleTestPlan,
  runModuleTestCli
} from './module-test-impact.mjs'

const currentStatus = JSON.stringify({
  initialized: true,
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  worktreeMismatch: null,
  index: { state: 'complete', reindexRecommended: false }
})

describe('module test impact commands', () => {
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
        'src/main/compute/job-deletion-owner.test.ts',
        'src/main/compute/compute-service.test.ts',
        'src/main/compute/ssh-runner.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts'
      ])
    )
    expect(plan.capabilityOverlays).toEqual(['windows_sensitive'])
    expect(plan.fallbackCapabilities).toEqual(['main_runtime'])

    const affected = createAffectedTestPlan(
      [{ path: 'src/main/compute/compute-job-lifecycle.ts', status: 'added' }],
      { status: 'current', testFiles: [] }
    )
    expect(affected.modules).toEqual(['workspace_page', 'compute_service'])
    expect(affected.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/concurrency-integration.test.ts'
      ])
    )
  })

  it.each([
    'src/main/compute/compute-job-lifecycle.ts',
    'src/main/compute/job-deletion-owner.ts',
    'src/main/compute/job-repository.ts',
    'src/main/compute/concurrency-manager.ts',
    'src/main/compute/job-dispatcher.ts',
    'src/main/compute/job-poller.ts'
  ])('routes Compute lifecycle changes through its complete certification set for %s', (path) => {
    const affected = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'current',
      testFiles: []
    })

    expect(affected.mode).toBe('selective')
    expect(affected.modules).toEqual(['workspace_page', 'compute_service'])
    expect(affected.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-service.architecture.test.ts',
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/job-deletion-owner.test.ts',
        'src/main/compute/concurrency-manager.test.ts',
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
    const direct = createModuleTestPlan('user_skills_repository')
    expect(direct.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/skills/user-skill-catalog-observer.test.ts',
        'src/main/skills/user-skill-compatibility-index.test.ts',
        'src/main/skills/user-skill-repository.architecture.test.ts',
        'src/main/skills/user-skill-repository.atomic.test.ts',
        'src/main/skills/user-skill-repository.test.ts',
        'src/main/skills/host-skills-service.test.ts',
        'src/main/skills/conversation-import.test.ts',
        'src/main/skills/specialist-package-adapter.test.ts',
        'src/main/notebook/local-rpc-server.test.ts',
        'src/main/notebook/local-rpc-server.skill-import.test.ts',
        'src/main/notebook/local-rpc-server.skills.test.ts',
        'src/main/settings/skill-catalog.test.ts',
        'src/main/settings/service.test.ts',
        'src/main/specialist/package/release-certification.test.ts',
        'src/main/specialist/package/service.test.ts',
        'src/preload/index.test.ts',
        'src/renderer/src/pages/settings/SkillsPanel.render.test.tsx',
        'src/renderer/src/stores/settings-skills-slice.test.ts'
      ])
    )

    for (const { path, status } of [
      { path: 'src/main/skills/user-skill-catalog-observer.ts', status: 'modified' },
      { path: 'src/main/skills/user-skill-compatibility-index.ts', status: 'added' },
      { path: 'src/main/skills/user-skill-repository.ts', status: 'modified' },
      { path: 'src/main/skills/user-skill-store.ts', status: 'modified' },
      { path: 'src/main/skills/agent-home-skill-owner.ts', status: 'added' },
      { path: 'src/main/skills/skill-bundle-import-owner.ts', status: 'modified' },
      { path: 'src/main/skills/user-skill-import-contracts.ts', status: 'added' },
      { path: 'src/main/skills/skill-mutation-owner.ts', status: 'modified' },
      { path: 'src/main/skills/skill-package-transaction-owner.ts', status: 'modified' }
    ] as const) {
      const affected = createAffectedTestPlan([{ path, status }], {
        status: 'current',
        testFiles: []
      })
      expect([...affected.modules].sort()).toEqual([
        'settings_service_facade',
        'user_skills_repository',
        'workspace_page',
        'workspace_runtime'
      ])
      expect(affected.reasonChains).toEqual(
        expect.arrayContaining([
          'user_skills_repository -> settings_service_facade',
          'user_skills_repository -> settings_service_facade -> workspace_runtime',
          'user_skills_repository -> settings_service_facade -> workspace_runtime -> workspace_page'
        ])
      )
      expect(affected.testFiles).toEqual(
        expect.arrayContaining([
          'packages/open-science/cli.test.ts',
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
      'artifact_storage',
      'artifact_provenance',
      'session_persistence',
      'project_lifecycle'
    ])
    expect(plan.testFiles).toContain('src/main/reviewer/ipc.test.ts')
    expect(plan.reasonChains).toContain('artifact_storage -> artifact_provenance')
  })

  it.each(['src/main/reviewer/reviewer-session-driver.ts', 'src/shared/reviewer.ts'])(
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
        'workspace_page',
        'workspace_runtime'
      ])
      expect(plan.reasonChains).toEqual(
        expect.arrayContaining([
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
        'settings_backend_resolution',
        'settings_provider_accounts',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/responses-bridge.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'settings_backend_resolution',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/responses-request-adapter.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'settings_backend_resolution',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/responses-response-adapter.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'settings_backend_resolution',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
      ]
    ],
    [
      'src/main/settings/responses-protocol-types.ts',
      [
        'artifact_provenance',
        'project_lifecycle',
        'reviewer_orchestrator',
        'session_persistence',
        'settings_backend_resolution',
        'settings_service_facade',
        'workspace_page',
        'workspace_runtime'
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
    const rootModule =
      path === 'src/main/settings/repository.ts' ||
      path === 'src/main/settings/compute-grant-port.ts'
        ? 'settings_repository'
        : path === 'src/main/settings/provider-accounts.ts'
          ? 'settings_provider_accounts'
          : path === 'src/main/settings/responses-bridge.ts' ||
              path === 'src/main/settings/responses-protocol-types.ts' ||
              path === 'src/main/settings/responses-request-adapter.ts' ||
              path === 'src/main/settings/responses-response-adapter.ts'
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

  it('prints the exact file list before invoking portable npm test arguments', () => {
    const plan = createModuleTestPlan('upload_repository')
    const spawn = vi.fn(() => ({ status: 0 }))
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
    expect(spawn).toHaveBeenCalledWith(
      '/node',
      ['/npm/bin/npm-cli.js', 'test', '--', ...plan.testFiles],
      expect.objectContaining({ cwd: '/repo', stdio: 'inherit' })
    )
    expect(spawn.mock.calls[0]?.[2]?.env).not.toHaveProperty('VITEST_CHANGED_COVERAGE_THRESHOLDS')
    write.mockRestore()
  })

  it('keeps changed-source coverage separate from authoritative affected test selection', () => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
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
    const spawn = vi.fn(() => ({ status: 0 }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const environment = { npm_execpath: '/npm/bin/npm-cli.js' }
    const expectedPlan = createAffectedTestPlan(
      [{ path: 'src/main/artifacts/repository.ts', status: 'modified' }],
      { status: 'current', testFiles: [] }
    )

    expect(
      runModuleTestCli(['affected', '--base', base, '--head', head, '--coverage-changed', base], {
        cwd: '/repo',
        execute,
        spawn,
        environment,
        nodeExecutable: '/node'
      })
    ).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
      '/node',
      [
        '/npm/bin/npm-cli.js',
        'test',
        '--',
        '--coverage',
        '--coverage.changed',
        base,
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
    expect(spawn.mock.calls[0]?.[1]).toContain('src/main/reviewer/ipc.test.ts')
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
    const spawn = vi.fn(() => ({ status: 0 }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(
      executeModuleTestPlan(plan, {
        cwd: '/repo',
        spawn,
        environment: {},
        platform: 'linux'
      })
    ).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
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
    expect(packageJson.scripts['test:module']).toContain('module-test-impact.mjs module')
    expect(packageJson.scripts['test:affected']).toContain('module-test-impact.mjs affected')
  })
})
