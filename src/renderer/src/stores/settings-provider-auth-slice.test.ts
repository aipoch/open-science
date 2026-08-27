import type { StoreApi } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  AgentFrameworkId,
  ProviderView,
  SettingsSnapshot,
  ValidateProviderResult
} from '../../../shared/settings'
import { createProviderAuthSlice, type ProviderAuthActions } from './settings-provider-auth-slice'
import { createSettingsWriteCoordinator } from './settings-write-coordinator'

type ProviderCommands = Pick<
  Window['api']['settings'],
  | 'getSettings'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'validateProvider'
  | 'cancelCodexLogin'
  | 'cancelClaudeLogin'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'loginSharedClaude'
  | 'logoutSharedClaude'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'cancelIsolatedClaudeLogin'
  | 'logoutIsolatedClaude'
  | 'refreshProviderModels'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
>

type CommandMocks = { [Command in keyof ProviderCommands]: Mock }

type TestStore = ProviderAuthActions & {
  providers: ProviderView[]
  activeProviderId: string | undefined
  activeModel: string | undefined
  agentFrameworkId: AgentFrameworkId
  settingsWriteError: string | undefined
}

const provider = (id: string): ProviderView => ({
  id,
  type: 'custom',
  name: id,
  model: 'model-1',
  models: ['model-1'],
  supportsImageInput: false,
  hasKey: true,
  needsKey: false
})

const snapshot = (
  providers: ProviderView[] = [],
  patch: Partial<SettingsSnapshot> = {}
): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers,
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light',
  ...patch
})

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const createCommands = (): CommandMocks => ({
  getSettings: vi.fn().mockResolvedValue(snapshot()),
  upsertProvider: vi.fn().mockResolvedValue(snapshot()),
  deleteProvider: vi.fn().mockResolvedValue(snapshot()),
  setActiveProvider: vi.fn().mockResolvedValue(snapshot()),
  setAgentFramework: vi.fn().mockResolvedValue(snapshot()),
  validateProvider: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelCodexLogin: vi.fn().mockResolvedValue(undefined),
  cancelClaudeLogin: vi.fn().mockResolvedValue(undefined),
  loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginSharedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutSharedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelIsolatedClaudeLogin: vi.fn().mockResolvedValue(undefined),
  logoutIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  beginXaiOAuthLogin: vi.fn().mockResolvedValue({
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://auth.x.ai/activate',
    expiresAt: Date.now() + 60_000,
    intervalSeconds: 5
  }),
  waitXaiOAuthLogin: vi.fn().mockResolvedValue({}),
  cancelXaiOAuthLogin: vi.fn().mockResolvedValue(undefined),
  logoutXaiOAuth: vi.fn().mockResolvedValue(snapshot()),
  refreshProviderModels: vi
    .fn()
    .mockResolvedValue({ ok: true, category: 'ok', models: ['model-1'] })
})

const createHarness = (): {
  commands: CommandMocks
  refreshPreflight: Mock
  refreshFrameworkStatus: Mock
  reconcileSnapshot: Mock
  store: StoreApi<TestStore>
} => {
  const commands = createCommands()
  const refreshPreflight = vi.fn().mockResolvedValue(undefined)
  const refreshFrameworkStatus = vi.fn().mockResolvedValue(undefined)
  const reconcileSnapshot = vi.fn((next: SettingsSnapshot) => {
    store.setState({
      providers: next.providers,
      activeProviderId: next.activeProviderId,
      activeModel: next.activeModel,
      agentFrameworkId: next.agentFrameworkId
    })
  })
  const store = createStore<TestStore>((set, get) => {
    const writeCoordinator = createSettingsWriteCoordinator((settingsWriteError) =>
      set({ settingsWriteError })
    )
    return {
      providers: [],
      activeProviderId: undefined,
      activeModel: undefined,
      agentFrameworkId: 'claude-code',
      settingsWriteError: undefined,
      ...createProviderAuthSlice({
        get,
        getCommands: () => commands as unknown as ProviderCommands,
        reconcileSnapshot,
        refreshPreflight,
        refreshFrameworkStatus,
        writeCoordinator
      })
    }
  })

  return { commands, refreshPreflight, refreshFrameworkStatus, reconcileSnapshot, store }
}

