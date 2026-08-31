import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ClaudeInstallEvent,
  EnvironmentCheckResult,
  SettingsSnapshot,
  SkillView,
  ValidateProviderResult,
  ConnectorView,
  CustomServerView
} from '../../../shared/settings'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../../shared/settings'
import {
  createInitialSettingsState,
  selectAnyInstalling,
  selectProviderModelOptions,
  useSettingsStore
} from './settings-store'

// Minimal window.api.settings surface the store calls.
type SettingsApi = {
  getSettings: ReturnType<typeof vi.fn>
  getPreflight: ReturnType<typeof vi.fn>
  isEncryptionAvailable: ReturnType<typeof vi.fn>
  isNpmAvailable: ReturnType<typeof vi.fn>
  checkEnvironment: ReturnType<typeof vi.fn>
  detectClaude: ReturnType<typeof vi.fn>
  detectOpencode: ReturnType<typeof vi.fn>
  detectCodex: ReturnType<typeof vi.fn>
  detectCodeBuddy: ReturnType<typeof vi.fn>
  installClaude: ReturnType<typeof vi.fn>
  installOpencode: ReturnType<typeof vi.fn>
  installCodex: ReturnType<typeof vi.fn>
  installCodeBuddy: ReturnType<typeof vi.fn>
  uninstallCodeBuddy: ReturnType<typeof vi.fn>
  uninstallCodex: ReturnType<typeof vi.fn>
  onInstallLog: ReturnType<typeof vi.fn>
  setAgentFramework: ReturnType<typeof vi.fn>
  setReasoningEffort: ReturnType<typeof vi.fn>
  setSessionDetailsModel: ReturnType<typeof vi.fn>
  setNotificationsEnabled: ReturnType<typeof vi.fn>
  setConversationSkillImportEnabled: ReturnType<typeof vi.fn>
  setClosePreference: ReturnType<typeof vi.fn>
  setProjectFilesFilter: ReturnType<typeof vi.fn>
  setAppIconVariant: ReturnType<typeof vi.fn>
  setDefaultPermissionProfile: ReturnType<typeof vi.fn>
  upsertProvider: ReturnType<typeof vi.fn>
  validateProvider: ReturnType<typeof vi.fn>
  cancelCodexLogin: ReturnType<typeof vi.fn>
  loginIsolatedCodex: ReturnType<typeof vi.fn>
  logoutIsolatedCodex: ReturnType<typeof vi.fn>
  cancelClaudeLogin: ReturnType<typeof vi.fn>
  loginSharedClaude: ReturnType<typeof vi.fn>
  logoutSharedClaude: ReturnType<typeof vi.fn>
  loginIsolatedClaude: ReturnType<typeof vi.fn>
  loginIsolatedClaudeBrowser: ReturnType<typeof vi.fn>
  cancelIsolatedClaudeLogin: ReturnType<typeof vi.fn>
  logoutIsolatedClaude: ReturnType<typeof vi.fn>
  refreshProviderModels: ReturnType<typeof vi.fn>
  setActiveProvider: ReturnType<typeof vi.fn>
  deleteProvider: ReturnType<typeof vi.fn>
  markOnboardingComplete: ReturnType<typeof vi.fn>
  listSkills: ReturnType<typeof vi.fn>
  onSkillCatalogChanged: ReturnType<typeof vi.fn>
  setSkillEnabled: ReturnType<typeof vi.fn>
  createSkill: ReturnType<typeof vi.fn>
  updateSkill: ReturnType<typeof vi.fn>
  deleteSkill: ReturnType<typeof vi.fn>
  importSkillZip: ReturnType<typeof vi.fn>
  importSkillZipBatch: ReturnType<typeof vi.fn>
  previewSkillZip: ReturnType<typeof vi.fn>
  previewGitHubSkill: ReturnType<typeof vi.fn>
  previewAgentHomeSkill: ReturnType<typeof vi.fn>
  listConnectors: ReturnType<typeof vi.fn>
  onConnectorRuntimeChanged: ReturnType<typeof vi.fn>
  getConnectorDetail: ReturnType<typeof vi.fn>
  setConnectorEnabled: ReturnType<typeof vi.fn>
  setConnectorAutoAllow: ReturnType<typeof vi.fn>
  setToolPermission: ReturnType<typeof vi.fn>
  setNcbiCredentials: ReturnType<typeof vi.fn>
  addCustomServer: ReturnType<typeof vi.fn>
  authenticateCustomServer: ReturnType<typeof vi.fn>
  cancelCustomServerAuthentication: ReturnType<typeof vi.fn>
  setCustomServerEnabled: ReturnType<typeof vi.fn>
  removeCustomServer: ReturnType<typeof vi.fn>
  updateCustomServer: ReturnType<typeof vi.fn>
  respondConnectorApproval: ReturnType<typeof vi.fn>
}

// Minimal window.api.acp surface the provider-switch flow reads/uses.
type AcpApi = {
  getState: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const snapshot = (providers: SettingsSnapshot['providers']): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers,
  agentFrameworkId: 'claude-code',
  agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }],
  opencode: {},
  codex: {},
  codebuddy: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  codebuddyManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
})

const providerView = (id: string): SettingsSnapshot['providers'][number] => ({
  id,
  type: 'custom',
  name: 'Gateway',
  model: 'claude-sonnet-4-5',
  models: ['claude-sonnet-4-5'],
  supportsImageInput: false,
  hasKey: true,
  needsKey: false
})

const skillView = (id: string, name: string): SkillView => ({
  id,
  name,
  displayName: name,
  description: '',
  source: 'personal',
  updatedAt: '',
  enabled: true
})

let api: SettingsApi
let acp: AcpApi
// Ordered log of significant calls, used to assert cancel-before-switch ordering.
let callLog: string[]

