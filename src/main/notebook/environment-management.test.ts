import { describe, expect, it, vi } from 'vitest'

import type { NotebookKernelMetadata } from '../../shared/notebook'
import type { EnvironmentInfo } from '../../shared/notebook-env'
import {
  NotebookEnvironmentManagementOwner,
  type NotebookEnvironmentManager
} from './environment-management'
import { envPrefix } from './runtime-paths'

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
  statuses: Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
): EnvironmentSession => ({ kernelStatusEntries: () => statuses })

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
    ...overrides
  }
  return {
    owner: new NotebookEnvironmentManagementOwner(options),
    options,
    manager: configuredManager
  }
}

describe('NotebookEnvironmentManagementOwner', () => {
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
    const environments: EnvironmentInfo[] = [
      { name: 'analysis', language: 'python', ready: true, isDefault: false }
    ]
    vi.mocked(configured.listEnvironments).mockImplementation(() => {
      order.push('list')
      return environments
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
        packages: ['numpy']
      })
    ).resolves.toEqual({ environments })

    expect(order).toEqual([
      'recovery',
      'recoverable',
      'mutation:analysis',
      'create:analysis:python:numpy',
      'list'
    ])
    expect(options.assertPrefixRecoverable).toHaveBeenCalledWith(envPrefix('/runtime', 'analysis'))
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
        session([
          ['repl', 'idle'],
          ['python:analysis', 'idle'],
          ['r:finished', 'terminated']
        ])
      ]
    })

    await expect(owner.manage({ action: 'remove', name: 'default-python-3.13' })).rejects.toThrow(
      /app-managed and cannot be removed/
    )
    await expect(owner.manage({ action: 'remove', name: 'analysis' })).rejects.toThrow(
      /in use by a running kernel/
    )

    expect(options.ensureRecovered).not.toHaveBeenCalled()
    expect(configured.removeEnvironment).not.toHaveBeenCalled()
  })

  it('removes an idle-free environment under recovery and clears its repair state', async () => {
    const order: string[] = []
    const configured = manager()
    const remaining: EnvironmentInfo[] = [
      { name: 'other', language: 'r', ready: true, isDefault: false }
    ]
    vi.mocked(configured.removeEnvironment).mockImplementation((name) => {
      order.push(`remove:${name}`)
      return remaining
    })
    const { owner, options } = harness({
      manager: configured,
      sessions: () => [session([['python:analysis', 'terminated']])],
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
      environments: remaining
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
