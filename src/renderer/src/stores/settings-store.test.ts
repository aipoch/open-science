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
    deleteProvider: vi.fn()
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

describe('settings store: provider switch flow', () => {
  it('does not need confirmation when no session is running', async () => {
    acp.getState.mockResolvedValue({ promptInFlightSessionIds: [] })

    const plan = await useSettingsStore.getState().prepareProviderSwitch('p2')

    expect(plan).toEqual({ providerId: 'p2', runningSessionIds: [], needsConfirm: false })
  })

  it('needs confirmation and reports the running sessions when a turn is in flight', async () => {
    acp.getState.mockResolvedValue({ promptInFlightSessionIds: ['s1', 's2'] })

    const plan = await useSettingsStore.getState().prepareProviderSwitch('p2')

    expect(plan).toEqual({
      providerId: 'p2',
      runningSessionIds: ['s1', 's2'],
      needsConfirm: true
    })
  })

  it('interrupts every running session before switching the active provider', async () => {
    await useSettingsStore.getState().interruptAndSetActiveProvider('p2', ['s1', 's2'])

    // Both cancels must precede the switch so the in-flight turns are interrupted first.
    expect(callLog).toEqual(['cancel:s1', 'cancel:s2', 'setActive:p2'])
    expect(acp.cancel).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(acp.cancel).toHaveBeenCalledWith({ sessionId: 's2' })
    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p2' })
    expect(useSettingsStore.getState().activeProviderId).toBe('p2')
  })

  it('switches directly with no cancels when there are no running sessions', async () => {
    await useSettingsStore.getState().interruptAndSetActiveProvider('p2', [])

    expect(acp.cancel).not.toHaveBeenCalled()
    expect(callLog).toEqual(['setActive:p2'])
  })
})