beforeEach(() => {
  callLog = []
  api = {
    getSettings: vi.fn().mockResolvedValue(snapshot([])),
    getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
    isEncryptionAvailable: vi.fn().mockResolvedValue(true),
    isNpmAvailable: vi.fn().mockResolvedValue(true),
    checkEnvironment: vi.fn().mockResolvedValue({
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    }),
    detectClaude: vi.fn().mockResolvedValue({ found: false }),
    detectOpencode: vi.fn().mockImplementation(() => {
      callLog.push('detectOpencode')
      return Promise.resolve({ ...snapshot([]), agentFrameworkId: 'opencode' })
    }),
    detectCodex: vi.fn().mockImplementation(() => {
      callLog.push('detectCodex')
      return Promise.resolve({
        ...snapshot([]),
        agentFrameworkId: 'codex',
        codex: { resolvedPath: '/bin/codex-acp', version: '1.1.4' }
      })
    }),
    detectCodeBuddy: vi.fn().mockImplementation(() => {
      callLog.push('detectCodeBuddy')
      return Promise.resolve({
        ...snapshot([]),
        agentFrameworkId: 'codebuddy',
        codebuddy: { resolvedPath: '/bin/codebuddy', version: '2.138.0' }
      })
    }),
    installClaude: vi.fn().mockResolvedValue({ installId: 'claude-1', ok: true }),
    installOpencode: vi.fn().mockResolvedValue({ installId: 'opencode-1', ok: true }),
    installCodex: vi.fn().mockResolvedValue({ installId: 'codex-1', ok: true }),
    installCodeBuddy: vi.fn().mockResolvedValue({ installId: 'codebuddy-1', ok: true }),
    uninstallCodeBuddy: vi.fn().mockResolvedValue(snapshot([])),
    uninstallCodex: vi.fn().mockResolvedValue(snapshot([])),
    onInstallLog: vi.fn().mockReturnValue(vi.fn()),
    setAgentFramework: vi.fn().mockImplementation((request: { id: string }) => {
      callLog.push(`setFramework:${request.id}`)
      return Promise.resolve({ ...snapshot([]), agentFrameworkId: request.id })
    }),
    setReasoningEffort: vi
      .fn()
      .mockImplementation((request: { effort: string }) =>
        Promise.resolve({ ...snapshot([]), reasoningEffort: request.effort })
      ),
    setSessionDetailsModel: vi
      .fn()
      .mockImplementation((request: { configuration: SettingsSnapshot['sessionDetailsModel'] }) =>
        Promise.resolve({ ...snapshot([]), sessionDetailsModel: request.configuration })
      ),
    setNotificationsEnabled: vi
      .fn()
      .mockImplementation((request: { enabled: boolean }) =>
        Promise.resolve({ ...snapshot([]), notificationsEnabled: request.enabled })
      ),
    setConversationSkillImportEnabled: vi
      .fn()
      .mockImplementation((request: { enabled: boolean }) =>
        Promise.resolve({ ...snapshot([]), conversationSkillImportEnabled: request.enabled })
      ),
    setClosePreference: vi
      .fn()
      .mockImplementation((request: { preference?: 'minimize' | 'quit' }) =>
        Promise.resolve({ ...snapshot([]), closePreference: request.preference })
      ),
    setProjectFilesFilter: vi
      .fn()
      .mockImplementation((request: { filter?: SettingsSnapshot['projectFilesFilter'] }) =>
        Promise.resolve({ ...snapshot([]), projectFilesFilter: request.filter })
      ),
    setAppIconVariant: vi
      .fn()
      .mockImplementation((request: { variant: 'light' | 'dark' }) =>
        Promise.resolve({ ...snapshot([]), appIconVariant: request.variant })
      ),
    setDefaultPermissionProfile: vi
      .fn()
      .mockImplementation((request: { profile: 'ask' | 'auto' | 'full' }) =>
        Promise.resolve({ ...snapshot([]), defaultPermissionProfile: request.profile })
      ),
    upsertProvider: vi.fn(),
    validateProvider: vi.fn(),
    cancelCodexLogin: vi.fn().mockResolvedValue(undefined),
    loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    logoutIsolatedCodex: vi.fn().mockResolvedValue(snapshot([])),
    cancelClaudeLogin: vi.fn().mockResolvedValue(undefined),
    loginSharedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    logoutSharedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    cancelIsolatedClaudeLogin: vi.fn().mockResolvedValue(undefined),
    logoutIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    refreshProviderModels: vi.fn(),
    setActiveProvider: vi.fn().mockImplementation((request: { id: string }) => {
      callLog.push(`setActive:${request.id}`)
      return Promise.resolve({ ...snapshot([]), activeProviderId: request.id })
    }),
    deleteProvider: vi.fn(),
    markOnboardingComplete: vi
      .fn()
      .mockResolvedValue({ ...snapshot([]), onboardingCompletedAt: 4242 }),
    listSkills: vi.fn().mockResolvedValue([]),
    onSkillCatalogChanged: vi.fn(() => vi.fn()),
    setSkillEnabled: vi.fn().mockResolvedValue([]),
    createSkill: vi.fn().mockResolvedValue([]),
    updateSkill: vi.fn().mockResolvedValue([]),
    deleteSkill: vi.fn().mockResolvedValue([]),
    importSkillZip: vi.fn().mockResolvedValue({ status: 'imported', id: 'z', skills: [] }),
    importSkillZipBatch: vi.fn().mockResolvedValue({ results: [], skills: [] }),
    previewSkillZip: vi.fn().mockResolvedValue({ previews: [], skipped: [] }),
    previewGitHubSkill: vi.fn(),
    previewAgentHomeSkill: vi.fn(),
    listConnectors: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    onConnectorRuntimeChanged: vi.fn(() => vi.fn()),
    getConnectorDetail: vi.fn(),
    setConnectorEnabled: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    setConnectorAutoAllow: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    setToolPermission: vi.fn(),
    setNcbiCredentials: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    addCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    authenticateCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
    setCustomServerEnabled: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    removeCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    updateCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    respondConnectorApproval: vi.fn().mockResolvedValue(undefined)
  }
  acp = {
    getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
    cancel: vi.fn().mockImplementation((request: { sessionId: string }) => {
      callLog.push(`cancel:${request.sessionId}`)
      return Promise.resolve({})
    })
  }
  ;(globalThis as { window?: unknown }).window = { api: { settings: api, acp } }
  useSettingsStore.getState().clearSettingsWriteError()
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('settings store: saveAndActivateProvider', () => {
  it('creates, validates, then activates a new provider on success', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({ ok: true, category: 'ok' } as ValidateProviderResult)
    api.setActiveProvider.mockResolvedValue({
      ...snapshot([providerView('p_new')]),
      activeProviderId: 'p_new'
    })

    const result = await useSettingsStore.getState().saveAndActivateProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      model: 'model-a',
      key: 'k'
    })

    expect(result).toEqual({ providerId: 'p_new', validation: { ok: true, category: 'ok' } })
    expect(api.validateProvider).toHaveBeenCalledWith({ providerId: 'p_new', model: 'model-a' })
    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p_new', model: 'model-a' })
    expect(useSettingsStore.getState().activeProviderId).toBe('p_new')
  })

  it('activates even when validation fails (probe is advisory, not a gate)', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'network'
    } as ValidateProviderResult)

    const result = await useSettingsStore.getState().saveAndActivateProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result.validation.ok).toBe(false)
    // A failed probe no longer blocks activation — the provider is configured in and can be tested
    // live; it is still kept (flagged as unverified), not rolled back.
    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p_new', model: undefined })
    expect(api.deleteProvider).not.toHaveBeenCalled()
  })

  it('resolves the edited id directly instead of diffing', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_existing')]))
    api.validateProvider.mockResolvedValue({ ok: true, category: 'ok' } as ValidateProviderResult)

    const { providerId } = await useSettingsStore
      .getState()
      .saveProvider({ id: 'p_existing', type: 'custom', name: 'Renamed' })

    expect(providerId).toBe('p_existing')
    expect(api.validateProvider).toHaveBeenCalledWith({ providerId: 'p_existing' })
  })
})

describe('settings store: persistProvider', () => {
  it('persists a new provider and returns its id without testing it', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))

    const providerId = await useSettingsStore.getState().persistProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(providerId).toBe('p_new')
    // Persisting does not run the connection test — the Settings page tests in the background.
    expect(api.validateProvider).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })

  it('returns the fixed Codex provider id when the built-in already exists', async () => {
    const builtIn = {
      ...providerView(CODEX_SUBSCRIPTION_PROVIDER_ID),
      type: 'codex-shared' as const,
      name: 'Codex subscription',
      model: undefined,
      models: [],
      hasKey: false
    }
    useSettingsStore.setState({ providers: [builtIn] })
    api.upsertProvider.mockResolvedValue(snapshot([builtIn]))

    await expect(
      useSettingsStore.getState().persistProvider({
        id: 'ordinary-provider-being-edited',
        type: 'codex-shared',
        name: 'ignored',
        apiEndpoints: ['responses']
      })
    ).resolves.toBe(CODEX_SUBSCRIPTION_PROVIDER_ID)
  })
})

describe('settings store: saveProvider keeps a provider whose test fails', () => {
  it('does not delete a new provider when validation fails, and refreshes to surface the failure', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)
    // The post-validate refresh returns the persisted provider (now carrying the recorded failure).
    api.getSettings.mockResolvedValue(snapshot([providerView('p_new')]))

    const result = await useSettingsStore.getState().saveProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result.validation.ok).toBe(false)
    expect(result.providerId).toBe('p_new')
    expect(api.deleteProvider).not.toHaveBeenCalled()
    // The kept provider stays in the renderer cache after the refresh.
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })

  it('keeps an existing provider when an edit fails validation', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_existing')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)
    api.getSettings.mockResolvedValue(snapshot([providerView('p_existing')]))

    const result = await useSettingsStore
      .getState()
      .saveProvider({ id: 'p_existing', type: 'custom', name: 'Renamed' })

    expect(result.validation.ok).toBe(false)
    expect(result.providerId).toBe('p_existing')
    expect(api.deleteProvider).not.toHaveBeenCalled()
  })
})

describe('settings store: loginIsolatedCodex', () => {
  it('returns the sign-in outcome and refreshes the snapshot so the result lands on the card', async () => {
    api.loginIsolatedCodex.mockResolvedValue({
      ok: false,
      category: 'auth',
      message: 'Codex sign-in was cancelled.'
    } as ValidateProviderResult)
    api.getSettings.mockResolvedValue(snapshot([providerView('p_codex')]))

    const result = await useSettingsStore.getState().loginIsolatedCodex()

    expect(result).toMatchObject({ ok: false, category: 'auth' })
    expect(api.getSettings).toHaveBeenCalled()
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })
})

describe('settings store: Claude authentication', () => {
  it.each([
    ['loginSharedClaude', 'loginSharedClaude'],
    ['loginIsolatedClaudeBrowser', 'loginIsolatedClaudeBrowser'],
    ['logoutSharedClaude', 'logoutSharedClaude'],
    ['logoutIsolatedClaude', 'logoutIsolatedClaude']
  ] as const)('%s refreshes settings and preflight', async (storeMethod, apiMethod) => {
    api.getSettings.mockResolvedValue(snapshot([providerView('claude-provider')]))

    await useSettingsStore.getState()[storeMethod]()

    expect(api[apiMethod]).toHaveBeenCalledOnce()
    expect(api.getSettings).toHaveBeenCalledOnce()
    expect(api.getPreflight).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })

  it('forwards a pasted token and refreshes settings and preflight', async () => {
    api.getSettings.mockResolvedValue(snapshot([providerView('builtin-claude-isolated')]))

    await useSettingsStore.getState().loginIsolatedClaude('sk-ant-test')

    expect(api.loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-test')
    expect(api.getSettings).toHaveBeenCalledOnce()
    expect(api.getPreflight).toHaveBeenCalledOnce()
  })
})

describe('settings store: detectClaude refreshes npm', () => {
  it('re-checks npm availability so a mid-onboarding Node.js install is picked up', async () => {
    // Start from the "npm missing" state a genuine first run without Node.js would have.
    useSettingsStore.setState({ npmAvailable: false })
    api.isNpmAvailable.mockResolvedValue(true)

    await useSettingsStore.getState().detectClaude()

    expect(api.isNpmAvailable).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().npmAvailable).toBe(true)
  })
})

