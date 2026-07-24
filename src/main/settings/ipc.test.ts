import { describe, expect, it, vi } from 'vitest'

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'
import type { SettingsService } from './service'

// Capture every ipcMain.handle registration so handlers can be invoked directly in the test.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { registerSettingsIpcHandlers } = await import('./ipc')

// A fake service whose methods are all spies; cast to SettingsService only when registering handlers.
type FakeSettingsService = Record<
  | 'getPreflight'
  | 'getSettingsView'
  | 'isEncryptionAvailable'
  | 'isNpmAvailable'
  | 'checkEnvironment'
  | 'detectClaude'
  | 'detectOpencode'
  | 'detectCodex'
  | 'installClaude'
  | 'installOpencode'
  | 'installCodex'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallCodex'
  | 'setAgentFramework'
  | 'setReasoningEffort'
  | 'setNotificationsEnabled'
  | 'setClosePreference'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'validateProvider'
  | 'cancelCodexLogin'
  | 'cancelClaudeLogin'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'loginClaudeShared'
  | 'logoutClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'cancelClaudeIsolatedLogin'
  | 'logoutIsolatedClaude'
  | 'markOnboardingComplete'
  | 'listSkills'
  | 'getSkillDetail'
  | 'setSkillEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkillZipBatch'
  | 'setConnectorEnabled',
  ReturnType<typeof vi.fn>
>

const createFakeService = (): FakeSettingsService => ({
  getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
  getSettingsView: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  isNpmAvailable: vi.fn().mockResolvedValue(true),
  checkEnvironment: vi.fn().mockResolvedValue({ ready: true, checks: [] }),
  detectClaude: vi.fn().mockResolvedValue({ found: false }),
  detectOpencode: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'opencode' }),
  detectCodex: vi.fn().mockResolvedValue({ codex: {}, providers: [], agentFrameworkId: 'codex' }),
  installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
  installOpencode: vi.fn().mockResolvedValue({ installId: 'oc', ok: true }),
  installCodex: vi.fn().mockResolvedValue({ installId: 'cx', ok: true }),
  uninstallClaude: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'claude-code' },
    activeBackendAffected: true
  }),
  uninstallOpencode: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'opencode' },
    activeBackendAffected: true
  }),
  uninstallCodex: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'codex' },
    activeBackendAffected: true
  }),
  setAgentFramework: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'opencode' }),
  setReasoningEffort: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], reasoningEffort: 'high' }),
  setNotificationsEnabled: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], notificationsEnabled: false }),
  setClosePreference: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], closePreference: 'quit' }),
  upsertProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  deleteProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  setActiveProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  validateProvider: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelCodexLogin: vi.fn(),
  cancelClaudeLogin: vi.fn(),
  loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutIsolatedCodex: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], activeProviderId: undefined }),
  loginClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelClaudeIsolatedLogin: vi.fn(),
  logoutIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  markOnboardingComplete: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  listSkills: vi.fn().mockResolvedValue([]),
  getSkillDetail: vi.fn().mockResolvedValue({
    id: 'demo',
    name: 'Demo',
    description: '',
    source: 'featured',
    updatedAt: '',
    enabled: true,
    body: 'b'
  }),
  setSkillEnabled: vi.fn().mockResolvedValue([]),
  createSkill: vi.fn().mockResolvedValue([]),
  updateSkill: vi.fn().mockResolvedValue([]),
  deleteSkill: vi.fn().mockResolvedValue([]),
  importSkillZipBatch: vi.fn().mockResolvedValue({ results: [], skills: [] }),
  setConnectorEnabled: vi.fn().mockResolvedValue({ connectors: [] })
})

// Adapts the spy bag into the SettingsService shape the registration function expects.
const asService = (fake: FakeSettingsService): SettingsService => fake as unknown as SettingsService

const invoke = (channel: string, payload?: unknown): unknown =>
  handlers.get(channel)!(undefined, payload)

