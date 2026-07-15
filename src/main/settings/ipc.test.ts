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
  | 'installClaude'
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
  | 'deleteSkill',
  ReturnType<typeof vi.fn>
>

const createFakeService = (): FakeSettingsService => ({
  getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
  getSettingsView: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  isNpmAvailable: vi.fn().mockResolvedValue(true),
  checkEnvironment: vi.fn().mockResolvedValue({ ready: true, checks: [] }),
  detectClaude: vi.fn().mockResolvedValue({ found: false }),
  installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
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
  deleteSkill: vi.fn().mockResolvedValue([])
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
})
