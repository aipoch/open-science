import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import type { DiscoveredInterpreter } from './environment-discovery'

const discoveryState = vi.hoisted(() => ({
  python: [] as DiscoveredInterpreter[],
  r: [] as DiscoveredInterpreter[],
  snapshots: [] as Array<{ runtimeRoot: string; python: string[]; r: string[] }>,
  // Every discoverInterpreters invocation, so tests can assert on sweep counts.
  calls: [] as NotebookLanguage[]
}))

vi.mock('./environment-discovery', () => ({
  defaultDiscoveryDeps: (
    runtimeRoot: string,
    getManualInterpreters: (language: NotebookLanguage) => string[]
  ) => {
    discoveryState.snapshots.push({
      runtimeRoot,
      python: getManualInterpreters('python'),
      r: getManualInterpreters('r')
    })
    return {}
  },
  discoverInterpreters: async (language: NotebookLanguage) => {
    discoveryState.calls.push(language)
    return discoveryState[language]
  }
}))

import { createRuntimeWorkflows, type RuntimeWorkflowDeps } from './runtime-workflows'

type SettingsPort = RuntimeWorkflowDeps['settingsService']

const emptyEnablement = (): RuntimeEnablement => ({ enabled: {}, installAuthorized: {} })

const fakeSettingsService = (): SettingsPort & {
  enablement: Map<NotebookLanguage, RuntimeEnablement>
  manual: Map<NotebookLanguage, string[]>
  agentEnvironmentCreationEnabled: { value: boolean }
} => {
  const enablement = new Map<NotebookLanguage, RuntimeEnablement>()
  const manual = new Map<NotebookLanguage, string[]>()
  const agentEnvironmentCreationEnabled = { value: true }
  const readEnablement = (language: NotebookLanguage): RuntimeEnablement =>
    enablement.get(language) ?? emptyEnablement()

  return {
    enablement,
    manual,
    agentEnvironmentCreationEnabled,
    getRuntimeEnablement: async (language) => readEnablement(language),
    setEnvironmentEnabled: async (language, envId, enabled) => {
      const current = readEnablement(language)
      const next = {
        enabled: { ...current.enabled, [envId]: enabled },
        installAuthorized: { ...current.installAuthorized }
      }
      enablement.set(language, next)
      return next
    },
    setInstallAuthorized: async (language, envId, authorized) => {
      const current = readEnablement(language)
      const next = {
        enabled: { ...current.enabled },
        installAuthorized: { ...current.installAuthorized, [envId]: authorized }
      }
      enablement.set(language, next)
      return next
    },
    getAgentEnvironmentCreationEnabled: async () => agentEnvironmentCreationEnabled.value,
    setAgentEnvironmentCreationEnabled: async (enabled) => {
      agentEnvironmentCreationEnabled.value = enabled
      return enabled
    },
    getManualInterpreters: async (language) => manual.get(language) ?? [],
    addManualInterpreter: async (language, path) => {
      const next = [...new Set([...(manual.get(language) ?? []), path])]
      manual.set(language, next)
      return next
    },
    removeManualInterpreter: async (language, path) => {
      const next = (manual.get(language) ?? []).filter((candidate) => candidate !== path)
      manual.set(language, next)
      return next
    }
  }
}

beforeEach(() => {
  discoveryState.python = []
  discoveryState.r = []
  discoveryState.snapshots = []
  discoveryState.calls = []
})

