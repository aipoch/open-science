import { describe, expect, it, vi } from 'vitest'

import type { NotebookKernelMetadata } from '../../shared/notebook'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import {
  NotebookEnvironmentManagementOwner,
  type NotebookEnvironmentManager
} from './environment-management'
import { envPrefix, pythonBin } from './runtime-paths'

type OwnerOptions = ConstructorParameters<typeof NotebookEnvironmentManagementOwner>[0]
type EnvironmentSession =
  ReturnType<OwnerOptions['sessions']> extends Iterable<infer Session> ? Session : never

const manager = (): NotebookEnvironmentManager => ({
  createNamedEnvironment: vi.fn(async (name, language) => ({
    name,
    language,
    ready: true,
    isDefault: false
  })),
  listEnvironments: vi.fn(() => []),
  removeEnvironment: vi.fn(() => [])
})

const session = (
  sessionId: string,
  statuses: Array<[string, NotebookKernelMetadata['lastKnownStatus']]>,
  bindings: Array<[NotebookSessionRuntimeBinding['language'], NotebookSessionRuntimeBinding]> = []
): EnvironmentSession => ({
  sessionId,
  kernelStatusEntries: () => statuses,
  runtimeBindingEntries: () => bindings
})

const managedPythonRuntimeId = (name: string): string => pythonBin(envPrefix('/runtime', name))

const runtimeBinding = (
  name: string,
  overrides: Partial<NotebookSessionRuntimeBinding> = {}
): NotebookSessionRuntimeBinding => ({
  language: 'python',
  runtimeId: managedPythonRuntimeId(name),
  source: 'managed',
  provenance: 'agent-created',
  interpreterPath: managedPythonRuntimeId(name),
  label: name,
  envName: name,
  ...overrides
})

const harness = (
  overrides: Partial<OwnerOptions> = {}
): {
  owner: NotebookEnvironmentManagementOwner
  options: OwnerOptions
  manager: NotebookEnvironmentManager | undefined
} => {
  const configuredManager = overrides.manager === undefined ? manager() : overrides.manager
  const options: OwnerOptions = {
    runtimeRoot: '/runtime',
    manager: configuredManager,
    sessions: () => [],
    ensureRecovered: vi.fn().mockResolvedValue(undefined),
    assertPrefixRecoverable: vi.fn(),
    environmentOperations: {
      runMutation: vi.fn(async (_environment, operation) => operation())
    },
    runtimeRepair: {
      completeRemovedManagedEnvironment: vi.fn()
    },
    isAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true),
    ...overrides
  }
  return {
    owner: new NotebookEnvironmentManagementOwner(options),
    options,
    manager: configuredManager
  }
}