describe('settings store: environment check', () => {
  it('caches the launch inspection and refreshes preflight after detection', async () => {
    api.getSettings.mockResolvedValue({
      ...snapshot([]),
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    const result = await useSettingsStore.getState().checkEnvironment()

    expect(result?.ready).toBe(true)
    expect(useSettingsStore.getState().environmentCheck?.platform).toBe('darwin')
    expect(useSettingsStore.getState().claude.resolvedPath).toBe('/bin/claude')
    expect(api.getPreflight).toHaveBeenCalled()
  })

  it('deduplicates concurrent launch checks', async () => {
    let resolveCheck: ((value: EnvironmentCheckResult) => void) | undefined
    api.checkEnvironment.mockImplementation(
      () =>
        new Promise<EnvironmentCheckResult>((resolve) => {
          resolveCheck = resolve
        })
    )

    const first = useSettingsStore.getState().checkEnvironment()
    const second = useSettingsStore.getState().checkEnvironment()

    expect(api.checkEnvironment).toHaveBeenCalledTimes(1)
    expect(await second).toBeUndefined()

    resolveCheck?.({
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    })
    await first
  })

  it('starts a fresh same-framework check when the caller must observe a completed repair', async () => {
    const staleResult: EnvironmentCheckResult = {
      checkedAt: 10,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [
        {
          id: 'agent',
          label: 'Claude runtime',
          status: 'failed',
          summary: 'Claude is missing.'
        }
      ],
      ready: false,
      canAutoInstall: true,
      agentFrameworkId: 'claude-code',
      runtime: { found: false }
    }
    const repairedResult: EnvironmentCheckResult = {
      ...staleResult,
      checkedAt: 20,
      checks: [],
      ready: true,
      canAutoInstall: false,
      runtime: { found: true, path: '/bin/claude' }
    }
    const resolvers: Array<(value: EnvironmentCheckResult) => void> = []
    api.checkEnvironment.mockImplementation(
      () => new Promise<EnvironmentCheckResult>((resolve) => resolvers.push(resolve))
    )

    const staleCheck = useSettingsStore.getState().checkEnvironment()
    const repairCheck = useSettingsStore.getState().checkEnvironment({ force: true })

    expect(api.checkEnvironment).toHaveBeenCalledTimes(2)

    resolvers[1]?.(repairedResult)
    await repairCheck
    resolvers[0]?.(staleResult)
    await staleCheck

    expect(useSettingsStore.getState().environmentCheck?.checkedAt).toBe(20)
    expect(useSettingsStore.getState().environmentCheck?.ready).toBe(true)
  })

  it('re-issues the check when the framework auto-switches mid-flight and does not stick on the stale result', async () => {
    const claudeResult: EnvironmentCheckResult = {
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: false }
    }
    const opencodeResult: EnvironmentCheckResult = {
      ...claudeResult,
      agentFrameworkId: 'opencode',
      runtime: { found: true, path: '/bin/opencode' }
    }

    // Each launch check gets its own controllable promise, resolved in the order the store issued them.
    const resolvers: Array<(value: EnvironmentCheckResult) => void> = []
    api.checkEnvironment.mockImplementation(
      () => new Promise<EnvironmentCheckResult>((resolve) => resolvers.push(resolve))
    )
    // After the auto-switch, main reports OpenCode as the persisted framework.
    api.getSettings.mockResolvedValue({ ...snapshot([]), agentFrameworkId: 'opencode' })
    api.getPreflight.mockResolvedValue({
      claudeReady: false,
      opencodeReady: true,
      activeProviderReady: true
    })

    // A: the initial launch check, issued for the default framework (claude-code).
    const first = useSettingsStore.getState().checkEnvironment()
    expect(api.checkEnvironment).toHaveBeenCalledTimes(1)

    // The prefer-installed auto-switch selects OpenCode and re-checks while A is still in flight.
    useSettingsStore.setState({ agentFrameworkId: 'opencode' })
    const second = useSettingsStore.getState().checkEnvironment()
    // The second call is NOT swallowed by the in-flight guard: a different framework re-probes.
    expect(api.checkEnvironment).toHaveBeenCalledTimes(2)

    // A (Claude) resolves first; its result belongs to the previous selection and must be discarded.
    resolvers[0]?.(claudeResult)
    await first
    expect(useSettingsStore.getState().environmentCheck?.agentFrameworkId).not.toBe('claude-code')

    // B (OpenCode) resolves and becomes the visible result.
    resolvers[1]?.(opencodeResult)
    await second

    const state = useSettingsStore.getState()
    expect(state.environmentCheck?.agentFrameworkId).toBe('opencode')
    expect(state.environmentCheck?.ready).toBe(true)
    expect(state.isCheckingEnvironment).toBe(false)

    // The wizard's Continue predicate ends up enabled (ready, matching framework, no re-check pending),
    // instead of being stuck disabled on a Claude result while OpenCode is selected.
    const environmentReady =
      !state.isCheckingEnvironment &&
      state.environmentCheck?.ready === true &&
      state.environmentCheck.agentFrameworkId === state.agentFrameworkId
    expect(environmentReady).toBe(true)
  })

  it('ABA: a late stale same-framework success does not overwrite the newer result', async () => {
    // A and C are both claude-code (B is the opencode detour), so a framework-only staleness check
    // would wrongly treat A's late result as current. checkedAt distinguishes the two claude passes.
    const claudeA: EnvironmentCheckResult = {
      checkedAt: 10,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    }
    const claudeC: EnvironmentCheckResult = { ...claudeA, checkedAt: 30 }

    // Each check gets its own deferred, resolved in the order the test chooses.
    const deferred: Array<{
      resolve: (value: EnvironmentCheckResult) => void
      reject: (error: unknown) => void
    }> = []
    api.checkEnvironment.mockImplementation(
      () =>
        new Promise<EnvironmentCheckResult>((resolve, reject) => {
          deferred.push({ resolve, reject })
        })
    )

    // A (claude-code), auto-switch to opencode + B, auto-switch back to claude-code + C.
    const first = useSettingsStore.getState().checkEnvironment()
    useSettingsStore.setState({ agentFrameworkId: 'opencode' })
    const second = useSettingsStore.getState().checkEnvironment()
    useSettingsStore.setState({ agentFrameworkId: 'claude-code' })
    const third = useSettingsStore.getState().checkEnvironment()
    expect(api.checkEnvironment).toHaveBeenCalledTimes(3)

    // C resolves and becomes the visible result.
    deferred[2].resolve(claudeC)
    await third
    expect(useSettingsStore.getState().environmentCheck?.checkedAt).toBe(30)

    // A resolves LAST with a success that shares C's framework id; the generation guard discards it.
    deferred[0].resolve(claudeA)
    await first
    // B resolves too; also stale, also discarded.
    deferred[1].resolve({ ...claudeC, agentFrameworkId: 'opencode' })
    await second

    const state = useSettingsStore.getState()
    // C's result stands; A did not overwrite it despite sharing the framework id.
    expect(state.environmentCheck?.checkedAt).toBe(30)
    expect(state.environmentCheck?.agentFrameworkId).toBe('claude-code')
    expect(state.environmentCheckError).toBeUndefined()
    expect(state.isCheckingEnvironment).toBe(false)

    const environmentReady =
      !state.isCheckingEnvironment &&
      state.environmentCheck?.ready === true &&
      state.environmentCheck.agentFrameworkId === state.agentFrameworkId
    expect(environmentReady).toBe(true)
  })

  it('ABA: a stale same-framework failure neither clears the newer loading nor overwrites its success with an error', async () => {
    const claudeC: EnvironmentCheckResult = {
      checkedAt: 30,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    }

    const deferred: Array<{
      resolve: (value: EnvironmentCheckResult) => void
      reject: (error: unknown) => void
    }> = []
    api.checkEnvironment.mockImplementation(
      () =>
        new Promise<EnvironmentCheckResult>((resolve, reject) => {
          deferred.push({ resolve, reject })
        })
    )

    // A (claude-code), opencode + B, back to claude-code + C — all in flight.
    const first = useSettingsStore.getState().checkEnvironment()
    useSettingsStore.setState({ agentFrameworkId: 'opencode' })
    const second = useSettingsStore.getState().checkEnvironment()
    useSettingsStore.setState({ agentFrameworkId: 'claude-code' })
    const third = useSettingsStore.getState().checkEnvironment()

    // A (the oldest pass) rejects while C is still running. Its finally must NOT clear C's loading,
    // and its catch must NOT write environmentCheckError, because a newer generation now owns state.
    deferred[0].reject(new Error('stale claude A failed'))
    await first

    let state = useSettingsStore.getState()
    expect(state.isCheckingEnvironment).toBe(true)
    expect(state.environmentCheckError).toBeUndefined()

    // C then completes successfully and owns the visible state.
    deferred[2].resolve(claudeC)
    await third
    // B resolves late and is discarded.
    deferred[1].resolve({ ...claudeC, agentFrameworkId: 'opencode' })
    await second

    state = useSettingsStore.getState()
    expect(state.environmentCheck?.checkedAt).toBe(30)
    expect(state.environmentCheck?.agentFrameworkId).toBe('claude-code')
    // A's rejection never polluted C's success.
    expect(state.environmentCheckError).toBeUndefined()
    expect(state.isCheckingEnvironment).toBe(false)

    const environmentReady =
      !state.isCheckingEnvironment &&
      state.environmentCheck?.ready === true &&
      state.environmentCheck.agentFrameworkId === state.agentFrameworkId
    expect(environmentReady).toBe(true)
  })

  it('surfaces a failed main-process inspection and always clears loading state', async () => {
    api.checkEnvironment.mockRejectedValue(new Error('environment IPC unavailable'))

    const result = await useSettingsStore.getState().checkEnvironment()

    expect(result).toBeUndefined()
    expect(useSettingsStore.getState()).toMatchObject({
      isCheckingEnvironment: false,
      isDetectingClaude: false,
      environmentCheckError: 'environment IPC unavailable'
    })
  })
})

describe('settings store: onboarding completion', () => {
  it('completeOnboarding persists the marker and caches it locally', async () => {
    await useSettingsStore.getState().completeOnboarding()

    expect(api.markOnboardingComplete).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().onboardingCompletedAt).toBe(4242)
  })

  it('applySnapshot-driven load caches onboardingCompletedAt', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), onboardingCompletedAt: 999 })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().onboardingCompletedAt).toBe(999)
  })

  it('caches the normalized default permission profile', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), defaultPermissionProfile: 'auto' })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().defaultPermissionProfile).toBe('auto')
  })
})

