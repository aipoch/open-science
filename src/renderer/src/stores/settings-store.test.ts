import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsSnapshot, ValidateProviderResult } from '../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from './settings-store'

// Minimal window.api.settings surface the store calls.
type SettingsApi = {
  getSettings: ReturnType<typeof vi.fn>
  getPreflight: ReturnType<typeof vi.fn>
  isEncryptionAvailable: ReturnType<typeof vi.fn>
  isNpmAvailable: ReturnType<typeof vi.fn>
  upsertProvider: ReturnType<typeof vi.fn>
  validateProvider: ReturnType<typeof vi.fn>
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