describe('NotebookEnvironmentManagementOwner', () => {
  it.each(['default-python-analysis', 'default-r-analysis', 'default-python', 'default-r'])(
    'E07 rejects reserved create name %s before any environment side effect',
    async (name) => {
      const { owner, options, manager: configured } = harness()
      await expect(owner.manage({ action: 'create', name, language: 'python' })).rejects.toThrow(
        /reserved|app-managed/
      )
      expect(options.ensureRecovered).not.toHaveBeenCalled()
      expect(configured?.createNamedEnvironment).not.toHaveBeenCalled()
    }
  )

  it('E07 permits creation and removal of an ordinary user environment', async () => {
    const { owner, manager: configured } = harness()
    await expect(
      owner.manage({ action: 'create', name: 'analysis', language: 'python' })
    ).resolves.toHaveProperty('created.name', 'analysis')
    await owner.manage({ action: 'remove', name: 'analysis' })
    expect(configured?.removeEnvironment).toHaveBeenCalledWith('analysis')
  })

  it.each(['default-python-analysis', 'default-r-analysis'])(
    'E07 preserves an existing conflicting environment %s without proven ownership',
    async (name) => {
      const configured = manager()
      vi.mocked(configured.listEnvironments).mockReturnValue([
        { name, language: 'python', ready: true, isDefault: false }
      ])
      const { owner } = harness({ manager: configured })
      await expect(owner.manage({ action: 'list' })).resolves.toHaveProperty(
        'environments.0.name',
        name
      )
      await expect(owner.manage({ action: 'remove', name })).rejects.toThrow(/app-managed|reserved/)
      expect(configured.removeEnvironment).not.toHaveBeenCalled()
    }
  )

  it('keeps manager configuration inside the owner', async () => {
    const configuredHarness = harness()
    const owner = new NotebookEnvironmentManagementOwner({
      ...configuredHarness.options,
      manager: undefined
    })

    await expect(owner.manage({ action: 'list' })).rejects.toThrow(
      'Environment management is unavailable (no environment manager configured).'
    )

    const configured = manager()
    vi.mocked(configured.listEnvironments).mockReturnValue([
      { name: 'analysis', language: 'python', ready: true, isDefault: false }
    ])
    owner.setManager(configured)

    await expect(owner.manage({ action: 'list' })).resolves.toEqual({
      environments: [{ name: 'analysis', language: 'python', ready: true, isDefault: false }]
    })
  })

  it('validates and creates under recovery and the environment mutation slot', async () => {
    const order: string[] = []
    const configured = manager()
    vi.mocked(configured.createNamedEnvironment).mockImplementation(
      async (name, language, packages) => {
        order.push(`create:${name}:${language}:${packages?.join(',')}`)
        return { name, language, ready: true, isDefault: false }
      }
    )
    vi.mocked(configured.listEnvironments).mockImplementation(() => {
      order.push('list')
      return [{ name: 'analysis', language: 'python', ready: true, isDefault: false }]
    })
    const { owner, options } = harness({
      manager: configured,
      ensureRecovered: vi.fn(async () => {
        order.push('recovery')
      }),
      assertPrefixRecoverable: vi.fn(() => {
        order.push('recoverable')
      }),
      environmentOperations: {
        runMutation: vi.fn(async (environment, operation) => {
          order.push(`mutation:${environment}`)
          return operation()
        })
      }
    })

    await expect(
      owner.manage({
        action: 'create',
        name: 'analysis',
        language: 'python',
        packages: ['numpy'],
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
    ).resolves.toEqual({
      created: {
        name: 'analysis',
        language: 'python',
        runtimeId: managedPythonRuntimeId('analysis'),
        runnable: true
      }
    })

    expect(order).toEqual([
      'recovery',
      'recoverable',
      'mutation:analysis',
      'create:analysis:python:numpy'
    ])
    expect(configured.listEnvironments).not.toHaveBeenCalled()
    expect(configured.createNamedEnvironment).toHaveBeenCalledWith(
      'analysis',
      'python',
      ['numpy'],
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
    )
    expect(options.assertPrefixRecoverable).toHaveBeenCalledWith(envPrefix('/runtime', 'analysis'))
  })

  it('refuses Agent environment creation when the persisted policy is disabled', async () => {
    const {
      owner,
      manager: configured,
      options
    } = harness({
      isAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(false)
    })

    await expect(
      owner.manage({ action: 'create', language: 'python', name: 'analysis' })
    ).rejects.toThrow('AGENT_ENVIRONMENT_CREATION_DISABLED')
    expect(configured?.createNamedEnvironment).not.toHaveBeenCalled()
    expect(options.ensureRecovered).not.toHaveBeenCalled()
  })

  it('rejects invalid create and remove names before lifecycle side effects', async () => {
    const { owner, options, manager: configured } = harness()

    await expect(
      owner.manage({ action: 'create', name: 'python', language: 'python' })
    ).rejects.toThrow(/reserved environment name/)
    await expect(owner.manage({ action: 'create', name: 'analysis' } as never)).rejects.toThrow(
      /requires a language/
    )
    await expect(
      owner.manage({ action: 'remove', name: '../../../../tmp/victim' })
    ).rejects.toThrow(/Invalid environment name/)

    expect(options.ensureRecovered).not.toHaveBeenCalled()
    expect(configured?.createNamedEnvironment).not.toHaveBeenCalled()
    expect(configured?.removeEnvironment).not.toHaveBeenCalled()
  })

  it('refuses app-managed and live environments before recovery or deletion', async () => {
    const configured = manager()
    const { owner, options } = harness({
      manager: configured,
      sessions: () => [
        session('session-1', [
          ['repl', 'idle'],
          ['python:analysis', 'idle'],
          ['r:finished', 'terminated']
        ])
      ]
    })

    await expect(owner.manage({ action: 'remove', name: 'default-python-3.13' })).rejects.toThrow(
      /reserved environment name/
    )
    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      /in use by a running kernel/
    )

    expect(options.ensureRecovered).not.toHaveBeenCalled()
    expect(configured.removeEnvironment).not.toHaveBeenCalled()
  })

  it('refuses an agent-created environment selected by an active dormant Session', async () => {
    const configured = manager()
    const { owner, options } = harness({
      manager: configured,
      sessions: () => [
        session('session-42', [], [['python', runtimeBinding('analysis', { status: 'active' })]])
      ]
    })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      'Environment "analysis" cannot be removed because Session "session-42" has an active Runtime Binding to it. Switch that Session to another Runtime Environment first.'
    )

    expect(options.ensureRecovered).not.toHaveBeenCalled()
    expect(configured.removeEnvironment).not.toHaveBeenCalled()
  })

  it('treats a legacy binding without an explicit status as active', async () => {
    const configured = manager()
    const { owner } = harness({
      manager: configured,
      sessions: () => [session('legacy-session', [], [['python', runtimeBinding('analysis')]])]
    })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      'Session "legacy-session" has an active Runtime Binding to it.'
    )
    expect(configured.removeEnvironment).not.toHaveBeenCalled()
  })

  it('refuses an agent-created environment selected by a revoking dormant Session', async () => {
    const configured = manager()
    const { owner, options } = harness({
      manager: configured,
      sessions: () => [
        session(
          'session-revoking',
          [],
          [['python', runtimeBinding('analysis', { status: 'revoking' })]]
        )
      ]
    })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      'Environment "analysis" cannot be removed because Session "session-revoking" has a revoking Runtime Binding to it. Switch that Session to another Runtime Environment first.'
    )

    expect(options.ensureRecovered).not.toHaveBeenCalled()
    expect(configured.removeEnvironment).not.toHaveBeenCalled()
  })

  it.each(['missing', 'disabled', 'repair-required'] as const)(
    'allows removal when the loaded Session binding is unavailable because it is %s',
    async (reason) => {
      const configured = manager()
      const { owner } = harness({
        manager: configured,
        sessions: () => [
          session(
            'session-unavailable',
            [],
            [['python', runtimeBinding('analysis', { status: 'unavailable', reason })]]
          )
        ]
      })

      await expect(owner.manage({ action: 'remove', name: 'analysis' })).resolves.toEqual({
        removed: { name: 'analysis' }
      })
      expect(configured.removeEnvironment).toHaveBeenCalledWith('analysis')
    }
  )

  it('allows removal when loaded Sessions bind only unrelated environments', async () => {
    const configured = manager()
    const { owner } = harness({
      manager: configured,
      sessions: () => [
        session('session-other', [], [['python', runtimeBinding('other', { status: 'active' })]])
      ]
    })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).resolves.toEqual({
      removed: { name: 'analysis' }
    })
    expect(configured.removeEnvironment).toHaveBeenCalledWith('analysis')
  })

  it('removes an idle-free environment under recovery and clears its repair state', async () => {
    const order: string[] = []
    const configured = manager()
    vi.mocked(configured.removeEnvironment).mockImplementation((name) => {
      order.push(`remove:${name}`)
      return [{ name: 'other', language: 'r', ready: true, isDefault: false }]
    })
    const { owner, options } = harness({
      manager: configured,
      sessions: () => [session('session-1', [['python:analysis', 'terminated']])],
      ensureRecovered: vi.fn(async () => {
        order.push('recovery')
      }),
      assertPrefixRecoverable: vi.fn(() => {
        order.push('recoverable')
      }),
      environmentOperations: {
        runMutation: vi.fn(async (environment, operation) => {
          order.push(`mutation:${environment}`)
          return operation()
        })
      },
      runtimeRepair: {
        completeRemovedManagedEnvironment: vi.fn((name) => {
          order.push(`repair:${name}`)
        })
      }
    })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).resolves.toEqual({
      removed: { name: 'analysis' }
    })

    expect(order).toEqual([
      'recovery',
      'recoverable',
      'mutation:analysis',
      'remove:analysis',
      'repair:analysis'
    ])
    expect(options.assertPrefixRecoverable).toHaveBeenCalledWith(envPrefix('/runtime', 'analysis'))
  })

  it('preserves repair state when physical removal fails', async () => {
    const configured = manager()
    vi.mocked(configured.removeEnvironment).mockImplementation(() => {
      throw new Error('remove failed')
    })
    const { owner, options } = harness({ manager: configured })

    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      'remove failed'
    )

    expect(options.runtimeRepair.completeRemovedManagedEnvironment).not.toHaveBeenCalled()
  })
})