describe('settings store: startup loading', () => {
  it('defaults secure storage to unavailable until the capability probe succeeds', () => {
    expect(useSettingsStore.getState().encryptionAvailable).toBe(false)
  })

  it('publishes the settings snapshot before startup probes finish', async () => {
    let resolvePreflight:
      ((value: { claudeReady: boolean; activeProviderReady: boolean }) => void) | undefined
    api.getPreflight.mockReturnValue(
      new Promise((resolve) => {
        resolvePreflight = resolve
      })
    )

    const loading = useSettingsStore.getState().load()
    await vi.waitFor(() => expect(useSettingsStore.getState().isLoaded).toBe(true))

    expect(useSettingsStore.getState()).toMatchObject({
      isLoaded: true,
      isLoading: true,
      loadError: undefined
    })

    resolvePreflight?.({ claudeReady: true, activeProviderReady: true })
    await expect(loading).resolves.toBe(true)
  })

  it('deduplicates concurrent StrictMode startup loads', async () => {
    let resolveSettings: ((value: SettingsSnapshot) => void) | undefined
    api.getSettings.mockReturnValue(
      new Promise<SettingsSnapshot>((resolve) => {
        resolveSettings = resolve
      })
    )

    const first = useSettingsStore.getState().load()
    const duplicate = useSettingsStore.getState().load()

    expect(duplicate).toBe(first)
    expect(api.getSettings).toHaveBeenCalledOnce()
    expect(api.getPreflight).toHaveBeenCalledOnce()
    expect(api.isEncryptionAvailable).toHaveBeenCalledOnce()
    expect(api.isNpmAvailable).toHaveBeenCalledOnce()

    resolveSettings?.({ ...snapshot([]), onboardingCompletedAt: 111 })

    await expect(first).resolves.toBe(true)
    await expect(duplicate).resolves.toBe(true)
    expect(useSettingsStore.getState()).toMatchObject({
      onboardingCompletedAt: 111,
      isLoaded: true,
      isLoading: false,
      loadError: undefined
    })
  })

  it('rechecks secure storage without rerunning startup-only runtime probes', async () => {
    api.getSettings
      .mockResolvedValueOnce({ ...snapshot([]), onboardingCompletedAt: 111 })
      .mockResolvedValueOnce({ ...snapshot([]), onboardingCompletedAt: 222 })
    api.isEncryptionAvailable.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await useSettingsStore.getState().load()
    await useSettingsStore.getState().load()

    expect(api.getSettings).toHaveBeenCalledTimes(2)
    expect(api.getPreflight).toHaveBeenCalledOnce()
    expect(api.isEncryptionAvailable).toHaveBeenCalledTimes(2)
    expect(api.isNpmAvailable).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState()).toMatchObject({
      onboardingCompletedAt: 222,
      encryptionAvailable: true
    })
  })

  it('keeps startup blocked after a Settings authority failure and recovers on retry', async () => {
    const rawError = new Error(
      'EACCES: /Users/private/.open-science/settings.json could not be read'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.getSettings.mockRejectedValueOnce(rawError)

    await expect(useSettingsStore.getState().load()).resolves.toBe(false)
    expect(useSettingsStore.getState()).toMatchObject({
      isLoaded: false,
      isLoading: false,
      loadError: 'Open Science could not load settings. Retry to continue.'
    })
    expect(useSettingsStore.getState().loadError).not.toContain('/Users/private')
    expect(warn).toHaveBeenCalledWith('Settings loading failed', rawError)

    await expect(useSettingsStore.getState().load()).resolves.toBe(true)
    expect(useSettingsStore.getState()).toMatchObject({
      isLoaded: true,
      isLoading: false,
      loadError: undefined
    })
  })

  it('keeps valid Settings available when a runtime probe fails', async () => {
    const rawError = new Error('runtime probe unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.getPreflight.mockRejectedValueOnce(rawError)
    api.isEncryptionAvailable.mockResolvedValueOnce(false)

    await expect(useSettingsStore.getState().load()).resolves.toBe(true)

    expect(useSettingsStore.getState()).toMatchObject({
      isLoaded: true,
      isLoading: false,
      loadError: undefined,
      encryptionAvailable: false
    })
    expect(warn).toHaveBeenCalledWith('Settings loading failed', rawError)
  })

  it('keeps the newest retry result when an older load finishes later', async () => {
    let resolveFirst: ((value: SettingsSnapshot) => void) | undefined
    let resolveSecond: ((value: SettingsSnapshot) => void) | undefined
    api.getSettings
      .mockReturnValueOnce(
        new Promise<SettingsSnapshot>((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise<SettingsSnapshot>((resolve) => {
          resolveSecond = resolve
        })
      )

    const first = useSettingsStore.getState().load()
    const second = useSettingsStore.getState().load({ force: true })

    resolveSecond?.({ ...snapshot([]), onboardingCompletedAt: 222 })
    await second
    resolveFirst?.({ ...snapshot([]), onboardingCompletedAt: 111 })
    await first

    expect(useSettingsStore.getState()).toMatchObject({
      onboardingCompletedAt: 222,
      isLoaded: true,
      isLoading: false,
      loadError: undefined
    })
  })
})

describe('settings store: provider/model selection', () => {
  it('passes the chosen model to the IPC and caches activeModel', async () => {
    api.setActiveProvider.mockResolvedValue({
      ...snapshot([providerView('p1')]),
      activeProviderId: 'p1',
      activeModel: 'glm-4.7'
    })

    await useSettingsStore.getState().setActiveProvider('p1', 'glm-4.7')

    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p1', model: 'glm-4.7' })
    expect(useSettingsStore.getState().activeModel).toBe('glm-4.7')
  })

  it('treats an empty model as "no specific model" (provider default)', async () => {
    api.setActiveProvider.mockResolvedValue(snapshot([providerView('p1')]))

    await useSettingsStore.getState().setActiveProvider('p1', '')

    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p1', model: undefined })
  })

  it('clears an existing preference write error after the active provider saves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setReasoningEffort.mockRejectedValueOnce(new Error('reasoning unavailable'))

    await useSettingsStore.getState().setReasoningEffort('high')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save reasoning effort. Try again.'
    )

    await useSettingsStore.getState().setActiveProvider('p1', 'glm-4.7')

    expect(useSettingsStore.getState().settingsWriteError).toBeUndefined()
  })

  it('records a safe write error and preserves rejection semantics when activation fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ipcError = new Error('/Users/example/.open-science/settings.json is unavailable')
    api.setActiveProvider.mockRejectedValueOnce(ipcError)

    await expect(useSettingsStore.getState().setActiveProvider('p1', 'glm-4.7')).rejects.toBe(
      ipcError
    )

    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not switch active provider or model. Try again.'
    )
    expect(useSettingsStore.getState().settingsWriteError).not.toContain('/Users/example')
    expect(consoleError).toHaveBeenCalledWith('Failed to set active provider', ipcError)
  })
})

