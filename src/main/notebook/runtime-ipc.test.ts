import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type {
  EnvPackage,
  RuntimeEnablement,
  RuntimeReadiness,
  RuntimeSelection
} from '../../shared/notebook-runtime'
import type { DiscoveredInterpreter } from './environment-discovery'
import {
  createRuntimeSelectionWorkflows,
  type RuntimeSelectionWorkflowDeps
} from './runtime-selection-workflows'

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const showOpenDialog = vi.fn()
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => log
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) }
}))

const discoveryState = vi.hoisted(() => ({
  python: [] as DiscoveredInterpreter[],
  r: [] as DiscoveredInterpreter[]
}))

vi.mock('./environment-discovery', () => ({
  defaultDiscoveryDeps: () => ({}),
  discoverInterpreters: async (language: NotebookLanguage) => discoveryState[language]
}))

const { registerRuntimeIpcHandlers } = await import('./runtime-ipc')

type SettingsPort = RuntimeSelectionWorkflowDeps['settingsService']

const readiness = (
  language: NotebookLanguage,
  source: RuntimeReadiness['source']
): RuntimeReadiness => ({
  language,
  source,
  detected: true,
  selected: false,
  runnable: true,
  packageMutable: source === 'managed'
})

const fakeRegistry = (): NonNullable<RuntimeSelectionWorkflowDeps['registry']> => ({
  survey: async (language) => ({
    managed: readiness(language, 'managed'),
    external: readiness(language, 'external')
  }),
  readiness: async (language) => ({ ...readiness(language, 'external'), selected: true })
})

