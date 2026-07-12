import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsSnapshot, ValidateProviderResult } from '../../../shared/settings'
import {
  createInitialSettingsState,
  selectProviderModelOptions,
  useSettingsStore
} from './settings-store'

// Minimal window.api.settings surface the store calls.
type SettingsApi = {
  getSettings: ReturnType<typeof vi.fn>
  getPreflight: ReturnType<typeof vi.fn>
  isEncryptionAvailable: ReturnType<typeof vi.fn>
  isNpmAvailable: ReturnType<typeof vi.fn>
  upsertProvider: ReturnType<typeof vi.fn>
  validateProvider: ReturnType<typeof vi.fn>
  refreshProviderModels: ReturnType<typeof vi.fn>
  setActiveProvider: ReturnType<typeof vi.fn>
  deleteProvider: ReturnType<typeof vi.fn>
  markOnboardingComplete: ReturnType<typeof vi.fn>
}

// Minimal window.api.acp surface the provider-switch flow reads/uses.
type AcpApi = {
  getState: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const snapshot = (providers: SettingsSnapshot['providers']): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers
})

const providerView = (id: string): SettingsSnapshot['providers'][number] => ({
  id,
  type: 'custom',
  name: 'Gateway',
  model: 'claude-sonnet-4-5',
  models: ['claude-sonnet-4-5'],
  hasKey: true,
  needsKey: false
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
    upsertProvider: vi.fn(),
    validateProvider: vi.fn(),
    refreshProviderModels: vi.fn(),
    setActiveProvider: vi.fn().mockImplementation((request: { id: string }) => {
      callLog.push(`setActive:${request.id}`)
      return Promise.resolve({ ...snapshot([]), activeProviderId: request.id })
    }),
    deleteProvider: vi.fn(),
    markOnboardingComplete: vi
      .fn()
      .mockResolvedValue({ ...snapshot([]), onboardingCompletedAt: 4242 })
  }
  acp = {
    getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
    cancel: vi.fn().mockImplementation((request: { sessionId: string }) => {
      callLog.push(`cancel:${request.sessionId}`)
      return Promise.resolve({})
    })
  }
  ;(globalThis as { window?: unknown }).window = { api: { settings: api, acp } }
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
      key: 'k'
    })

    expect(result).toEqual({ providerId: 'p_new', validation: { ok: true, category: 'ok' } })
    expect(api.validateProvider).toHaveBeenCalledWith({ providerId: 'p_new' })
    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p_new' })
    expect(useSettingsStore.getState().activeProviderId).toBe('p_new')
  })

  it('does not activate when validation fails', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)

    const result = await useSettingsStore.getState().saveAndActivateProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result.validation.ok).toBe(false)
    expect(api.setActiveProvider).not.toHaveBeenCalled()
    // The failed provider is kept (flagged as unverified), not rolled back.
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

describe('settings store: hasEnteredApp latch (onboarding is first-run only)', () => {
  it('latches on when load finds both gates ready', async () => {
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: true })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().hasEnteredApp).toBe(true)
  })

  it('stays off when load finds a gate unmet on a genuine first run', async () => {
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: false })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().hasEnteredApp).toBe(false)
  })

  it('does not turn back off when a later preflight flips a gate (provider select)', async () => {
    // Entered the app: both gates ready.
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: true })
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().hasEnteredApp).toBe(true)

    // Selecting a not-yet-validated provider makes the active provider not-ready again...
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: false })
    await useSettingsStore.getState().refreshPreflight()

    // ...but the app must stay entered so it doesn't jump back to onboarding.
    expect(useSettingsStore.getState().preflight.activeProviderReady).toBe(false)
    expect(useSettingsStore.getState().hasEnteredApp).toBe(true)
  })

  it('does not turn back off when settings is reopened (load) on an unready provider', async () => {
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: true })
    await useSettingsStore.getState().load()

    // Reopening settings triggers another load while the active provider is temporarily not-ready.
    api.getPreflight.mockResolvedValue({ claudeReady: true, activeProviderReady: false })
    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().hasEnteredApp).toBe(true)
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
})

describe('selectProviderModelOptions', () => {
  it('emits one option per catalog model for an official provider', () => {
    const options = selectProviderModelOptions([
      {
        id: 'off',
        type: 'official',
        name: 'GLM',
        vendorId: 'zhipu',
        models: ['glm-5.2', 'glm-4.7'],
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
        hasKey: true,
        needsKey: false
      },
      {
        id: 'local',
        type: 'claude-default',
        name: 'Local',
        models: [],
        hasKey: false,
        needsKey: false
      }
    ])

    expect(options).toEqual([
      { providerId: 'c', providerName: 'GW', providerType: 'custom', model: 'm' },
      // A provider with no concrete model still yields one selectable "default" entry (empty model).
      { providerId: 'local', providerName: 'Local', providerType: 'claude-default', model: '' }
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
})