describe('runtime workflows', () => {
  it('returns the persisted runtime enablement unchanged', async () => {
    const settingsService = fakeSettingsService()
    const persisted: RuntimeEnablement = {
      enabled: { '/managed/python': false },
      installAuthorized: { '/user/python': true }
    }
    settingsService.enablement.set('python', persisted)
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })

    await expect(workflows.getEnablement({ language: 'python' })).resolves.toBe(persisted)
  })

  it('reports zero live usage when runtime usage is not wired', async () => {
    const workflows = createRuntimeWorkflows({
      settingsService: fakeSettingsService(),
      runtimeRoot: () => '/data/runtime'
    })

    await expect(
      workflows.describeUsage({ language: 'python', envId: '/managed/python' })
    ).resolves.toEqual({ running: 0, idle: 0, dormant: 0 })
  })

  it('returns the live runtime usage object unchanged when usage is wired', async () => {
    const usage = { running: 1, idle: 2, dormant: 3 }
    const describeRuntimeUsage = vi.fn(() => usage)
    const workflows = createRuntimeWorkflows({
      settingsService: fakeSettingsService(),
      runtimeRoot: () => '/data/runtime',
      describeRuntimeUsage
    })

    await expect(workflows.describeUsage({ language: 'r', envId: '/managed/r' })).resolves.toBe(
      usage
    )
    expect(describeRuntimeUsage).toHaveBeenCalledWith('r', '/managed/r')
  })

  it('updates install authorization without changing enabled state', async () => {
    const settingsService = fakeSettingsService()
    settingsService.enablement.set('python', {
      enabled: { '/user/python': true },
      installAuthorized: {}
    })
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })

    const enablement = await workflows.setInstallAuthorized({
      language: 'python',
      envId: '/user/python',
      authorized: true
    })

    expect(enablement).toEqual({
      enabled: { '/user/python': true },
      installAuthorized: { '/user/python': true }
    })
  })

  it('registers and unregisters a manual interpreter without duplicating its path', async () => {
    const settingsService = fakeSettingsService()
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })
    const request = { language: 'python' as const, path: '/manual/python3' }

    await expect(workflows.register(request)).resolves.toEqual(['/manual/python3'])
    await expect(workflows.register(request)).resolves.toEqual(['/manual/python3'])
    await expect(workflows.unregister(request)).resolves.toEqual([])
  })

  it('persists a disabled runtime before revoking it and preserves that state on revoke failure', async () => {
    const order: string[] = []
    const settingsService = fakeSettingsService()
    const persist = settingsService.setEnvironmentEnabled
    settingsService.setEnvironmentEnabled = async (language, envId, enabled) => {
      order.push('persist-disabled')
      return persist(language, envId, enabled)
    }
    const failure = new Error('kernel drain failed')
    const onRuntimeDisabled = vi.fn(async () => {
      order.push('revoke')
      throw failure
    })
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      onRuntimeDisabled
    })

    await expect(
      workflows.setEnvironmentEnabled({
        language: 'python',
        envId: '/managed/python',
        enabled: false,
        force: true
      })
    ).rejects.toBe(failure)

    expect(order).toEqual(['persist-disabled', 'revoke'])
    expect(settingsService.enablement.get('python')?.enabled['/managed/python']).toBe(false)
    expect(onRuntimeDisabled).toHaveBeenCalledWith('python', '/managed/python', true)
  })

  it('does not revoke a runtime when enabling it', async () => {
    const settingsService = fakeSettingsService()
    const onRuntimeDisabled = vi.fn()
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      onRuntimeDisabled
    })

    const result = await workflows.setEnvironmentEnabled({
      language: 'python',
      envId: '/user/python',
      enabled: true
    })

    expect(result.enabled['/user/python']).toBe(true)
    expect(onRuntimeDisabled).not.toHaveBeenCalled()
  })

  it('persists the Agent environment-creation policy', async () => {
    const settingsService = fakeSettingsService()
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })

    await expect(workflows.getAgentEnvironmentCreationEnabled()).resolves.toBe(true)
    await expect(workflows.setAgentEnvironmentCreationEnabled({ enabled: false })).resolves.toBe(
      false
    )
    await expect(workflows.getAgentEnvironmentCreationEnabled()).resolves.toBe(false)
  })

  it('rejects a non-boolean Agent environment-creation policy before the settings port', async () => {
    const settingsService = fakeSettingsService()
    settingsService.setAgentEnvironmentCreationEnabled = vi.fn(
      settingsService.setAgentEnvironmentCreationEnabled
    )
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })

    await expect(
      workflows.setAgentEnvironmentCreationEnabled({ enabled: 'false' } as never)
    ).rejects.toThrow('Agent environment creation enabled must be a boolean.')
    expect(settingsService.setAgentEnvironmentCreationEnabled).not.toHaveBeenCalled()
  })

  it('discovers both languages from one manual-catalog and runtime-root snapshot', async () => {
    const settingsService = fakeSettingsService()
    settingsService.manual.set('python', ['/manual/python3'])
    settingsService.manual.set('r', ['/manual/R'])
    discoveryState.python = [
      {
        language: 'python',
        provenance: 'user-own',
        envId: '/manual/python3',
        interpreterPath: '/manual/python3',
        label: 'Manual Python',
        runnable: true
      }
    ]
    discoveryState.r = [
      {
        language: 'r',
        provenance: 'user-own',
        envId: '/manual/R',
        interpreterPath: '/manual/R',
        label: 'Manual R',
        runnable: true
      }
    ]
    const workflows = createRuntimeWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime'
    })

    const environments = await workflows.listEnvironments()

    expect(environments).toEqual({ python: discoveryState.python, r: discoveryState.r })
    expect(discoveryState.snapshots.at(-1)).toEqual({
      runtimeRoot: '/data/runtime',
      python: ['/manual/python3'],
      r: ['/manual/R']
    })
  })
})

