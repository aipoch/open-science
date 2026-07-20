import { describe, expect, it, vi } from 'vitest'

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
  | 'installClaude'
  | 'installOpencode'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'setAgentFramework'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'validateProvider'
  | 'markOnboardingComplete'
  | 'listSkills'
  | 'getSkillDetail'
  | 'setSkillEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkillZipBatch',
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
  installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
  installOpencode: vi.fn().mockResolvedValue({ installId: 'oc', ok: true }),
  uninstallClaude: vi
    .fn()
    .mockResolvedValue({ snapshot: { claude: {}, providers: [] }, activeBackendAffected: true }),
  uninstallOpencode: vi
    .fn()
    .mockResolvedValue({ snapshot: { claude: {}, providers: [] }, activeBackendAffected: true }),
  setAgentFramework: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'opencode' }),
  upsertProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  deleteProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  setActiveProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  validateProvider: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
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
  importSkillZipBatch: vi.fn().mockResolvedValue({ results: [], skills: [] })
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
  })

  it('routes mark-onboarding-complete to the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:mark-onboarding-complete')

    expect(service.markOnboardingComplete).toHaveBeenCalledTimes(1)
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

  it('reconnects after uninstall only when the removed runtime was the active backend', async () => {
    handlers.clear()
    const service = createFakeService()
    service.uninstallClaude.mockResolvedValue({
      snapshot: { claude: {}, providers: [] },
      activeBackendAffected: true
    })
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:uninstall-claude')

    expect(service.uninstallClaude).toHaveBeenCalledTimes(1)
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
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

  it('persists the selected framework and respawns the agent on set-agent-framework', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], agentFrameworkId: 'opencode' }
    service.setAgentFramework.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    const result = await invoke('settings:set-agent-framework', { id: 'opencode' })

    // The handler unwraps the request to the bare framework id the service expects.
    expect(service.setAgentFramework).toHaveBeenCalledWith('opencode')
    // Switching frameworks swaps the backend binary, so the live agent must be dropped like a provider switch.
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
    expect(result).toBe(snapshot)
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