describe('provider auth slice: persistence and validation', () => {
  let commands: CommandMocks
  let refreshPreflight: Mock
  let reconcileSnapshot: Mock
  let store: StoreApi<TestStore>

  beforeEach(() => {
    ;({ commands, refreshPreflight, reconcileSnapshot, store } = createHarness())
  })

  it.each([
    ['custom create', { type: 'custom', name: 'new' }, 'new', 'new'],
    ['custom edit', { id: 'old', type: 'custom', name: 'old' }, 'old', 'old'],
    ['Codex builtin', { id: 'ignored', type: 'codex-shared' }, 'old', 'builtin-codex-subscription'],
    ['Claude shared builtin', { type: 'claude-shared' }, 'old', 'builtin-claude-shared'],
    ['Claude isolated builtin', { type: 'claude-isolated' }, 'old', 'builtin-claude-isolated']
  ] as const)(
    'resolves the stable affected id for %s',
    async (_label, request, addedId, expected) => {
      store.setState({ providers: [provider('old')] })
      commands.upsertProvider.mockResolvedValue(snapshot([provider('old'), provider(addedId)]))

      await expect(store.getState().persistProvider(request)).resolves.toBe(expected)
      expect(reconcileSnapshot).toHaveBeenCalledOnce()
      expect(refreshPreflight).toHaveBeenCalledOnce()
    }
  )

  it('keeps failed validation, refreshes the authoritative provider, and does not roll back', async () => {
    const failed = { ok: false, category: 'auth' } satisfies ValidateProviderResult
    commands.upsertProvider.mockResolvedValue(snapshot([provider('new')]))
    commands.validateProvider.mockResolvedValue(failed)
    commands.getSettings.mockResolvedValue(snapshot([provider('new')]))

    await expect(store.getState().saveProvider({ type: 'custom', name: 'new' })).resolves.toEqual({
      providerId: 'new',
      validation: failed
    })

    expect(commands.validateProvider).toHaveBeenCalledWith({ providerId: 'new' })
    expect(commands.deleteProvider).not.toHaveBeenCalled()
    expect(reconcileSnapshot).toHaveBeenCalledTimes(2)
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('returns unknown without validating or refreshing when an upsert has no affected id', async () => {
    commands.upsertProvider.mockResolvedValue(snapshot([]))

    await expect(
      store.getState().saveProvider({ type: 'custom', name: 'missing' })
    ).resolves.toEqual({
      providerId: '',
      validation: { ok: false, category: 'unknown' }
    })

    expect(commands.validateProvider).not.toHaveBeenCalled()
    expect(commands.getSettings).not.toHaveBeenCalled()
    expect(refreshPreflight).not.toHaveBeenCalled()
  })

  it('activates a saved provider even when its connectivity probe is advisory-failed', async () => {
    const validation = { ok: false, category: 'network' } satisfies ValidateProviderResult
    const saveProvider = vi.fn().mockResolvedValue({ providerId: 'new', validation })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    store.setState({ saveProvider, setActiveProvider })

    await expect(
      store.getState().saveAndActivateProvider({ type: 'custom', name: 'new', model: 'model-a' })
    ).resolves.toEqual({ providerId: 'new', validation })
    expect(setActiveProvider).toHaveBeenCalledWith('new', 'model-a')
  })

  it('refreshes saved validation outcomes but leaves draft validation projection untouched', async () => {
    await store.getState().validateProvider({ draft: { type: 'custom', name: 'draft' } })
    expect(commands.getSettings).not.toHaveBeenCalled()
    expect(refreshPreflight).not.toHaveBeenCalled()

    await store.getState().validateProvider({ providerId: 'saved' })
    expect(commands.getSettings).toHaveBeenCalledOnce()
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })
})

describe('provider auth slice: authentication and catalogs', () => {
  let commands: CommandMocks
  let refreshPreflight: Mock
  let reconcileSnapshot: Mock
  let store: StoreApi<TestStore>

  beforeEach(() => {
    ;({ commands, refreshPreflight, reconcileSnapshot, store } = createHarness())
    commands.getSettings.mockResolvedValue(snapshot([provider('authenticated')]))
  })

  it.each([
    ['loginIsolatedCodex', 'loginIsolatedCodex'],
    ['logoutIsolatedCodex', 'logoutIsolatedCodex'],
    ['loginSharedClaude', 'loginSharedClaude'],
    ['logoutSharedClaude', 'logoutSharedClaude'],
    ['loginIsolatedClaudeBrowser', 'loginIsolatedClaudeBrowser'],
    ['logoutIsolatedClaude', 'logoutIsolatedClaude']
  ] as const)('%s reconciles the recorded outcome and preflight', async (action, command) => {
    commands[command].mockResolvedValue({ ok: false, category: 'auth' })

    await expect(store.getState()[action]()).resolves.toEqual({ ok: false, category: 'auth' })
    expect(commands[command]).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledOnce()
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('forwards an isolated Claude token before reconciling its recorded outcome', async () => {
    await store.getState().loginIsolatedClaude('sk-ant-test')

    expect(commands.loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-test')
    expect(reconcileSnapshot).toHaveBeenCalledOnce()
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('routes cancellation to each existing command without snapshot reconciliation', async () => {
    await Promise.all([
      store.getState().cancelCodexLogin(),
      store.getState().cancelSharedClaudeLogin(),
      store.getState().cancelIsolatedClaudeLogin()
    ])

    expect(commands.cancelCodexLogin).toHaveBeenCalledOnce()
    expect(commands.cancelClaudeLogin).toHaveBeenCalledOnce()
    expect(commands.cancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
    expect(commands.getSettings).not.toHaveBeenCalled()
    expect(refreshPreflight).not.toHaveBeenCalled()
  })

  it('refreshes model catalogs only after a successful vendor fetch', async () => {
    await store.getState().refreshProviderModels('saved')
    expect(commands.getSettings).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledOnce()

    commands.refreshProviderModels.mockResolvedValue({
      ok: false,
      category: 'auth',
      message: 'nope'
    })
    await store.getState().refreshProviderModels('saved')
    expect(commands.getSettings).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledOnce()
  })

  it('deletes through the authoritative snapshot and then refreshes readiness', async () => {
    commands.deleteProvider.mockResolvedValue(snapshot([provider('remaining')]))

    await store.getState().deleteProvider('removed')

    expect(commands.deleteProvider).toHaveBeenCalledWith({ id: 'removed' })
    expect(store.getState().providers.map(({ id }) => id)).toEqual(['remaining'])
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })
})

describe('provider auth slice: active selections', () => {
  it('normalizes an empty model and applies only the newest active-provider completion', async () => {
    const { commands, refreshPreflight, store } = createHarness()
    const first = deferred<SettingsSnapshot>()
    const second = deferred<SettingsSnapshot>()
    commands.setActiveProvider
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const stale = store.getState().setActiveProvider('first', '')
    const current = store.getState().setActiveProvider('second', 'model-2')
    expect(commands.setActiveProvider).toHaveBeenNthCalledWith(1, {
      id: 'first',
      model: undefined
    })

    second.resolve(
      snapshot([provider('second')], { activeProviderId: 'second', activeModel: 'model-2' })
    )
    await current
    first.resolve(snapshot([provider('first')], { activeProviderId: 'first' }))
    await stale

    expect(store.getState()).toMatchObject({ activeProviderId: 'second', activeModel: 'model-2' })
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('preserves rejection and exposes a path-safe active-provider write error', async () => {
    const { commands, store } = createHarness()
    const error = new Error('/Users/example/settings.json unavailable')
    commands.setActiveProvider.mockRejectedValue(error)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(store.getState().setActiveProvider('next')).rejects.toBe(error)
    expect(store.getState().settingsWriteError).toBe(
      'Could not switch active provider or model. Try again.'
    )
    expect(store.getState().settingsWriteError).not.toContain('/Users/example')
  })

  it('reconciles a framework before detection and keeps the saved choice if detection fails', async () => {
    const { commands, refreshFrameworkStatus, store } = createHarness()
    const error = new Error('probe unavailable')
    commands.setAgentFramework.mockResolvedValue(snapshot([], { agentFrameworkId: 'codex' }))
    refreshFrameworkStatus.mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await store.getState().setAgentFramework('codex')

    expect(store.getState().agentFrameworkId).toBe('codex')
    expect(refreshFrameworkStatus).toHaveBeenCalledWith('codex')
    expect(commands.setAgentFramework.mock.invocationCallOrder[0]).toBeLessThan(
      refreshFrameworkStatus.mock.invocationCallOrder[0]
    )
    expect(store.getState().settingsWriteError).toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith('Failed to refresh agent framework status', error)
  })

  it('fences an older framework completion before reconciliation and runtime detection', async () => {
    const { commands, refreshFrameworkStatus, store } = createHarness()
    const first = deferred<SettingsSnapshot>()
    const second = deferred<SettingsSnapshot>()
    commands.setAgentFramework
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const stale = store.getState().setAgentFramework('opencode')
    const current = store.getState().setAgentFramework('codex')
    second.resolve(snapshot([], { agentFrameworkId: 'codex' }))
    await current
    first.resolve(snapshot([], { agentFrameworkId: 'opencode' }))
    await stale

    expect(store.getState().agentFrameworkId).toBe('codex')
    expect(refreshFrameworkStatus).toHaveBeenCalledOnce()
    expect(refreshFrameworkStatus).toHaveBeenCalledWith('codex')
  })
})