describe('package-listing workflows', () => {
  const fakeEnv = (
    provenance: DiscoveredInterpreter['provenance'],
    envId: string,
    overrides: Partial<DiscoveredInterpreter> = {}
  ): DiscoveredInterpreter => ({
    language: 'python',
    provenance,
    envId,
    interpreterPath: envId,
    label: envId,
    runnable: true,
    ...overrides
  })

  const fakeWorkflows = (
    listPackages: NonNullable<RuntimeWorkflowDeps['listPackages']>
  ): ReturnType<typeof createRuntimeWorkflows> =>
    createRuntimeWorkflows({
      settingsService: fakeSettingsService(),
      runtimeRoot: () => '/data/runtime',
      listPackages
    })

  it('lists packages for a DISCOVERED env, passing the discovery env (not renderer data) through', async () => {
    discoveryState.python = [fakeEnv('app-managed', '/managed/a')]
    const listed: DiscoveredInterpreter[] = []
    const workflows = fakeWorkflows(async (env) => {
      listed.push(env)
      return [{ name: 'numpy', version: '2.1.3', build: 'b0', channel: 'conda-forge' }]
    })

    const result = await workflows.listPackages({ language: 'python', envId: '/managed/a' })

    expect(result).toEqual([
      { name: 'numpy', version: '2.1.3', build: 'b0', channel: 'conda-forge' }
    ])
    expect(listed).toEqual([fakeEnv('app-managed', '/managed/a')])
  })

  it('rejects an envId that discovery does not know, so arbitrary paths cannot be probed', async () => {
    discoveryState.python = [fakeEnv('app-managed', '/managed/a')]
    const listPackages = vi.fn()
    const workflows = fakeWorkflows(listPackages)

    await expect(
      workflows.listPackages({ language: 'python', envId: '/etc/passwd' })
    ).rejects.toThrow(/Unknown python environment/)
    expect(listPackages).not.toHaveBeenCalled()
  })

  it('counts every runnable env from ONE discovery sweep, skipping non-runnable envs', async () => {
    discoveryState.python = [
      fakeEnv('app-managed', '/managed/a'),
      fakeEnv('user-own', '/usr/bin/python3'),
      fakeEnv('user-own', '/broken/python', { runnable: false })
    ]
    const listed: string[] = []
    const workflows = fakeWorkflows(async (env) => {
      listed.push(env.envId)
      return env.envId === '/managed/a'
        ? [
            { name: 'numpy', version: '2.1.3' },
            { name: 'pandas', version: '2.2.3' }
          ]
        : [{ name: 'requests', version: '2.32.3' }]
    })

    const counts = await workflows.listPackageCounts({ language: 'python' })

    // One sweep regardless of env count; non-runnable envs are never listed.
    expect(discoveryState.calls).toEqual(['python'])
    expect(listed.sort()).toEqual(['/managed/a', '/usr/bin/python3'])
    expect(counts).toEqual({ '/managed/a': 2, '/usr/bin/python3': 1 })
  })

  it('reuses the validated environment snapshot for package counts after Settings discovery', async () => {
    discoveryState.python = [fakeEnv('app-managed', '/managed/a')]
    discoveryState.r = [fakeEnv('app-managed', '/managed/r')]
    const workflows = fakeWorkflows(async () => [{ name: 'numpy', version: '2.1.3' }])

    await workflows.listEnvironments()
    expect(discoveryState.calls).toEqual(['python', 'r'])

    await workflows.listPackageCounts({ language: 'python' })
    await workflows.listPackageCounts({ language: 'r' })

    expect(discoveryState.calls).toEqual(['python', 'r'])
  })

  it('maps a failed listing to null (badge omitted) without failing the other envs', async () => {
    discoveryState.python = [
      fakeEnv('app-managed', '/managed/a'),
      fakeEnv('user-own', '/usr/bin/python3')
    ]
    const workflows = fakeWorkflows(async (env) => {
      if (env.envId === '/usr/bin/python3') throw new Error('pip failed')
      return [{ name: 'numpy', version: '2.1.3' }]
    })

    const counts = await workflows.listPackageCounts({ language: 'python' })

    expect(counts).toEqual({ '/managed/a': 1, '/usr/bin/python3': null })
  })
})
