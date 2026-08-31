import { describe, expect, it, vi } from 'vitest'

const { log } = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => log
}))

import type { NotebookLanguage } from '../../shared/notebook'
import type {
  RuntimeReadiness,
  RuntimeSelection,
  RuntimeSurvey
} from '../../shared/notebook-runtime'
import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationCommandInstallation,
  type ApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createWebCallerContext, type CallerContext } from '../caller-context'
import type { RuntimeSelectionWorkflows } from './runtime-selection-workflows'
import {
  registerRuntimeApplicationCommands,
  runtimeApplicationCommandGroup,
  runtimeApplicationCommands
} from './runtime-application-commands'

const caller = (location: CallerContext['location'] = 'local'): CallerContext =>
  createWebCallerContext('runtime-client', { location })

const lease = (): ApplicationCallerLease =>
  Object.freeze({
    leaseId: 'runtime-client',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  location: CallerContext['location'] = 'local'
): ApplicationInvocation<Args> =>
  Object.freeze({ callerContext: caller(location), callerLease: lease(), args })

const readiness = (language: NotebookLanguage): RuntimeReadiness => ({
  language,
  source: 'managed',
  detected: true,
  selected: true,
  runnable: true,
  packageMutable: true
})

const survey: RuntimeSurvey = {
  language: 'python',
  selection: { source: 'managed' },
  managed: readiness('python'),
  external: { ...readiness('python'), source: 'external' }
}

const createWorkflows = (): RuntimeSelectionWorkflows => ({
  survey: vi.fn(async () => [survey]),
  listEnvironments: vi.fn(async () => ({ python: [], r: [] })),
  listPackages: vi.fn(async () => [{ name: 'numpy', version: '2.1.3' }]),
  listPackageCounts: vi.fn(async () => ({ managed: 1 })),
  setSelection: vi.fn(async () => survey),
  getEnablement: vi.fn(async () => ({ enabled: {}, installAuthorized: {} })),
  describeUsage: vi.fn(async () => ({ running: 1, idle: 2, dormant: 3 })),
  setEnvironmentEnabled: vi.fn(async () => ({
    enabled: { managed: false },
    installAuthorized: {}
  })),
  setInstallAuthorized: vi.fn(async () => ({
    enabled: {},
    installAuthorized: { managed: true }
  })),
  register: vi.fn(async () => ['/opt/python']),
  unregister: vi.fn(async () => [])
})

const install = (
  workflows = createWorkflows(),
  pickInterpreter = vi.fn(async (): Promise<string | null> => '/opt/python')
): Readonly<{
  installation: ApplicationCommandInstallation
  pickInterpreter: () => Promise<string | null>
  router: ApplicationCommandRouter
  workflows: RuntimeSelectionWorkflows
}> => {
  const router = createApplicationCommandRouter()
  const installation = registerRuntimeApplicationCommands(router.registrar, {
    workflows,
    pickInterpreter
  })
  return { installation, pickInterpreter, router, workflows }
}

describe('runtime application commands', () => {
  it('installs the exact 12-command group and dispatches a remote-safe survey', async () => {
    const { router, workflows } = install()
    const runtimeChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'runtime'
    )?.contracts.map((contract) => contract.channel)

    expect(runtimeChannels).toHaveLength(12)
    expect(runtimeApplicationCommandGroup.commands.map((command) => command.name)).toEqual(
      runtimeChannels
    )
    await expect(
      router.dispatcher.invoke(runtimeApplicationCommands.survey, invocation([] as const, 'remote'))
    ).resolves.toEqual([survey])
    expect(workflows.survey).toHaveBeenCalledOnce()
  })

  it('passes canonical request objects to the runtime workflows', async () => {
    const { router, workflows } = install()
    const selection: RuntimeSelection = { source: 'managed' }

    await router.dispatcher.invoke(
      runtimeApplicationCommands.listEnvironments,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.listPackages,
      invocation([{ language: 'python', envId: 'managed' }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.listPackageCounts,
      invocation([{ language: 'python' }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.setSelection,
      invocation([{ language: 'python', selection }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.getEnablement,
      invocation([{ language: 'python' }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.describeUsage,
      invocation([{ language: 'python', envId: 'managed' }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.setEnvironmentEnabled,
      invocation([{ language: 'python', envId: 'managed', enabled: false, force: true }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.setInstallAuthorized,
      invocation([{ language: 'python', envId: 'managed', authorized: true }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.registerInterpreter,
      invocation([{ language: 'python', path: '/opt/python' }] as const)
    )
    await router.dispatcher.invoke(
      runtimeApplicationCommands.unregisterInterpreter,
      invocation([{ language: 'python', path: '/opt/python' }] as const)
    )

    expect(workflows.listEnvironments).toHaveBeenCalledWith()
    expect(workflows.listPackages).toHaveBeenCalledWith({ language: 'python', envId: 'managed' })
    expect(workflows.listPackageCounts).toHaveBeenCalledWith({ language: 'python' })
    expect(workflows.setSelection).toHaveBeenCalledWith({ language: 'python', selection })
    expect(workflows.getEnablement).toHaveBeenCalledWith({ language: 'python' })
    expect(workflows.describeUsage).toHaveBeenCalledWith({ language: 'python', envId: 'managed' })
    expect(workflows.setEnvironmentEnabled).toHaveBeenCalledWith({
      language: 'python',
      envId: 'managed',
      enabled: false,
      force: true
    })
    expect(workflows.setInstallAuthorized).toHaveBeenCalledWith({
      language: 'python',
      envId: 'managed',
      authorized: true
    })
    expect(workflows.register).toHaveBeenCalledWith({ language: 'python', path: '/opt/python' })
    expect(workflows.unregister).toHaveBeenCalledWith({ language: 'python', path: '/opt/python' })
  })

  it('rejects all six local-only commands before invoking their owners', async () => {
    const { pickInterpreter, router, workflows } = install()
    const selection: RuntimeSelection = { source: 'managed' }

    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.setSelection,
        invocation([{ language: 'python', selection }] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')
    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.setEnvironmentEnabled,
        invocation([{ language: 'python', envId: 'managed', enabled: false }] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')
    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.setInstallAuthorized,
        invocation([{ language: 'python', envId: 'managed', authorized: true }] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')
    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.pickInterpreter,
        invocation([] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')
    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.registerInterpreter,
        invocation([{ language: 'python', path: '/opt/python' }] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')
    await expect(
      router.dispatcher.invoke(
        runtimeApplicationCommands.unregisterInterpreter,
        invocation([{ language: 'python', path: '/opt/python' }] as const, 'remote')
      )
    ).rejects.toThrow('Runtime command is only available to local callers.')

    expect(workflows.setSelection).not.toHaveBeenCalled()
    expect(workflows.setEnvironmentEnabled).not.toHaveBeenCalled()
    expect(workflows.setInstallAuthorized).not.toHaveBeenCalled()
    expect(workflows.register).not.toHaveBeenCalled()
    expect(workflows.unregister).not.toHaveBeenCalled()
    expect(pickInterpreter).not.toHaveBeenCalled()
  })

  it('returns picker cancellation and converts picker failures to null', async () => {
    const pickerFailure = new Error('dialog unavailable')
    const pickInterpreter = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(pickerFailure)
    log.error.mockClear()
    const { router } = install(createWorkflows(), pickInterpreter)

    await expect(
      router.dispatcher.invoke(runtimeApplicationCommands.pickInterpreter, invocation([] as const))
    ).resolves.toBeNull()
    await expect(
      router.dispatcher.invoke(runtimeApplicationCommands.pickInterpreter, invocation([] as const))
    ).resolves.toBeNull()
    expect(log.error).toHaveBeenCalledWith('pick interpreter failed', {
      errorCategory: 'error'
    })
  })

  it('uninstalls only the Runtime command group', async () => {
    const { installation, router } = install()

    installation.uninstall()

    expect(router.dispatcher.commandNames()).toEqual([])
    await expect(
      router.dispatcher.invoke(runtimeApplicationCommands.survey, invocation([] as const))
    ).rejects.toThrow('Unknown application command: runtime:survey')
  })
})