describe('settings IPC handlers', () => {
  it('registers every settings channel', () => {
    handlers.clear()
    registerSettingsIpcHandlers({ service: asService(createFakeService()) })

    for (const channel of [
      'settings:get-preflight',
      'settings:get-settings',
      'settings:encryption-available',
      'settings:npm-available',
      'settings:check-environment',
      'settings:detect-claude',
      'settings:install-claude',
      'settings:upsert-provider',
      'settings:delete-provider',
      'settings:set-active-provider',
      'settings:validate-provider',
      'settings:cancel-codex-login',
      'settings:cancel-claude-login',
      'settings:login-isolated-codex',
      'settings:logout-isolated-codex',
      'settings:login-shared-claude',
      'settings:logout-shared-claude',
      'settings:login-isolated-claude',
      'settings:login-isolated-claude-browser',
      'settings:cancel-isolated-claude-login',
      'settings:logout-isolated-claude',
      'settings:mark-onboarding-complete'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('routes provider commands to the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:upsert-provider', { type: 'custom', name: 'G' })
    expect(service.upsertProvider).toHaveBeenCalledWith({ type: 'custom', name: 'G' })

    await invoke('settings:delete-provider', { id: 'p1' })
    expect(service.deleteProvider).toHaveBeenCalledWith('p1')

    await invoke('settings:validate-provider', { providerId: 'p1' })
    expect(service.validateProvider).toHaveBeenCalledWith({ providerId: 'p1' })

    await invoke('settings:cancel-codex-login')
    expect(service.cancelCodexLogin).toHaveBeenCalledOnce()

    await invoke('settings:logout-isolated-codex')
    expect(service.logoutIsolatedCodex).toHaveBeenCalledOnce()

    await invoke('settings:cancel-claude-login')
    expect(service.cancelClaudeLogin).toHaveBeenCalledOnce()

    await invoke('settings:login-shared-claude')
    expect(service.loginClaudeShared).toHaveBeenCalledOnce()

    await invoke('settings:logout-shared-claude')
    expect(service.logoutClaudeShared).toHaveBeenCalledOnce()

    await invoke('settings:login-isolated-claude', 'sk-ant-test')
    expect(service.loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-test')

    await invoke('settings:login-isolated-claude-browser')
    expect(service.loginIsolatedClaudeBrowser).toHaveBeenCalledOnce()

    await invoke('settings:cancel-isolated-claude-login')
    expect(service.cancelClaudeIsolatedLogin).toHaveBeenCalledOnce()
  })

  it('reconnects the active Codex subscription after isolated logout', async () => {
    handlers.clear()
    const service = createFakeService()
    service.logoutIsolatedCodex.mockResolvedValue({ ok: true, category: 'ok' })
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    await invoke('settings:logout-isolated-codex')

    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('does not reconnect when isolated logout times out', async () => {
    // Reconnecting when the sign-out timed out would re-authenticate with the credential that is
    // still in place — the opposite of what the user intended. Skip the reconnect so the live
    // agent keeps its existing session until a retry clears the credential.
    handlers.clear()
    const service = createFakeService()
    service.logoutIsolatedCodex.mockResolvedValue({
      ok: false,
      category: 'timeout',
      message: 'Codex sign-out timed out.'
    })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    await invoke('settings:logout-isolated-codex')

    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('reconnects the active provider only when the isolated login was actually applied', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    // Login succeeded and the active provider is still the isolated subscription: reconnect.
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [{ id: CODEX_SUBSCRIPTION_PROVIDER_ID, type: 'codex-isolated' }],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    await invoke('settings:login-isolated-codex')
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()

    // Login succeeded but the provider was switched to shared mid-flow (outcome discarded): the
    // shared runtime's credentials didn't change, so a reconnect would be redundant.
    onActiveProviderChanged.mockClear()
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [{ id: CODEX_SUBSCRIPTION_PROVIDER_ID, type: 'codex-shared' }],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    await invoke('settings:login-isolated-codex')
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('routes mark-onboarding-complete to the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:mark-onboarding-complete')

    expect(service.markOnboardingComplete).toHaveBeenCalledTimes(1)
  })

  it('fires onConnectorsChanged after a connector is toggled', async () => {
    handlers.clear()
    const service = createFakeService()
    const onConnectorsChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onConnectorsChanged })

    await invoke('settings:set-connector-enabled', { id: 'biomart', enabled: false })

    // The callback is what drives ipc.ts's refresh-then-reload chain (reload runs in a .finally so it
    // fires even if the refresh rejects — see connector-skill-reload.finally.test.ts).
    expect(service.setConnectorEnabled).toHaveBeenCalledWith({ id: 'biomart', enabled: false })
    expect(onConnectorsChanged).toHaveBeenCalledOnce()
  })

  it('drops the agent connection when the active provider changes', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:set-active-provider', { id: 'p1' })

    expect(service.setActiveProvider).toHaveBeenCalledWith('p1', undefined)
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('drops the agent connection when the active provider is deleted', async () => {
    handlers.clear()
    const service = createFakeService()
    service.getSettingsView.mockResolvedValue({ activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:delete-provider', { id: 'p1' })

    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('drops the agent connection when the edited provider is the active one', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:upsert-provider', { id: 'p1', type: 'custom', name: 'G' })

    // Editing the live provider must respawn the agent so the new base URL / key / model take effect.
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('does not drop the connection when editing a non-active provider', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:upsert-provider', { id: 'p2', type: 'custom', name: 'Other' })

    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('does not drop the connection when creating a new provider', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    // A create has no id, so it can't be the active provider yet — no respawn.
    await invoke('settings:upsert-provider', { type: 'custom', name: 'New' })

    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', 'opencode'],
    ['opencode', 'codex'],
    ['codex', 'claude-code']
  ] as const)(
    'rotates the runtime after uninstalling active %s auto-switches frameworks',
    async (channel, fallbackFramework) => {
      handlers.clear()
      const service = createFakeService()
      service[
        channel === 'claude'
          ? 'uninstallClaude'
          : channel === 'opencode'
            ? 'uninstallOpencode'
            : 'uninstallCodex'
      ].mockResolvedValue({
        snapshot: { claude: {}, providers: [], agentFrameworkId: fallbackFramework },
        activeBackendAffected: true
      })
      const onActiveProviderChanged = vi.fn()
      const onAgentFrameworkChanged = vi.fn()
      registerSettingsIpcHandlers({
        service: asService(service),
        onActiveProviderChanged,
        onAgentFrameworkChanged
      })

      await invoke(`settings:uninstall-${channel}`)

      expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
      expect(onActiveProviderChanged).not.toHaveBeenCalled()
    }
  )

  it('reconnects after uninstalling the active runtime when no fallback is ready', async () => {
    handlers.clear()
    const service = createFakeService()
    service.uninstallClaude.mockResolvedValue({
      snapshot: { claude: {}, providers: [], agentFrameworkId: 'claude-code' },
      activeBackendAffected: true
    })
    const onActiveProviderChanged = vi.fn()
    const onAgentFrameworkChanged = vi.fn()
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onAgentFrameworkChanged
    })

    await invoke('settings:uninstall-claude')

    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
    expect(onAgentFrameworkChanged).not.toHaveBeenCalled()
  })

  it('does not reconnect after uninstalling the inactive runtime', async () => {
    handlers.clear()
    const service = createFakeService()
    // OpenCode is uninstalled while Claude is active: the live agent is untouched.
    service.uninstallOpencode.mockResolvedValue({
      snapshot: { claude: {}, providers: [] },
      activeBackendAffected: false
    })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:uninstall-opencode')

    expect(service.uninstallOpencode).toHaveBeenCalledTimes(1)
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('registers skill channels and fires onSkillsChanged after set-skill-enabled', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    await invoke('settings:list-skills')
    expect(service.listSkills).toHaveBeenCalledTimes(1)

    await invoke('settings:get-skill-detail', 'demo')
    expect(service.getSkillDetail).toHaveBeenCalledWith('demo')

    await invoke('settings:set-skill-enabled', { id: 'demo', enabled: false })
    expect(service.setSkillEnabled).toHaveBeenCalledWith({ id: 'demo', enabled: false })
    expect(onSkillsChanged).toHaveBeenCalledTimes(1)
  })

  it('routes create/update/delete skill channels and fires onSkillsChanged', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    await invoke('settings:create-skill', { name: 'S', description: 'd', body: 'b' })
    expect(service.createSkill).toHaveBeenCalledWith({ name: 'S', description: 'd', body: 'b' })

    await invoke('settings:update-skill', {
      id: 'personal-s',
      name: 'S',
      description: 'd',
      body: 'b2'
    })
    expect(service.updateSkill).toHaveBeenCalledWith({
      id: 'personal-s',
      name: 'S',
      description: 'd',
      body: 'b2'
    })

    await invoke('settings:delete-skill', { id: 'personal-s' })
    expect(service.deleteSkill).toHaveBeenCalledWith({ id: 'personal-s' })

    expect(onSkillsChanged).toHaveBeenCalledTimes(3)
  })

  it('routes import-skill-zip-batch to the service, forwards its result, and fires onSkillsChanged', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    const result = {
      results: [{ subPath: 'a', status: 'imported' as const, id: 'imported-a' }],
      skills: []
    }
    service.importSkillZipBatch.mockResolvedValue(result)
    registerSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    expect(handlers.has('settings:import-skill-zip-batch')).toBe(true)

    const request = { dataBase64: 'YmFzZTY0', items: [{ subPath: 'a' }] }
    const forwarded = await invoke('settings:import-skill-zip-batch', request)

    expect(service.importSkillZipBatch).toHaveBeenCalledWith(request)
    expect(forwarded).toBe(result)
    expect(onSkillsChanged).toHaveBeenCalledTimes(1)
  })

  it('registers the OpenCode / framework-switch channels', () => {
    handlers.clear()
    registerSettingsIpcHandlers({ service: asService(createFakeService()) })

    for (const channel of [
      'settings:detect-opencode',
      'settings:install-opencode',
      'settings:set-agent-framework'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('routes Codex detection, installation, and uninstall through the service', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    expect(handlers.has('settings:detect-codex')).toBe(true)
    expect(handlers.has('settings:install-codex')).toBe(true)
    expect(handlers.has('settings:uninstall-codex')).toBe(true)

    await invoke('settings:detect-codex')
    await invoke('settings:install-codex', { source: 'managed' })
    await invoke('settings:uninstall-codex')

    expect(service.detectCodex).toHaveBeenCalledOnce()
    expect(service.installCodex).toHaveBeenCalledWith({ source: 'managed' }, expect.any(Function))
    expect(service.uninstallCodex).toHaveBeenCalledOnce()
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('routes detect-opencode to the service and forwards its snapshot', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], agentFrameworkId: 'opencode' }
    service.detectOpencode.mockResolvedValue(snapshot)
    registerSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:detect-opencode')

    expect(service.detectOpencode).toHaveBeenCalledTimes(1)
    expect(result).toBe(snapshot)
  })

  it('routes install-opencode to the service with the requested source and a stream callback', async () => {
    handlers.clear()
    const service = createFakeService()
    const outcome = { installId: 'oc', ok: true }
    service.installOpencode.mockResolvedValue(outcome)
    registerSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:install-opencode', { source: 'managed' })

    // The handler forwards the typed request plus the broadcast callback used to stream install logs.
    expect(service.installOpencode).toHaveBeenCalledWith(
      { source: 'managed' },
      expect.any(Function)
    )
    expect(result).toBe(outcome)
  })

  it('routes each install-opencode source to the service unchanged', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    for (const source of ['managed', 'npm', 'official-script'] as const) {
      await invoke('settings:install-opencode', { source })
      expect(service.installOpencode).toHaveBeenCalledWith({ source }, expect.any(Function))
    }
  })

  it('persists the selected framework and rotates future sessions on set-agent-framework', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], agentFrameworkId: 'opencode' }
    service.setAgentFramework.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    const onAgentFrameworkChanged = vi.fn()
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onAgentFrameworkChanged
    })

    const result = await invoke('settings:set-agent-framework', { id: 'opencode' })

    // The handler unwraps the request to the bare framework id the service expects.
    expect(service.setAgentFramework).toHaveBeenCalledWith('opencode')
    // Existing sessions keep their owning runtime; only future sessions rotate to the new framework.
    expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
    expect(result).toBe(snapshot)
  })

  it('applies the level live without respawning when the framework supports it', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], reasoningEffort: 'high' }
    service.setReasoningEffort.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    const onReasoningEffortChanged = vi.fn().mockResolvedValue(true)
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onReasoningEffortChanged
    })

    const result = await invoke('settings:set-reasoning-effort', { effort: 'high' })

    // A live ACP application (Claude Code, Codex) makes the level stick without a respawn.
    expect(service.setReasoningEffort).toHaveBeenCalledWith('high')
    expect(onReasoningEffortChanged).toHaveBeenCalledWith('high')
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
    expect(result).toBe(snapshot)
  })

  it('respawns the agent when the framework cannot apply the level live', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], reasoningEffort: 'high' }
    service.setReasoningEffort.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    const onReasoningEffortChanged = vi.fn().mockResolvedValue(false)
    registerSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onReasoningEffortChanged
    })

    const result = await invoke('settings:set-reasoning-effort', { effort: 'high' })

    // opencode bakes effort into its spawn config, so the provider-switch reconnect delivers it.
    expect(service.setReasoningEffort).toHaveBeenCalledWith('high')
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
    expect(result).toBe(snapshot)
  })

  it('rejects an unknown reasoning effort without touching the service or the agent', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    // Renderer payloads are untyped at runtime: garbage must fail at the boundary, not persist.
    await expect(invoke('settings:set-reasoning-effort', { effort: 'ultra' })).rejects.toThrow(
      'Unknown reasoning effort'
    )
    await expect(invoke('settings:set-reasoning-effort', { effort: 3 })).rejects.toThrow(
      'Unknown reasoning effort'
    )
    await expect(invoke('settings:set-reasoning-effort', {})).rejects.toThrow(
      'Unknown reasoning effort'
    )
    expect(service.setReasoningEffort).not.toHaveBeenCalled()
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('persists the notifications preference on set-notifications-enabled', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], notificationsEnabled: false }
    service.setNotificationsEnabled.mockResolvedValue(snapshot)
    registerSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:set-notifications-enabled', { enabled: false })

    // The handler unwraps the request to the bare boolean the service expects.
    expect(service.setNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(result).toBe(snapshot)
  })

  it('rejects a non-boolean notifications flag without touching the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    // Renderer payloads are untyped at runtime: garbage must fail at the boundary, not persist.
    await expect(invoke('settings:set-notifications-enabled', { enabled: 'yes' })).rejects.toThrow(
      'Invalid notifications-enabled flag'
    )
    await expect(invoke('settings:set-notifications-enabled', {})).rejects.toThrow(
      'Invalid notifications-enabled flag'
    )
    expect(service.setNotificationsEnabled).not.toHaveBeenCalled()
  })

  it('persists valid close preferences and rejects unknown values', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:set-close-preference', { preference: 'quit' })
    await invoke('settings:set-close-preference', {})

    expect(service.setClosePreference).toHaveBeenNthCalledWith(1, 'quit')
    expect(service.setClosePreference).toHaveBeenNthCalledWith(2, undefined)
    await expect(invoke('settings:set-close-preference', { preference: 'close' })).rejects.toThrow(
      'Invalid close preference'
    )
  })

  it('surfaces a service error thrown by install-opencode', async () => {
    handlers.clear()
    const service = createFakeService()
    service.installOpencode.mockRejectedValue(new Error('download failed'))
    registerSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:install-opencode', { source: 'managed' })).rejects.toThrow(
      'download failed'
    )
  })
})