describe('selectProviderModelOptions', () => {
  it('exposes only the preferred Claude subscription mode when both records exist', () => {
    const options = selectProviderModelOptions(
      [
        {
          id: 'builtin-claude-shared',
          type: 'claude-shared',
          name: 'Claude subscription',
          models: [],
          supportsImageInput: false,
          hasKey: false,
          needsKey: false
        },
        {
          id: 'builtin-claude-isolated',
          type: 'claude-isolated',
          name: 'Claude subscription',
          models: [],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      undefined,
      'builtin-claude-isolated'
    )

    expect(options).toEqual([
      {
        providerId: 'builtin-claude-isolated',
        providerName: 'Claude subscription',
        providerType: 'claude-isolated',
        model: ''
      }
    ])
  })

  it('emits one option per catalog model for an official provider', () => {
    const options = selectProviderModelOptions([
      {
        id: 'off',
        type: 'official',
        name: 'GLM',
        vendorId: 'zhipu',
        models: ['glm-5.2', 'glm-4.7'],
        supportsImageInput: false,
        hasKey: true,
        needsKey: false
      }
    ])

    expect(options).toEqual([
      {
        providerId: 'off',
        providerName: 'GLM',
        providerType: 'official',
        vendorId: 'zhipu',
        model: 'glm-5.2'
      },
      {
        providerId: 'off',
        providerName: 'GLM',
        providerType: 'official',
        vendorId: 'zhipu',
        model: 'glm-4.7'
      }
    ])
  })

  it('emits one option for a custom provider and a default entry for a modelless provider', () => {
    const options = selectProviderModelOptions([
      {
        id: 'c',
        type: 'custom',
        name: 'GW',
        model: 'm',
        models: ['m'],
        supportsImageInput: false,
        hasKey: true,
        needsKey: false
      },
      {
        id: 'local',
        type: 'custom',
        name: 'Local',
        model: undefined,
        models: [],
        supportsImageInput: false,
        hasKey: false,
        needsKey: false
      }
    ])

    expect(options).toEqual([
      { providerId: 'c', providerName: 'GW', providerType: 'custom', model: 'm' },
      // A provider with no concrete model still yields one selectable "default" entry (empty model).
      { providerId: 'local', providerName: 'Local', providerType: 'custom', model: '' }
    ])
  })

  it('excludes a provider whose last test failed so it cannot be selected as a model source', () => {
    const options = selectProviderModelOptions([
      {
        id: 'ok',
        type: 'custom',
        name: 'Good',
        model: 'm',
        models: ['m'],
        supportsImageInput: false,
        hasKey: true,
        needsKey: false,
        lastValidatedAt: 200
      },
      {
        id: 'bad',
        type: 'custom',
        name: 'Broken',
        model: 'm',
        models: ['m'],
        supportsImageInput: false,
        hasKey: true,
        needsKey: false,
        lastValidationFailure: { at: 300, category: 'auth' }
      }
    ])

    expect(options).toEqual([
      { providerId: 'ok', providerName: 'Good', providerType: 'custom', model: 'm' }
    ])
  })
})

describe('settings store: refreshProviderModels', () => {
  it('refreshes the cache from the snapshot when the vendor fetch succeeds', async () => {
    api.refreshProviderModels.mockResolvedValue({ ok: true, category: 'ok', models: ['m1', 'm2'] })
    api.getSettings.mockResolvedValue(snapshot([providerView('p1')]))

    const result = await useSettingsStore.getState().refreshProviderModels('p1')

    expect(result.ok).toBe(true)
    expect(api.refreshProviderModels).toHaveBeenCalledWith({ providerId: 'p1' })
    expect(useSettingsStore.getState().providers.map((p) => p.id)).toEqual(['p1'])
  })

  it('leaves the cache untouched when the fetch fails', async () => {
    api.refreshProviderModels.mockResolvedValue({ ok: false, category: 'auth', message: 'nope' })

    const result = await useSettingsStore.getState().refreshProviderModels('p1')

    expect(result.ok).toBe(false)
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('loads skills and toggles optimistically', async () => {
    api.listSkills.mockResolvedValue([
      {
        id: 'demo',
        name: 'Demo',
        description: '',
        source: 'featured',
        updatedAt: '',
        enabled: true
      }
    ])
    api.setSkillEnabled.mockResolvedValue([
      {
        id: 'demo',
        name: 'Demo',
        description: '',
        source: 'featured',
        updatedAt: '',
        enabled: false
      }
    ])

    await useSettingsStore.getState().loadSkills()
    expect(useSettingsStore.getState().skills[0].enabled).toBe(true)

    await useSettingsStore.getState().setSkillEnabled('demo', false)
    expect(api.setSkillEnabled).toHaveBeenCalledWith({ id: 'demo', enabled: false })
    expect(useSettingsStore.getState().skills[0].enabled).toBe(false)
  })

  it('reconciles create, update, and delete from each authoritative catalog', async () => {
    const created = skillView('personal-demo', 'Demo')
    const updated = skillView('personal-demo', 'Updated demo')
    api.createSkill.mockResolvedValue([created])
    api.updateSkill.mockResolvedValue([updated])
    api.deleteSkill.mockResolvedValue([])

    await useSettingsStore.getState().createSkill({ name: 'Demo', description: '', body: '# Demo' })
    expect(useSettingsStore.getState().skills).toEqual([created])

    await useSettingsStore
      .getState()
      .updateSkill({ id: created.id, description: '', body: '# Demo' })
    expect(useSettingsStore.getState().skills).toEqual([updated])

    await useSettingsStore.getState().deleteSkill(created.id)
    expect(api.deleteSkill).toHaveBeenCalledWith({ id: created.id })
    expect(useSettingsStore.getState().skills).toEqual([])
  })
})

describe('settings store: openSettingsToSkill', () => {
  it('opens the dialog on a skill; consume and close both clear the pending intent', () => {
    useSettingsStore.getState().openSettingsToSkill('x')
    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
      panel: 'skills',
      view: { kind: 'detail', id: 'x' }
    })

    const requestId = useSettingsStore.getState().pendingSettingsIntent!.requestId
    useSettingsStore.getState().consumePendingSettingsIntent(requestId)
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()

    // Closing after a fresh open-to-skill clears the intent so a later open starts fresh.
    useSettingsStore.getState().openSettingsToSkill('y')
    useSettingsStore.getState().closeSettings()
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })
})

describe('settings store: openSettingsToSpecialist', () => {
  it('opens the dialog on a specialist; consume and close both clear the pending intent', () => {
    useSettingsStore.getState().openSettingsToSpecialist('spc-1')
    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
      panel: 'specialists',
      view: { kind: 'edit', id: 'spc-1' }
    })

    const requestId = useSettingsStore.getState().pendingSettingsIntent!.requestId
    useSettingsStore.getState().consumePendingSettingsIntent(requestId)
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()

    // Closing after a fresh open-to-specialist clears the intent so a later open starts fresh.
    useSettingsStore.getState().openSettingsToSpecialist('spc-2')
    useSettingsStore.getState().closeSettings()
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })
})

describe('settings store: openSettingsToPanel', () => {
  it('opens the requested panel and clears an unconsumed target on close', () => {
    useSettingsStore.getState().openSettingsToPanel('storage')
    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({ panel: 'storage' })

    useSettingsStore.getState().closeSettings()
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })

  it('routes Compute through the panel target and consumes it exactly once', () => {
    useSettingsStore.getState().openSettingsToSkill('stale-skill')
    useSettingsStore.getState().openSettingsToCompute()

    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
      panel: 'compute',
      view: { kind: 'list' }
    })

    const requestId = useSettingsStore.getState().pendingSettingsIntent!.requestId
    useSettingsStore.getState().consumePendingSettingsIntent(requestId)
    useSettingsStore.getState().openSettings()
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })
})

describe('settings store: skill import candidate previews', () => {
  it('forwards renderer-safe GitHub and installed candidate identities', async () => {
    const preview = {
      name: 'Alpha',
      description: 'Preview',
      sourceLabel: 'source/alpha',
      metadata: {},
      body: '# Alpha',
      files: ['SKILL.md']
    }
    api.previewGitHubSkill.mockResolvedValue(preview)
    api.previewAgentHomeSkill.mockResolvedValue(preview)

    await expect(
      useSettingsStore
        .getState()
        .previewGitHubSkill('https://github.com/acme/skills/tree/main/alpha')
    ).resolves.toBe(preview)
    await expect(
      useSettingsStore.getState().previewAgentHomeSkill({ source: 'agents', slug: 'alpha' })
    ).resolves.toBe(preview)

    expect(api.previewGitHubSkill).toHaveBeenCalledWith({
      url: 'https://github.com/acme/skills/tree/main/alpha'
    })
    expect(api.previewAgentHomeSkill).toHaveBeenCalledWith({ source: 'agents', slug: 'alpha' })
  })
})

describe('settings store: skill bundle upload', () => {
  it('previewSkillZip returns the importable previews plus any skipped skills', async () => {
    api.previewSkillZip.mockResolvedValue({
      previews: [
        {
          subPath: 'skills/alpha',
          name: 'Alpha',
          description: '',
          metadata: {},
          body: '# Alpha',
          files: ['SKILL.md'],
          alreadyImported: false
        },
        {
          subPath: 'skills/beta',
          name: 'Beta',
          description: '',
          metadata: {},
          body: '# Beta',
          files: ['SKILL.md'],
          alreadyImported: true
        }
      ],
      skipped: [{ source: 'oversized.zip', reason: 'too large (limit 8 MB)' }]
    })

    const { previews, skipped } = await useSettingsStore.getState().previewSkillZip('YmFzZTY0')

    expect(api.previewSkillZip).toHaveBeenCalledWith({ dataBase64: 'YmFzZTY0' })
    expect(previews.map((preview) => preview.name)).toEqual(['Alpha', 'Beta'])
    expect(skipped).toEqual([{ source: 'oversized.zip', reason: 'too large (limit 8 MB)' }])
  })

  it('importSkillZipBatch forwards every item and reconciles the skill list once', async () => {
    api.importSkillZipBatch.mockResolvedValue({
      results: [
        { subPath: 'skills/alpha', status: 'imported', id: 'imported-alpha' },
        { subPath: 'skills/beta', status: 'unchanged', id: 'imported-beta' }
      ],
      skills: [
        {
          id: 'imported-alpha',
          name: 'Alpha',
          description: '',
          source: 'imported',
          updatedAt: '',
          enabled: true
        }
      ]
    })

    const result = await useSettingsStore
      .getState()
      .importSkillZipBatch('YmFzZTY0', [{ subPath: 'skills/alpha' }, { subPath: 'skills/beta' }])

    expect(api.importSkillZipBatch).toHaveBeenCalledWith({
      dataBase64: 'YmFzZTY0',
      items: [{ subPath: 'skills/alpha' }, { subPath: 'skills/beta' }]
    })
    expect(result.results).toHaveLength(2)
    expect(useSettingsStore.getState().skills.map((skill) => skill.id)).toEqual(['imported-alpha'])
  })

  it('importSkillZip forwards the subPath/replaceId opts and reconciles the skill list', async () => {
    api.importSkillZip.mockResolvedValue({
      status: 'imported',
      id: 'imported-alpha',
      skills: [
        {
          id: 'imported-alpha',
          name: 'Alpha',
          description: '',
          source: 'imported',
          updatedAt: '',
          enabled: true
        }
      ]
    })

    const result = await useSettingsStore
      .getState()
      .importSkillZip('YmFzZTY0', { subPath: 'skills/alpha', replaceId: 'old-alpha' })

    expect(api.importSkillZip).toHaveBeenCalledWith({
      dataBase64: 'YmFzZTY0',
      subPath: 'skills/alpha',
      replaceId: 'old-alpha'
    })
    expect(result.status).toBe('imported')
    expect(useSettingsStore.getState().skills.map((skill) => skill.id)).toEqual(['imported-alpha'])
  })
})

