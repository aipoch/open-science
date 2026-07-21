import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { DetectionResult, EnvironmentAdapter, RuntimeRegistryDeps } from './runtime-registry'
import type {
  DiscoveredInterpreter,
  RuntimeEnablement,
  RuntimeSelection,
  RuntimeSurvey
} from '../../shared/notebook-runtime'

// Capture ipcMain.handle registrations and stub the native dialog so handlers can be invoked without
// a real Electron runtime (mirrors storage/ipc.test.ts).
const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const showOpenDialog = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) }
}))

// Controllable discovery so the enablement-invariant handler never enumerates the real machine.
const discoveryState = vi.hoisted(() => ({
  python: [] as unknown[],
  r: [] as unknown[]
}))

vi.mock('./environment-discovery', () => ({
  defaultDiscoveryDeps: () => ({}),
  discoverInterpreters: async (language: 'python' | 'r') => discoveryState[language]
}))

const fakeEnv = (
  provenance: DiscoveredInterpreter['provenance'],
  envId: string
): DiscoveredInterpreter => ({
  language: 'python',
  provenance,
  envId,
  interpreterPath: envId,
  label: envId,
  runnable: true
})

const { RuntimeRegistry } = await import('./runtime-registry')
const { registerRuntimeIpcHandlers } = await import('./runtime-ipc')

const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)!(undefined, payload))

// A fake adapter that returns a fixed detection per language, so survey never spawns an interpreter.
const fakeAdapter = (
  source: EnvironmentAdapter['source'],
  byLanguage: Partial<Record<NotebookLanguage, DetectionResult>>
): EnvironmentAdapter => ({
  source,
  detect: async (language) =>
    byLanguage[language] ?? { detected: false, runnable: false, detail: 'not found' }
})

const fakeRegistry = (): InstanceType<typeof RuntimeRegistry> => {
  const deps: RuntimeRegistryDeps = {
    managed: fakeAdapter('managed', {
      python: { detected: true, runnable: true, interpreterPath: '/managed/py/bin/python' },
      r: { detected: false, runnable: false, detail: 'Managed environment is not built yet.' }
    }),
    external: fakeAdapter('external', {
      python: {
        detected: true,
        runnable: true,
        interpreterPath: '/usr/bin/python3',
        version: '3.12.0'
      },
      r: { detected: false, runnable: false, detail: 'No system R found.' }
    })
  }
  return new RuntimeRegistry(deps)
}

// In-memory settings seam mirroring SettingsService.get/setRuntimeSelection (external R rejected) and
// the v4 get/set enablement read-modify-write.
const fakeSettingsService = (): {
  store: Map<NotebookLanguage, RuntimeSelection>
  enablement: Map<NotebookLanguage, RuntimeEnablement>
  getRuntimeSelection: (language: NotebookLanguage) => Promise<RuntimeSelection | undefined>
  setRuntimeSelection: (
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ) => Promise<RuntimeSelection | undefined>
  getRuntimeEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement>
  setEnvironmentEnabled: (
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ) => Promise<RuntimeEnablement>
  setInstallAuthorized: (
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ) => Promise<RuntimeEnablement>
  manual: Map<NotebookLanguage, string[]>
  getManualInterpreters: (language: NotebookLanguage) => Promise<string[]>
  addManualInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
  removeManualInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
} => {
  const store = new Map<NotebookLanguage, RuntimeSelection>()
  const enablement = new Map<NotebookLanguage, RuntimeEnablement>()
  const manual = new Map<NotebookLanguage, string[]>()
  const read = (language: NotebookLanguage): RuntimeEnablement =>
    enablement.get(language) ?? { enabled: {}, installAuthorized: {} }
  return {
    store,
    enablement,
    manual,
    getManualInterpreters: async (language) => manual.get(language) ?? [],
    addManualInterpreter: async (language, path) => {
      const next = [...new Set([...(manual.get(language) ?? []), path])]
      manual.set(language, next)
      return next
    },
    removeManualInterpreter: async (language, path) => {
      const next = (manual.get(language) ?? []).filter((p) => p !== path)
      manual.set(language, next)
      return next
    },
    getRuntimeSelection: async (language) => store.get(language),
    setRuntimeSelection: async (language, selection) => {
      if (selection === null) {
        store.delete(language)
        return undefined
      }
      if (language === 'r' && selection.source === 'external') {
        throw new Error('R only supports the managed runtime.')
      }
      store.set(language, selection)
      return selection
    },
    getRuntimeEnablement: async (language) => read(language),
    setEnvironmentEnabled: async (language, envId, enabled) => {
      const current = read(language)
      const next: RuntimeEnablement = {
        enabled: { ...current.enabled, [envId]: enabled },
        installAuthorized: { ...current.installAuthorized }
      }
      enablement.set(language, next)
      return next
    },
    setInstallAuthorized: async (language, envId, authorized) => {
      const current = read(language)
      const next: RuntimeEnablement = {
        enabled: { ...current.enabled },
        installAuthorized: { ...current.installAuthorized, [envId]: authorized }
      }
      enablement.set(language, next)
      return next
    }
  }
}

