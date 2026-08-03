import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type {
  RuntimeEnablement,
  RuntimeReadiness,
  RuntimeSelection
} from '../../shared/notebook-runtime'
import type { DiscoveredInterpreter } from './environment-discovery'

const discoveryState = vi.hoisted(() => ({
  python: [] as DiscoveredInterpreter[],
  r: [] as DiscoveredInterpreter[],
  snapshots: [] as Array<{ runtimeRoot: string; python: string[]; r: string[] }>
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
  discoverInterpreters: async (language: NotebookLanguage) => discoveryState[language]
}))

import {
  createRuntimeSelectionWorkflows,
  type RuntimeSelectionWorkflowDeps
} from './runtime-selection-workflows'

type SettingsPort = RuntimeSelectionWorkflowDeps['settingsService']

const emptyEnablement = (): RuntimeEnablement => ({ enabled: {}, installAuthorized: {} })

const fakeSettingsService = (): SettingsPort & {
  selections: Map<NotebookLanguage, RuntimeSelection>
  enablement: Map<NotebookLanguage, RuntimeEnablement>
  manual: Map<NotebookLanguage, string[]>
} => {
  const selections = new Map<NotebookLanguage, RuntimeSelection>()
  const enablement = new Map<NotebookLanguage, RuntimeEnablement>()
  const manual = new Map<NotebookLanguage, string[]>()
  const readEnablement = (language: NotebookLanguage): RuntimeEnablement =>
    enablement.get(language) ?? emptyEnablement()

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

const runtimeReadiness = (
  language: NotebookLanguage,
  source: RuntimeReadiness['source'],
  overrides: Partial<RuntimeReadiness> = {}
): RuntimeReadiness => ({
  language,
  source,
  detected: true,
  selected: false,
  runnable: true,
  packageMutable: source === 'managed',
  ...overrides
})

const fakeRegistry = (
  order: string[] = []
): NonNullable<RuntimeSelectionWorkflowDeps['registry']> => ({
  survey: vi.fn(async (language: NotebookLanguage) => {
    order.push('survey')
    return {
      managed: runtimeReadiness(language, 'managed'),
      external: runtimeReadiness(language, 'external')
    }
  }),
  readiness: vi.fn(async (language: NotebookLanguage) => {
    order.push('readiness')
    return runtimeReadiness(language, 'external', { selected: true })
  })
})

beforeEach(() => {
  discoveryState.python = []
  discoveryState.r = []
  discoveryState.snapshots = []
})

describe('runtime selection workflows', () => {
  it('returns the persisted runtime enablement unchanged', async () => {
    const settingsService = fakeSettingsService()
    const persisted: RuntimeEnablement = {
      enabled: { '/managed/python': false },
      installAuthorized: { '/user/python': true }
    }
    settingsService.enablement.set('python', persisted)
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
    })

    await expect(workflows.getEnablement({ language: 'python' })).resolves.toBe(persisted)
  })

  it('reports zero live usage when runtime usage is not wired', async () => {
    const workflows = createRuntimeSelectionWorkflows({
      settingsService: fakeSettingsService(),
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
    })

    await expect(
      workflows.describeUsage({ language: 'python', envId: '/managed/python' })
    ).resolves.toEqual({ running: 0, idle: 0, dormant: 0 })
  })

  it('returns the live runtime usage object unchanged when usage is wired', async () => {
    const usage = { running: 1, idle: 2, dormant: 3 }
    const describeRuntimeUsage = vi.fn(() => usage)
    const workflows = createRuntimeSelectionWorkflows({
      settingsService: fakeSettingsService(),
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry(),
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
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
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
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
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
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry(),
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
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry(),
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
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
    })

    const environments = await workflows.listEnvironments()

    expect(environments).toEqual({ python: discoveryState.python, r: discoveryState.r })
    expect(discoveryState.snapshots.at(-1)).toEqual({
      runtimeRoot: '/data/runtime',
      python: ['/manual/python3'],
      r: ['/manual/R']
    })
  })

  it('surveys both languages and refreshes readiness for the selected external runtime', async () => {
    const settingsService = fakeSettingsService()
    const selection: RuntimeSelection = {
      source: 'external',
      interpreterPath: '/selected/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    }
    settingsService.selections.set('python', selection)
    const registry = fakeRegistry()
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry
    })

    const surveys = await workflows.survey()

    expect(surveys.map((survey) => survey.language)).toEqual(['python', 'r'])
    expect(registry.readiness).toHaveBeenCalledWith('python', selection)
    expect(surveys[0]?.external).toMatchObject({ source: 'external', selected: true })
    expect(surveys[1]?.selection).toBeUndefined()
  })

  it('prepares an app-owned external runtime before persisting its selection', async () => {
    const order: string[] = []
    const settingsService = fakeSettingsService()
    const persist = settingsService.setRuntimeSelection
    settingsService.setRuntimeSelection = async (language, selection) => {
      order.push('persist')
      return persist(language, selection)
    }
    const prepareExternalPython = vi.fn(async () => void order.push('prepare'))
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry(order),
      prepareExternalPython
    })
    const selection: RuntimeSelection = {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: true,
      packageInstallAuthorized: true
    }

    const survey = await workflows.setSelection({ language: 'python', selection })

    expect(order).toEqual(['readiness', 'prepare', 'persist', 'survey', 'readiness'])
    expect(prepareExternalPython).toHaveBeenCalledWith(selection, '/data/runtime')
    expect(settingsService.selections.get('python')).toBe(selection)
    expect(survey.selection).toBe(selection)
  })

  it('does not persist an app-owned selection when overlay preparation fails', async () => {
    const settingsService = fakeSettingsService()
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry(),
      prepareExternalPython: async () => {
        throw new Error('matplotlib import failed')
      }
    })

    await expect(
      workflows.setSelection({
        language: 'python',
        selection: {
          source: 'external',
          interpreterPath: '/usr/bin/python3',
          appOwnedOverlay: true,
          packageInstallAuthorized: true
        }
      })
    ).rejects.toThrow(/selection was not saved.*matplotlib import failed/)
    expect(settingsService.selections.has('python')).toBe(false)
  })

  it('rejects an unusable external runtime without persisting it', async () => {
    const settingsService = fakeSettingsService()
    const registry = fakeRegistry()
    vi.mocked(registry.readiness).mockResolvedValue(
      runtimeReadiness('python', 'external', {
        runnable: false,
        detail: 'not a runnable Python 3'
      })
    )
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry
    })

    await expect(
      workflows.setSelection({
        language: 'python',
        selection: {
          source: 'external',
          interpreterPath: '/usr/bin/python2',
          appOwnedOverlay: false,
          packageInstallAuthorized: false
        }
      })
    ).rejects.toThrow(/not a runnable Python 3/)
    expect(settingsService.selections.has('python')).toBe(false)
  })

  it('rejects external R before probing or persisting it', async () => {
    const settingsService = fakeSettingsService()
    const registry = fakeRegistry()
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry
    })

    await expect(
      workflows.setSelection({
        language: 'r',
        selection: {
          source: 'external',
          interpreterPath: '/usr/bin/R',
          appOwnedOverlay: false,
          packageInstallAuthorized: false
        }
      })
    ).rejects.toThrow('R only supports the app-managed runtime.')
    expect(registry.readiness).not.toHaveBeenCalled()
    expect(settingsService.selections.has('r')).toBe(false)
  })

  it('clears a persisted selection and returns its refreshed survey', async () => {
    const settingsService = fakeSettingsService()
    settingsService.selections.set('python', { source: 'managed' })
    const workflows = createRuntimeSelectionWorkflows({
      settingsService,
      runtimeRoot: () => '/data/runtime',
      registry: fakeRegistry()
    })

    const survey = await workflows.setSelection({ language: 'python', selection: null })

    expect(settingsService.selections.has('python')).toBe(false)
    expect(survey.selection).toBeUndefined()
  })
})