describe('settings store: connectors slice', () => {
  const connectorView = (id: string, enabled: boolean): ConnectorView => ({
    id,
    name: id,
    displayName: 'PubMed',
    description: '',
    sources: [],
    requiresNcbi: true,
    enabled,
    autoAllow: false,
    group: 'featured'
  })

  it('loadConnectors populates connectors and ncbi from the snapshot', async () => {
    api.listConnectors.mockResolvedValue({
      connectors: [connectorView('pubmed', true)],
      customServers: [],
      ncbi: { contactEmail: 'a@b.com', hasApiKey: true }
    })

    await useSettingsStore.getState().loadConnectors()

    expect(useSettingsStore.getState().connectors[0].id).toBe('pubmed')
    expect(useSettingsStore.getState().ncbi).toEqual({ contactEmail: 'a@b.com', hasApiKey: true })
  })

  it('setConnectorEnabled flips optimistically then reconciles from the returned snapshot', async () => {
    api.listConnectors.mockResolvedValue({
      connectors: [connectorView('pubmed', true)],
      customServers: [],
      ncbi: { hasApiKey: false }
    })
    api.setConnectorEnabled.mockResolvedValue({
      connectors: [connectorView('pubmed', false)],
      customServers: [],
      ncbi: { hasApiKey: false }
    })

    await useSettingsStore.getState().loadConnectors()
    expect(useSettingsStore.getState().connectors[0].enabled).toBe(true)

    await useSettingsStore.getState().setConnectorEnabled('pubmed', false)
    expect(api.setConnectorEnabled).toHaveBeenCalledWith({ id: 'pubmed', enabled: false })
    expect(useSettingsStore.getState().connectors[0].enabled).toBe(false)
  })

  it('rolls back the optimistic Connector value when main rejects the write', async () => {
    useSettingsStore.setState({ connectors: [connectorView('pubmed', true)] })
    api.setConnectorEnabled.mockRejectedValue(new Error('IPC unavailable'))

    await expect(useSettingsStore.getState().setConnectorEnabled('pubmed', false)).rejects.toThrow(
      'IPC unavailable'
    )

    expect(useSettingsStore.getState().connectors[0].enabled).toBe(true)
  })

  it('setNcbiCredentials reconciles the ncbi credential state', async () => {
    api.setNcbiCredentials.mockResolvedValue({
      connectors: [],
      customServers: [],
      ncbi: { contactEmail: 'me@lab.org', hasApiKey: true }
    })

    await useSettingsStore
      .getState()
      .setNcbiCredentials({ contactEmail: 'me@lab.org', apiKey: 'k' })

    expect(api.setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'me@lab.org',
      apiKey: 'k'
    })
    expect(useSettingsStore.getState().ncbi).toEqual({
      contactEmail: 'me@lab.org',
      hasApiKey: true
    })
  })

  it('addCustomServer and removeCustomServer reconcile the custom-server list', async () => {
    const server = {
      id: 'srv-1',
      name: 'my-mem',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx'
    }
    api.addCustomServer.mockResolvedValue({
      connectors: [],
      customServers: [server],
      ncbi: { hasApiKey: false }
    })
    api.removeCustomServer.mockResolvedValue({
      connectors: [],
      customServers: [],
      ncbi: { hasApiKey: false }
    })

    await useSettingsStore.getState().addCustomServer({
      name: 'my-mem',
      displayName: 'My Memory',
      transport: 'stdio',
      command: 'npx'
    })
    expect(api.addCustomServer).toHaveBeenCalledWith({
      name: 'my-mem',
      displayName: 'My Memory',
      transport: 'stdio',
      command: 'npx'
    })
    expect(useSettingsStore.getState().customServers).toEqual([server])

    await useSettingsStore.getState().removeCustomServer('srv-1')
    expect(api.removeCustomServer).toHaveBeenCalledWith({ id: 'srv-1' })
    expect(useSettingsStore.getState().customServers).toEqual([])
  })

  it('authenticateCustomServer reconciles the OAuth status from main', async () => {
    const server: CustomServerView = {
      id: 'oauth-1',
      name: 'oauth-server',
      displayName: 'OAuth server',
      transport: 'streamable_http',
      enabled: true,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: true }
    }
    api.authenticateCustomServer.mockResolvedValue({
      connectors: [],
      customServers: [server],
      ncbi: { hasApiKey: false }
    })

    await useSettingsStore.getState().authenticateCustomServer({ id: server.id })

    expect(api.authenticateCustomServer).toHaveBeenCalledWith({ id: server.id })
    expect(useSettingsStore.getState().customServers).toEqual([server])
  })

  it('refreshes OAuth status after authenticateCustomServer fails', async () => {
    const server: CustomServerView = {
      id: 'oauth-1',
      name: 'oauth-server',
      displayName: 'OAuth server',
      transport: 'streamable_http',
      enabled: true,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: false }
    }
    api.authenticateCustomServer.mockRejectedValueOnce(new Error('Authorization denied'))
    api.listConnectors.mockResolvedValue({
      connectors: [],
      customServers: [server],
      ncbi: { hasApiKey: false }
    })

    await expect(
      useSettingsStore.getState().authenticateCustomServer({ id: server.id })
    ).rejects.toThrow('Authorization denied')

    expect(api.listConnectors).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().customServers).toEqual([server])
  })

  it('forwards OAuth authentication cancellation to main', async () => {
    await useSettingsStore.getState().cancelCustomServerAuthentication({ id: 'oauth-1' })

    expect(api.cancelCustomServerAuthentication).toHaveBeenCalledWith({ id: 'oauth-1' })
  })

  it('enqueues an approval request and responds, clearing it from the queue', async () => {
    const request = {
      id: 'req-1',
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{"x":1}'
    }
    useSettingsStore.getState().enqueueApproval(request)
    expect(useSettingsStore.getState().pendingApprovals).toEqual([request])

    // Duplicate ids are ignored.
    useSettingsStore.getState().enqueueApproval(request)
    expect(useSettingsStore.getState().pendingApprovals).toHaveLength(1)

    await useSettingsStore.getState().respondApproval('req-1', 'once')
    expect(api.respondConnectorApproval).toHaveBeenCalledWith({ id: 'req-1', decision: 'once' })
    expect(useSettingsStore.getState().pendingApprovals).toEqual([])
  })
})

