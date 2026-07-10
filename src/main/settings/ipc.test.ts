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
  | 'detectClaude'
  | 'installClaude'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'validateProvider',
  ReturnType<typeof vi.fn>
>

const createFakeService = (): FakeSettingsService => ({
  getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
  getSettingsView: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  isNpmAvailable: vi.fn().mockResolvedValue(true),
  detectClaude: vi.fn().mockResolvedValue({ found: false }),
  installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
  upsertProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  deleteProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  setActiveProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  validateProvider: vi.fn().mockResolvedValue({ ok: true, category: 'ok' })
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
      'settings:detect-claude',
      'settings:install-claude',
      'settings:upsert-provider',
      'settings:delete-provider',
      'settings:set-active-provider',
      'settings:validate-provider'
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

  it('drops the agent connection when the active provider changes', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:set-active-provider', { id: 'p1' })

    expect(service.setActiveProvider).toHaveBeenCalledWith('p1')
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })
})