const fakeSettingsService = (): SettingsPort & {
  selections: Map<NotebookLanguage, RuntimeSelection>
  enablement: Map<NotebookLanguage, RuntimeEnablement>
  manual: Map<NotebookLanguage, string[]>
} => {
  const selections = new Map<NotebookLanguage, RuntimeSelection>()
  const enablement = new Map<NotebookLanguage, RuntimeEnablement>()
  const manual = new Map<NotebookLanguage, string[]>()
  let agentEnvironmentCreationEnabled = true
  const readEnablement = (language: NotebookLanguage): RuntimeEnablement =>
    enablement.get(language) ?? { enabled: {}, installAuthorized: {} }

  return {
    selections,
    enablement,
    manual,
    getRuntimeSelection: async (language) => selections.get(language),
    setRuntimeSelection: async (language, selection) => {
      if (selection === null) {
        selections.delete(language)
        return undefined
      }
      selections.set(language, selection)
      return selection
    },
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
    getAgentEnvironmentCreationEnabled: async () => agentEnvironmentCreationEnabled,
    setAgentEnvironmentCreationEnabled: async (enabled) => {
      agentEnvironmentCreationEnabled = enabled
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

const fakeDeps = (
  overrides: Partial<RuntimeSelectionWorkflowDeps> = {}
): RuntimeSelectionWorkflowDeps => ({
  settingsService: fakeSettingsService(),
  runtimeRoot: () => '/data/runtime',
  registry: fakeRegistry(),
  ...overrides
})

const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)!(undefined, payload))

const registerRuntime = (
  deps: RuntimeSelectionWorkflowDeps,
  options?: { showOpenDialog?: () => Promise<string | null> }
): void => registerRuntimeIpcHandlers(createRuntimeSelectionWorkflows(deps), options)

beforeEach(() => {
  handlers.clear()
  showOpenDialog.mockReset()
  discoveryState.python = []
  discoveryState.r = []
})

describe('runtime IPC adapter', () => {
  it('registers the exact runtime command surface', () => {
    registerRuntime(fakeDeps())

    expect([...handlers.keys()]).toEqual([
      'runtime:survey',
      'runtime:list-environments',
      'runtime:list-packages',
      'runtime:list-package-counts',
      'runtime:set-selection',
      'runtime:get-enablement',
      'runtime:get-agent-environment-creation-enabled',
      'runtime:describe-usage',
      'runtime:set-environment-enabled',
      'runtime:set-install-authorized',
      'runtime:set-agent-environment-creation-enabled',
      'runtime:uninstall-managed-environment',
      'runtime:pick-interpreter',
      'runtime:register-interpreter',
      'runtime:unregister-interpreter'
    ])
  })

  it('routes Runtime application commands through their existing payloads', async () => {
    const settingsService = fakeSettingsService()
    const usage = { running: 1, idle: 2, dormant: 3 }
    const onRuntimeDisabled = vi.fn().mockResolvedValue(undefined)
    const uninstallManagedEnvironment = vi.fn().mockResolvedValue(undefined)
    discoveryState.python = [
      {
        language: 'python',
        provenance: 'user-own',
        envId: '/usr/bin/python3',
        interpreterPath: '/usr/bin/python3',
        label: 'System Python',
        runnable: true
      }
    ]
    registerRuntime(
      fakeDeps({
        settingsService,
        describeRuntimeUsage: () => usage,
        onRuntimeDisabled,
        uninstallManagedEnvironment
      })
    )

    await expect(invoke('runtime:survey')).resolves.toHaveLength(2)
    await expect(invoke('runtime:list-environments')).resolves.toEqual({
      python: discoveryState.python,
      r: []
    })
    await expect(
      invoke('runtime:set-selection', { language: 'python', selection: { source: 'managed' } })
    ).resolves.toMatchObject({ language: 'python', selection: { source: 'managed' } })
    await expect(invoke('runtime:get-enablement', { language: 'python' })).resolves.toEqual({
      enabled: {},
      installAuthorized: {}
    })
    await expect(invoke('runtime:get-agent-environment-creation-enabled')).resolves.toBe(true)
    await expect(
      invoke('runtime:set-agent-environment-creation-enabled', { enabled: false })
    ).resolves.toBe(false)
    await expect(
      invoke('runtime:describe-usage', { language: 'python', envId: '/usr/bin/python3' })
    ).resolves.toBe(usage)
    await expect(
      invoke('runtime:set-environment-enabled', {
        language: 'python',
        envId: '/usr/bin/python3',
        enabled: false,
        force: true
      })
    ).resolves.toMatchObject({ enabled: { '/usr/bin/python3': false } })
    expect(onRuntimeDisabled).toHaveBeenCalledWith('python', '/usr/bin/python3', true)
    await expect(
      invoke('runtime:set-install-authorized', {
        language: 'python',
        envId: '/usr/bin/python3',
        authorized: true
      })
    ).resolves.toMatchObject({ installAuthorized: { '/usr/bin/python3': true } })
    await expect(
      invoke('runtime:uninstall-managed-environment', { language: 'python' })
    ).resolves.toBeUndefined()
    expect(uninstallManagedEnvironment).toHaveBeenCalledWith('python')
    await expect(
      invoke('runtime:register-interpreter', {
        language: 'python',
        path: '/usr/bin/python3'
      })
    ).resolves.toEqual(['/usr/bin/python3'])
    await expect(
      invoke('runtime:unregister-interpreter', {
        language: 'python',
        path: '/usr/bin/python3'
      })
    ).resolves.toEqual([])
  })

  it('preserves application errors for transport callers', async () => {
    const settingsService = fakeSettingsService()
    const failure = new Error('settings unavailable')
    settingsService.getRuntimeEnablement = vi.fn().mockRejectedValue(failure)
    registerRuntime(fakeDeps({ settingsService }))

    await expect(invoke('runtime:get-enablement', { language: 'python' })).rejects.toBe(failure)
  })

  it('returns an injected interpreter path', async () => {
    registerRuntime(fakeDeps(), { showOpenDialog: async () => '/opt/python/bin/python3' })

    await expect(invoke('runtime:pick-interpreter')).resolves.toBe('/opt/python/bin/python3')
  })

  it('returns null when the picker is cancelled or fails', async () => {
    log.error.mockClear()
    registerRuntime(fakeDeps(), { showOpenDialog: async () => null })
    await expect(invoke('runtime:pick-interpreter')).resolves.toBeNull()

    registerRuntime(fakeDeps(), {
      showOpenDialog: async () => {
        throw new Error('dialog blew up')
      }
    })

    await expect(invoke('runtime:pick-interpreter')).resolves.toBeNull()
    expect(log.error).toHaveBeenCalledWith('pick interpreter failed', {
      errorCategory: 'error'
    })
  })

  it('uses the Electron open-file picker when no override is injected', async () => {
    showOpenDialog.mockResolvedValue({ filePaths: ['/usr/local/bin/python3'] })
    registerRuntime(fakeDeps())

    await expect(invoke('runtime:pick-interpreter')).resolves.toBe('/usr/local/bin/python3')
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile'] })
  })

  it('routes the package-listing commands through their payloads', async () => {
    discoveryState.python = [
      {
        language: 'python',
        provenance: 'app-managed',
        envId: '/managed/a',
        interpreterPath: '/managed/a',
        label: '/managed/a',
        runnable: true
      }
    ]
    const packages: EnvPackage[] = [{ name: 'numpy', version: '2.1.3', build: 'b0' }]
    registerRuntime(fakeDeps({ listPackages: async () => packages }))

    await expect(
      invoke('runtime:list-packages', { language: 'python', envId: '/managed/a' })
    ).resolves.toBe(packages)
    await expect(invoke('runtime:list-package-counts', { language: 'python' })).resolves.toEqual({
      '/managed/a': 1
    })
  })
})