describe('settings store: setAgentFramework', () => {
  beforeEach(() => {
    useSettingsStore.setState(createInitialSettingsState())
  })

  it('switches, then live-detects the selected framework and refreshes preflight', async () => {
    await useSettingsStore.getState().setAgentFramework('opencode')

    // The switch persists first, then the newly-selected framework is re-detected so a
    // just-installed (or just-deleted) binary is reflected before the readiness gate is recomputed.
    expect(callLog).toEqual(['setFramework:opencode', 'detectOpencode'])
    expect(api.getPreflight).toHaveBeenCalled()
    expect(useSettingsStore.getState().agentFrameworkId).toBe('opencode')
  })

  it('re-detects Claude when switching back to claude-code', async () => {
    await useSettingsStore.getState().setAgentFramework('claude-code')

    expect(api.detectClaude).toHaveBeenCalled()
    expect(api.detectOpencode).not.toHaveBeenCalled()
  })

  it('switches to Codex and live-detects its adapter', async () => {
    await useSettingsStore.getState().setAgentFramework('codex')

    expect(callLog).toEqual(['setFramework:codex', 'detectCodex'])
    expect(useSettingsStore.getState()).toMatchObject({
      agentFrameworkId: 'codex',
      codex: { resolvedPath: '/bin/codex-acp', version: '1.1.4' },
      isDetectingCodex: false
    })
  })

  it('keeps the previous framework and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ipcError = new Error('ipc down')
    api.setAgentFramework.mockRejectedValue(ipcError)

    await expect(useSettingsStore.getState().setAgentFramework('opencode')).rejects.toBe(ipcError)

    expect(useSettingsStore.getState().agentFrameworkId).toBe('claude-code')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not switch agent framework. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith('Failed to switch agent framework', expect.any(Error))
  })

  it('does not report a saved framework as a write failure when live detection rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.detectOpencode.mockRejectedValue(new Error('probe down'))

    await useSettingsStore.getState().setAgentFramework('opencode')

    expect(useSettingsStore.getState().agentFrameworkId).toBe('opencode')
    expect(useSettingsStore.getState().settingsWriteError).toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to refresh agent framework status',
      expect.any(Error)
    )
  })

  it('installs and uninstalls Codex through the shared runtime lifecycle', async () => {
    api.getSettings.mockResolvedValue({
      ...snapshot([]),
      codex: { resolvedPath: '/data/codex-acp/dist/index.js', version: '1.1.4' },
      codexManaged: true
    })
    api.uninstallCodex.mockResolvedValue(snapshot([]))

    await useSettingsStore.getState().installCodex()
    expect(api.installCodex).toHaveBeenCalledWith({ source: 'managed' })
    expect(useSettingsStore.getState().codexManaged).toBe(true)

    await useSettingsStore.getState().uninstallCodex()
    expect(api.uninstallCodex).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().codex).toEqual({})
  })

  it('streams install events into the installing runtime slice only, leaving the others untouched (#278)', async () => {
    // Capture the install-log listener and hold the install open so mid-install state is observable.
    let emit: (event: ClaudeInstallEvent) => void = () => undefined
    api.onInstallLog.mockImplementation((listener: (event: ClaudeInstallEvent) => void) => {
      emit = listener
      return vi.fn()
    })
    let resolveInstall: (result: { installId: string; ok: boolean }) => void = () => undefined
    api.installCodex.mockImplementation(
      () =>
        new Promise<{ installId: string; ok: boolean }>((resolve) => {
          resolveInstall = resolve
        })
    )

    const pending = useSettingsStore.getState().installCodex()

    // A progress tick and a log chunk arrive on the shared channel while Codex is installing.
    emit({ kind: 'progress', installId: 'codex-1', phase: 'installing' })
    emit({ kind: 'log', installId: 'codex-1', stream: 'stdout', chunk: 'Fetching adapter\n' })

    const mid = useSettingsStore.getState().installStates
    // Codex's slice reflects its own install...
    expect(mid.codex.isInstalling).toBe(true)
    expect(mid.codex.installProgress).toEqual({
      kind: 'progress',
      installId: 'codex-1',
      phase: 'installing'
    })
    expect(mid.codex.installLogs).toEqual(['Fetching adapter\n'])
    // ...while Claude's and OpenCode's slices stay pristine — no phantom install (the bug in #278).
    expect(mid['claude-code']).toEqual({
      isInstalling: false,
      installLogs: [],
      installProgress: null,
      installError: undefined
    })
    expect(mid.opencode).toEqual({
      isInstalling: false,
      installLogs: [],
      installProgress: null,
      installError: undefined
    })

    resolveInstall({ installId: 'codex-1', ok: true })
    await pending

    // After completion the install flag clears and no error is recorded on a success.
    const done = useSettingsStore.getState().installStates
    expect(done.codex.isInstalling).toBe(false)
    expect(done.codex.installError).toBeUndefined()
  })

  it('records an install failure on the runtime slice without disturbing the others', async () => {
    api.installCodex.mockResolvedValue({
      installId: 'codex-1',
      ok: false,
      error: 'Download failed'
    })

    await useSettingsStore.getState().installCodex()

    const states = useSettingsStore.getState().installStates
    expect(states.codex.installError).toBe('Download failed')
    expect(states.codex.isInstalling).toBe(false)
    expect(states['claude-code'].installError).toBeUndefined()
    expect(states.opencode.installError).toBeUndefined()
  })

  it('does not relabel a successful install as failed when the post-install reconcile throws', async () => {
    api.installCodex.mockResolvedValue({ installId: 'codex-1', ok: true })
    // The install succeeded, but the snapshot reconcile that follows it fails (transient IPC error).
    api.getSettings.mockRejectedValueOnce(new Error('IPC channel closed'))

    // The reconcile error is swallowed (the install succeeded), so the call resolves rather than throws.
    const result = await useSettingsStore.getState().installCodex()
    expect(result).toEqual({ installId: 'codex-1', ok: true })

    const state = useSettingsStore.getState().installStates.codex
    // No phantom failure: installError stays clear and the install flag is reset.
    expect(state.installError).toBeUndefined()
    expect(state.isInstalling).toBe(false)
  })

  it('refuses a second concurrent install so subscriptions can never cross-contaminate (#278)', async () => {
    // Hold a Claude install open so a second install is attempted while the first is still in flight.
    api.onInstallLog.mockReturnValue(vi.fn())
    let resolveClaude: (result: { installId: string; ok: boolean }) => void = () => undefined
    api.installClaude.mockImplementation(
      () =>
        new Promise<{ installId: string; ok: boolean }>((resolve) => {
          resolveClaude = resolve
        })
    )

    const firstPending = useSettingsStore.getState().installClaude('managed')
    expect(useSettingsStore.getState().installStates['claude-code'].isInstalling).toBe(true)

    // The store's atomic guard rejects the overlapping install for a different runtime — main is never
    // asked to install, and the Codex slice stays pristine (no phantom install).
    const blocked = await useSettingsStore.getState().installCodex()
    expect(blocked).toEqual({
      installId: '',
      ok: false,
      error: 'Another install is already in progress.'
    })
    expect(api.installCodex).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().installStates.codex).toEqual({
      isInstalling: false,
      installLogs: [],
      installProgress: null,
      installError: undefined
    })

    resolveClaude({ installId: 'claude-1', ok: true })
    await firstPending
    expect(useSettingsStore.getState().installStates['claude-code'].isInstalling).toBe(false)
  })

  it('clearInstallLogs clears transient fields but preserves the install lock (isInstalling)', () => {
    // Simulate a runtime mid-install with accumulated logs/progress/error.
    useSettingsStore.setState((state) => ({
      installStates: {
        ...state.installStates,
        codex: {
          isInstalling: true,
          installLogs: ['line 1', 'line 2'],
          installProgress: { kind: 'progress', phase: 'download', message: 'x' } as never,
          installError: 'stale error'
        }
      }
    }))

    useSettingsStore.getState().clearInstallLogs('codex')

    const codex = useSettingsStore.getState().installStates.codex
    expect(codex.installLogs).toEqual([])
    expect(codex.installProgress).toBeNull()
    expect(codex.installError).toBeUndefined()
    // The lock must survive: dropping it mid-install would let a second install start.
    expect(codex.isInstalling).toBe(true)
    expect(selectAnyInstalling(useSettingsStore.getState())).toBe(true)
  })
})

describe('settings store: setSessionDetailsModel', () => {
  it('applies the selected policy optimistically before Main confirms', async () => {
    let resolveIpc: (value: SettingsSnapshot) => void = () => undefined
    api.setSessionDetailsModel.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveIpc = resolve
        })
    )
    const selected = {
      mode: 'fixed' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'medium' as const
    }

    const pending = useSettingsStore.getState().setSessionDetailsModel(selected)

    expect(useSettingsStore.getState().sessionDetailsModel).toEqual(selected)
    expect(useSettingsStore.getState().sessionDetailsModelPending).toBe(true)
    resolveIpc({ ...snapshot([]), sessionDetailsModel: selected })
    await pending
    expect(useSettingsStore.getState().sessionDetailsModel).toEqual(selected)
    expect(useSettingsStore.getState().sessionDetailsModelPending).toBe(false)
  })

  it('rolls back to the confirmed policy when Main rejects the write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setSessionDetailsModel.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setSessionDetailsModel({ mode: 'disabled' })

    expect(useSettingsStore.getState().sessionDetailsModel).toEqual({
      mode: 'inherit',
      reasoningEffort: 'low'
    })
    expect(useSettingsStore.getState().sessionDetailsModelPending).toBe(false)
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save Session details model. Refresh the model catalog and try again.'
    )
  })
})

describe('settings store: setReasoningEffort', () => {
  it('forwards the level to main and caches the returned snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setNotificationsEnabled.mockRejectedValueOnce(new Error('notifications unavailable'))
    await useSettingsStore.getState().setNotificationsEnabled(false)

    await useSettingsStore.getState().setReasoningEffort('high')

    expect(api.setReasoningEffort).toHaveBeenCalledWith({ effort: 'high' })
    expect(useSettingsStore.getState().reasoningEffort).toBe('high')
    expect(useSettingsStore.getState().settingsWriteError).toBeUndefined()
  })

  it('applies the picked level optimistically before main confirms', async () => {
    let resolveIpc: (value: SettingsSnapshot) => void = () => undefined
    api.setReasoningEffort.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveIpc = resolve
        })
    )

    const pending = useSettingsStore.getState().setReasoningEffort('max')

    // The selector must not wait for the reconnect-bearing IPC round trip.
    expect(useSettingsStore.getState().reasoningEffort).toBe('max')

    resolveIpc({ ...snapshot([]), reasoningEffort: 'max' })
    await pending
    expect(useSettingsStore.getState().reasoningEffort).toBe('max')
  })

  it('surfaces an unrelated older write failure after a newer settings write succeeds', async () => {
    let rejectReasoning: (reason?: unknown) => void = () => undefined
    api.setReasoningEffort.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((_resolve, reject) => {
          rejectReasoning = reject
        })
    )

    const olderWrite = useSettingsStore.getState().setReasoningEffort('high')
    await useSettingsStore.getState().setNotificationsEnabled(false)

    rejectReasoning(new Error('stale failure'))
    await olderWrite

    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save reasoning effort. Try again.'
    )
  })

  it('keeps a newer write failure when an older settings write succeeds later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let resolveReasoning: (value: SettingsSnapshot) => void = () => undefined
    api.setReasoningEffort.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveReasoning = resolve
        })
    )
    api.setNotificationsEnabled.mockRejectedValue(new Error('newer failure'))

    const olderWrite = useSettingsStore.getState().setReasoningEffort('high')
    await useSettingsStore.getState().setNotificationsEnabled(false)

    resolveReasoning({ ...snapshot([]), reasoningEffort: 'high' })
    await olderWrite

    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save notification preference. Try again.'
    )
  })

  it('retains failures from concurrent writes to different preferences', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectReasoning: (reason?: unknown) => void = () => undefined
    let rejectNotifications: (reason?: unknown) => void = () => undefined
    api.setReasoningEffort.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((_resolve, reject) => {
          rejectReasoning = reject
        })
    )
    api.setNotificationsEnabled.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((_resolve, reject) => {
          rejectNotifications = reject
        })
    )

    const reasoningWrite = useSettingsStore.getState().setReasoningEffort('high')
    const notificationsWrite = useSettingsStore.getState().setNotificationsEnabled(false)

    rejectNotifications(new Error('notifications unavailable'))
    await notificationsWrite
    rejectReasoning(new Error('reasoning unavailable'))
    await reasoningWrite

    expect(useSettingsStore.getState().settingsWriteError).toContain(
      'Could not save notification preference. Try again.'
    )
    expect(useSettingsStore.getState().settingsWriteError).toContain(
      'Could not save reasoning effort. Try again.'
    )
  })

  it('ignores a stale failure from an older write to the same preference', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setReasoningEffort
      .mockRejectedValueOnce(new Error('stale failure'))
      .mockResolvedValueOnce({ ...snapshot([]), reasoningEffort: 'max' })

    const olderWrite = useSettingsStore.getState().setReasoningEffort('high')
    const newerWrite = useSettingsStore.getState().setReasoningEffort('max')

    await Promise.all([olderWrite, newerWrite])

    expect(useSettingsStore.getState().reasoningEffort).toBe('max')
    expect(useSettingsStore.getState().settingsWriteError).toBeUndefined()
  })

  it('restores the confirmed value when concurrent writes to the same preference both fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setReasoningEffort
      .mockRejectedValueOnce(new Error('older failure'))
      .mockRejectedValueOnce(new Error('newer failure'))

    const olderWrite = useSettingsStore.getState().setReasoningEffort('high')
    const newerWrite = useSettingsStore.getState().setReasoningEffort('max')

    await Promise.all([olderWrite, newerWrite])

    expect(useSettingsStore.getState().reasoningEffort).toBe('default')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save reasoning effort. Try again.'
    )
  })

  it('restores the last successful value when a queued newer write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setReasoningEffort
      .mockResolvedValueOnce({ ...snapshot([]), reasoningEffort: 'high' })
      .mockRejectedValueOnce(new Error('newer failure'))

    const olderWrite = useSettingsStore.getState().setReasoningEffort('high')
    const newerWrite = useSettingsStore.getState().setReasoningEffort('max')

    await Promise.all([olderWrite, newerWrite])

    expect(useSettingsStore.getState().reasoningEffort).toBe('high')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save reasoning effort. Try again.'
    )
  })

  it('reverts to the previous level and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setReasoningEffort.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setReasoningEffort('low')

    expect(useSettingsStore.getState().reasoningEffort).toBe('default')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save reasoning effort. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith('Failed to set reasoning effort', expect.any(Error))
  })

  it('load() picks up a non-default level from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), reasoningEffort: 'max' })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().reasoningEffort).toBe('max')
  })
})