type Deps = Parameters<typeof registerRuntimeIpcHandlers>[0]

const fakeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  settingsService: fakeSettingsService(),
  runtimeRoot: () => '/tmp/runtime',
  registry: fakeRegistry(),
  ...overrides
})

beforeEach(() => {
  handlers.clear()
  showOpenDialog.mockReset()
  discoveryState.python = []
  discoveryState.r = []
})

describe('runtime IPC handlers', () => {
  it('registers every runtime channel', () => {
    registerRuntimeIpcHandlers(fakeDeps())

    for (const channel of ['runtime:survey', 'runtime:set-selection', 'runtime:pick-interpreter']) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('survey returns both languages with managed + external readiness and the persisted selection', async () => {
    const settingsService = fakeSettingsService()
    settingsService.store.set('python', { source: 'managed' })
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const surveys = (await invoke('runtime:survey')) as RuntimeSurvey[]

    expect(surveys.map((s) => s.language)).toEqual(['python', 'r'])

    const python = surveys.find((s) => s.language === 'python')!
    expect(python.selection).toEqual({ source: 'managed' })
    expect(python.managed).toMatchObject({ source: 'managed', detected: true, runnable: true })
    expect(python.external).toMatchObject({
      source: 'external',
      detected: true,
      runnable: true,
      version: '3.12.0'
    })

    const r = surveys.find((s) => s.language === 'r')!
    expect(r.selection).toBeUndefined()
    expect(r.managed).toMatchObject({ source: 'managed', detected: false })
    expect(r.external).toMatchObject({ source: 'external', detected: false })
  })

  it('set-selection persists the choice and returns the refreshed survey for that language', async () => {
    const settingsService = fakeSettingsService()
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const selection: RuntimeSelection = {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    }
    const survey = (await invoke('runtime:set-selection', {
      language: 'python',
      selection
    })) as RuntimeSurvey

    expect(settingsService.store.get('python')).toEqual(selection)
    expect(survey.language).toBe('python')
    expect(survey.selection).toEqual(selection)
    // The survey still carries both sources' readiness (unaffected by the selection).
    expect(survey.managed.detected).toBe(true)
    expect(survey.external.detected).toBe(true)
  })

  it('set-selection rejects a non-runnable external interpreter and does NOT persist it', async () => {
    const settingsService = fakeSettingsService()
    // External Python detected but NOT runnable (e.g. python2 / not a valid Python 3).
    const registry = new RuntimeRegistry({
      managed: fakeAdapter('managed', {
        python: { detected: true, runnable: true, interpreterPath: '/managed/py/bin/python' }
      }),
      external: fakeAdapter('external', {
        python: { detected: true, runnable: false, detail: 'not a runnable Python 3' }
      })
    })
    registerRuntimeIpcHandlers(fakeDeps({ settingsService, registry }))

    await expect(
      invoke('runtime:set-selection', {
        language: 'python',
        selection: {
          source: 'external',
          interpreterPath: '/usr/bin/python2',
          appOwnedOverlay: false,
          packageInstallAuthorized: false
        }
      })
    ).rejects.toThrow(/not a runnable Python 3/)
    // Crucially, the bad selection was never saved.
    expect(settingsService.store.has('python')).toBe(false)
  })

  it('prepares an app-owned overlay before persisting the external selection', async () => {
    const settingsService = fakeSettingsService()
    const order: string[] = []
    const originalSet = settingsService.setRuntimeSelection
    settingsService.setRuntimeSelection = async (language, selection) => {
      order.push('persist')
      return originalSet(language, selection)
    }
    const prepareExternalPython = vi.fn(async () => void order.push('prepare'))
    registerRuntimeIpcHandlers(fakeDeps({ settingsService, prepareExternalPython }))

    await invoke('runtime:set-selection', {
      language: 'python',
      selection: {
        source: 'external',
        interpreterPath: '/usr/bin/python3',
        appOwnedOverlay: true,
        packageInstallAuthorized: true
      }
    })

    expect(order).toEqual(['prepare', 'persist'])
    expect(prepareExternalPython).toHaveBeenCalledWith(
      expect.objectContaining({ interpreterPath: '/usr/bin/python3' }),
      '/tmp/runtime'
    )
  })

  it('does not persist an app-owned selection when overlay preparation fails', async () => {
    const settingsService = fakeSettingsService()
    registerRuntimeIpcHandlers(
      fakeDeps({
        settingsService,
        prepareExternalPython: async () => {
          throw new Error('matplotlib import failed')
        }
      })
    )

    await expect(
      invoke('runtime:set-selection', {
        language: 'python',
        selection: {
          source: 'external',
          interpreterPath: '/usr/bin/python3',
          appOwnedOverlay: true,
          packageInstallAuthorized: true
        }
      })
    ).rejects.toThrow(/selection was not saved.*matplotlib import failed/)
    expect(settingsService.store.has('python')).toBe(false)
  })

  it('set-selection with null clears the persisted choice', async () => {
    const settingsService = fakeSettingsService()
    settingsService.store.set('python', { source: 'managed' })
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const survey = (await invoke('runtime:set-selection', {
      language: 'python',
      selection: null
    })) as RuntimeSurvey

    expect(settingsService.store.has('python')).toBe(false)
    expect(survey.selection).toBeUndefined()
  })

  it('pick-interpreter returns the injected dialog path', async () => {
    registerRuntimeIpcHandlers(fakeDeps({ showOpenDialog: async () => '/opt/python/bin/python3' }))

    await expect(invoke('runtime:pick-interpreter')).resolves.toBe('/opt/python/bin/python3')
  })

  it('pick-interpreter returns null on cancel and never throws on dialog failure', async () => {
    registerRuntimeIpcHandlers(
      fakeDeps({
        showOpenDialog: async () => {
          throw new Error('dialog blew up')
        }
      })
    )

    await expect(invoke('runtime:pick-interpreter')).resolves.toBeNull()
  })

  it('pick-interpreter uses the native openFile dialog when no override is injected', async () => {
    showOpenDialog.mockResolvedValue({ filePaths: ['/usr/local/bin/python3'] })
    registerRuntimeIpcHandlers(fakeDeps())

    await expect(invoke('runtime:pick-interpreter')).resolves.toBe('/usr/local/bin/python3')
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile'] })
  })
})

describe('runtime enablement handlers', () => {
  it('registers the enablement channels', () => {
    registerRuntimeIpcHandlers(fakeDeps())

    expect(handlers.has('runtime:set-environment-enabled')).toBe(true)
    expect(handlers.has('runtime:set-install-authorized')).toBe(true)
  })

  it('enables a user-own env and returns the refreshed enablement', async () => {
    const settingsService = fakeSettingsService()
    discoveryState.python = [
      fakeEnv('app-managed', '/managed/py'),
      fakeEnv('user-own', '/usr/bin/python3')
    ]
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const result = (await invoke('runtime:set-environment-enabled', {
      language: 'python',
      envId: '/usr/bin/python3',
      enabled: true
    })) as RuntimeEnablement

    expect(result.enabled['/usr/bin/python3']).toBe(true)
    expect(settingsService.enablement.get('python')?.enabled['/usr/bin/python3']).toBe(true)
  })

  it('disables a non-last env while another stays effective-enabled', async () => {
    const settingsService = fakeSettingsService()
    // Two app-managed envs are on by default; disabling one leaves the other enabled.
    discoveryState.python = [
      fakeEnv('app-managed', '/managed/a'),
      fakeEnv('app-managed', '/managed/b')
    ]
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const result = (await invoke('runtime:set-environment-enabled', {
      language: 'python',
      envId: '/managed/a',
      enabled: false
    })) as RuntimeEnablement

    expect(result.enabled['/managed/a']).toBe(false)
    expect(settingsService.enablement.get('python')?.enabled['/managed/a']).toBe(false)
  })

  it('allows disabling the LAST effective-enabled env (a language may have zero enabled)', async () => {
    const settingsService = fakeSettingsService()
    // Only one app-managed env (default ON): disabling it leaves the language with zero enabled — a
    // valid choice. It persists and revokes; the agent bind path surfaces the "enable one" guidance.
    discoveryState.python = [fakeEnv('app-managed', '/managed/only')]
    const revoked: Array<[NotebookLanguage, string, boolean | undefined]> = []
    registerRuntimeIpcHandlers(
      fakeDeps({
        settingsService,
        onRuntimeDisabled: (language, envId, force) => {
          revoked.push([language, envId, force])
          return Promise.resolve()
        }
      })
    )

    const result = (await invoke('runtime:set-environment-enabled', {
      language: 'python',
      envId: '/managed/only',
      enabled: false
    })) as RuntimeEnablement

    expect(result.enabled['/managed/only']).toBe(false)
    expect(settingsService.enablement.get('python')?.enabled['/managed/only']).toBe(false)
    expect(revoked).toEqual([['python', '/managed/only', undefined]])
  })

  it('set-install-authorized records the per-env opt-in without touching enabled', async () => {
    const settingsService = fakeSettingsService()
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const result = (await invoke('runtime:set-install-authorized', {
      language: 'python',
      envId: '/usr/bin/python3',
      authorized: true
    })) as RuntimeEnablement

    expect(result.installAuthorized['/usr/bin/python3']).toBe(true)
    expect(result.enabled).toEqual({})
  })
})

describe('manual-interpreter catalog handlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers the catalog channels', () => {
    registerRuntimeIpcHandlers(fakeDeps())
    expect(handlers.has('runtime:register-interpreter')).toBe(true)
    expect(handlers.has('runtime:unregister-interpreter')).toBe(true)
  })

  it('register/unregister add and drop a path in the per-language catalog', async () => {
    const settingsService = fakeSettingsService()
    registerRuntimeIpcHandlers(fakeDeps({ settingsService }))

    const added = (await invoke('runtime:register-interpreter', {
      language: 'python',
      path: '/opt/py/bin/python3'
    })) as string[]
    expect(added).toEqual(['/opt/py/bin/python3'])
    // Idempotent: registering the same path again does not duplicate it.
    const again = (await invoke('runtime:register-interpreter', {
      language: 'python',
      path: '/opt/py/bin/python3'
    })) as string[]
    expect(again).toEqual(['/opt/py/bin/python3'])

    const removed = (await invoke('runtime:unregister-interpreter', {
      language: 'python',
      path: '/opt/py/bin/python3'
    })) as string[]
    expect(removed).toEqual([])
  })
})