describe('settings store: setNotificationsEnabled', () => {
  it('forwards the flag to main and caches the returned snapshot', async () => {
    await useSettingsStore.getState().setNotificationsEnabled(false)

    expect(api.setNotificationsEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
  })

  it('reverts to the previous flag and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setNotificationsEnabled.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setNotificationsEnabled(false)

    expect(useSettingsStore.getState().notificationsEnabled).toBe(true)
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save notification preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to set notifications enabled',
      expect.any(Error)
    )
  })

  it('load() picks up a disabled preference from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), notificationsEnabled: false })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
  })
})

describe('settings store: acceptCommittedSnapshot vs in-flight optimistic preference', () => {
  it('does not let a foreign committed snapshot clobber an in-flight optimistic preference', async () => {
    let resolveNotifications: (value: SettingsSnapshot) => void = () => undefined
    api.setNotificationsEnabled.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveNotifications = resolve
        })
    )

    const pending = useSettingsStore.getState().setNotificationsEnabled(false)
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)

    try {
      useSettingsStore.getState().acceptCommittedSnapshot({
        ...snapshot([]),
        notificationsEnabled: true,
        appIconVariant: 'dark'
      })

      expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
      expect(useSettingsStore.getState().appIconVariant).toBe('dark')
    } finally {
      resolveNotifications({
        ...snapshot([]),
        notificationsEnabled: false,
        appIconVariant: 'dark'
      })
      await pending
    }

    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
  })

  it('rolls back a failed optimistic preference to the last confirmed value after a foreign snapshot', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectNotifications: (reason?: unknown) => void = () => undefined
    api.setNotificationsEnabled.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((_resolve, reject) => {
          rejectNotifications = reject
        })
    )

    const pending = useSettingsStore.getState().setNotificationsEnabled(false)
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)

    useSettingsStore.getState().acceptCommittedSnapshot({
      ...snapshot([]),
      notificationsEnabled: false,
      appIconVariant: 'dark'
    })

    rejectNotifications(new Error('ipc down'))
    await pending

    expect(useSettingsStore.getState().notificationsEnabled).toBe(true)
    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save notification preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to set notifications enabled',
      expect.any(Error)
    )
  })

  it('applies a committed snapshot when no preference write is in flight', () => {
    useSettingsStore.getState().acceptCommittedSnapshot({
      ...snapshot([]),
      notificationsEnabled: false,
      appIconVariant: 'dark',
      reasoningEffort: 'high'
    })

    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
    expect(useSettingsStore.getState().reasoningEffort).toBe('high')
  })

  it('does not let a foreign committed snapshot clobber an in-flight non-boolean optimistic preference', async () => {
    let resolveEffort: (value: SettingsSnapshot) => void = () => undefined
    api.setReasoningEffort.mockImplementation(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveEffort = resolve
        })
    )

    const pending = useSettingsStore.getState().setReasoningEffort('max')
    expect(useSettingsStore.getState().reasoningEffort).toBe('max')

    try {
      useSettingsStore.getState().acceptCommittedSnapshot({
        ...snapshot([]),
        reasoningEffort: 'high',
        notificationsEnabled: false
      })

      expect(useSettingsStore.getState().reasoningEffort).toBe('max')
      expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
    } finally {
      resolveEffort({ ...snapshot([]), reasoningEffort: 'max', notificationsEnabled: false })
      await pending
    }

    expect(useSettingsStore.getState().reasoningEffort).toBe('max')
  })
})

describe('settings store: setConversationSkillImportEnabled', () => {
  it('forwards the flag to main and caches the returned snapshot', async () => {
    await useSettingsStore.getState().setConversationSkillImportEnabled(false)

    expect(api.setConversationSkillImportEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(useSettingsStore.getState().conversationSkillImportEnabled).toBe(false)
  })

  it('reverts to the previous flag and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.setConversationSkillImportEnabled.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setConversationSkillImportEnabled(false)

    expect(useSettingsStore.getState().conversationSkillImportEnabled).toBe(true)
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save conversation Skill import preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to set conversation Skill import enabled',
      expect.any(Error)
    )
  })

  it('load() picks up a disabled preference from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({
      ...snapshot([]),
      conversationSkillImportEnabled: false
    })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().conversationSkillImportEnabled).toBe(false)
  })
})

describe('settings store: setClosePreference', () => {
  it('forwards a saved action and can reset to ask every time', async () => {
    await useSettingsStore.getState().setClosePreference('minimize')
    expect(api.setClosePreference).toHaveBeenCalledWith({ preference: 'minimize' })
    expect(useSettingsStore.getState().closePreference).toBe('minimize')

    await useSettingsStore.getState().setClosePreference(undefined)
    expect(api.setClosePreference).toHaveBeenLastCalledWith({ preference: undefined })
    expect(useSettingsStore.getState().closePreference).toBeUndefined()
  })

  it('reverts to the previous preference and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useSettingsStore.setState({ closePreference: 'quit' })
    api.setClosePreference.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setClosePreference(undefined)

    expect(useSettingsStore.getState().closePreference).toBe('quit')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save window close preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith('Failed to set close preference', expect.any(Error))
  })

  it('load() picks up a saved preference from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), closePreference: 'minimize' })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().closePreference).toBe('minimize')
  })
})

describe('settings store: setProjectFilesFilter', () => {
  it('forwards a saved filter and can reset to the default', async () => {
    await useSettingsStore
      .getState()
      .setProjectFilesFilter({ sourceMode: 'local', localRootId: 'root-1' })
    expect(api.setProjectFilesFilter).toHaveBeenCalledWith({
      filter: { sourceMode: 'local', localRootId: 'root-1' }
    })
    expect(useSettingsStore.getState().projectFilesFilter).toEqual({
      sourceMode: 'local',
      localRootId: 'root-1'
    })

    await useSettingsStore.getState().setProjectFilesFilter(undefined)
    expect(api.setProjectFilesFilter).toHaveBeenLastCalledWith({ filter: undefined })
    expect(useSettingsStore.getState().projectFilesFilter).toBeUndefined()
  })

  it('reverts to the previous filter and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useSettingsStore.setState({ projectFilesFilter: { sourceMode: 'local' } })
    api.setProjectFilesFilter.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setProjectFilesFilter(undefined)

    expect(useSettingsStore.getState().projectFilesFilter).toEqual({ sourceMode: 'local' })
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save files filter preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to set project files filter',
      expect.any(Error)
    )
  })

  it('load() picks up a saved filter from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({
      ...snapshot([]),
      projectFilesFilter: { sourceMode: 'artifacts', optionId: 'uploads' }
    })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().projectFilesFilter).toEqual({
      sourceMode: 'artifacts',
      optionId: 'uploads'
    })
  })
})

describe('settings store: setAppIconVariant', () => {
  it('forwards the variant to main and caches the returned snapshot', async () => {
    await useSettingsStore.getState().setAppIconVariant('dark')

    expect(api.setAppIconVariant).toHaveBeenCalledWith({ variant: 'dark' })
    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
  })

  it('reverts to the previous variant and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useSettingsStore.setState({ appIconVariant: 'light' })
    api.setAppIconVariant.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setAppIconVariant('dark')

    expect(useSettingsStore.getState().appIconVariant).toBe('light')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save app icon preference. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith('Failed to set app icon variant', expect.any(Error))
  })

  it('load() picks up a saved variant from the settings snapshot', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), appIconVariant: 'dark' })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
  })
})

describe('settings store: setDefaultPermissionProfile', () => {
  it('forwards the profile and caches the returned snapshot', async () => {
    await useSettingsStore.getState().setDefaultPermissionProfile('auto')

    expect(api.setDefaultPermissionProfile).toHaveBeenCalledWith({ profile: 'auto' })
    expect(useSettingsStore.getState().defaultPermissionProfile).toBe('auto')
  })

  it('reverts and exposes a visible failure when main rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useSettingsStore.setState({ defaultPermissionProfile: 'ask' })
    api.setDefaultPermissionProfile.mockRejectedValue(new Error('ipc down'))

    await useSettingsStore.getState().setDefaultPermissionProfile('full')

    expect(useSettingsStore.getState().defaultPermissionProfile).toBe('ask')
    expect(useSettingsStore.getState().settingsWriteError).toBe(
      'Could not save the default permission mode. Try again.'
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to set default permission profile',
      expect.any(Error)
    )
  })
})
