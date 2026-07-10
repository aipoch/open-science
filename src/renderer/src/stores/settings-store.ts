import { create } from 'zustand'

import type {
  ClaudeDetectResult,
  ClaudeInfo,
  ClaudeInstallResult,
  ClaudeInstallSource,
  Preflight,
  ProviderView,
  SettingsSnapshot,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../../shared/settings'

// Result of the combined onboarding save flow (create/edit -> validate -> activate).
type SaveProviderResult = {
  providerId: string
  validation: ValidateProviderResult
}

// A planned provider switch: which provider to activate, which sessions are mid-turn, and whether the
// caller must confirm the interruption first.
type ProviderSwitchPlan = {
  providerId: string
  runningSessionIds: string[]
  needsConfirm: boolean
}

type SettingsStoreData = {
  isLoaded: boolean
  claude: ClaudeInfo
  activeProviderId: string | undefined
  providers: ProviderView[]
  preflight: Preflight
  // Latched true the first time both startup gates pass. Onboarding is a first-run gate, so once the
  // user has entered the app, later provider changes (which may momentarily flip a gate) must not send
  // them back to the wizard — the app reads this instead of preflight alone to decide onboarding.
  hasEnteredApp: boolean
  encryptionAvailable: boolean
  npmAvailable: boolean
  // Transient UI state for the wizard/settings page.
  isDetectingClaude: boolean
  isInstalling: boolean
  installLogs: string[]
  // Whether the settings dialog is open (rendered at the app root, over Home/Workspace).
  isSettingsOpen: boolean
}

type SettingsStore = SettingsStoreData & {
  load: () => Promise<void>
  refreshPreflight: () => Promise<Preflight>
  detectClaude: () => Promise<ClaudeDetectResult>
  installClaude: (source: ClaudeInstallSource) => Promise<ClaudeInstallResult>
  clearInstallLogs: () => void
  // Persists the draft and validates it, without changing the active provider.
  saveProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  // Combined onboarding flow: persist + validate + activate only on success.
  saveAndActivateProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  setActiveProvider: (providerId: string) => Promise<void>
  // Reads the ACP runtime snapshot to decide whether switching needs an interrupt confirmation.
  prepareProviderSwitch: (providerId: string) => Promise<ProviderSwitchPlan>
  // Interrupts the given in-flight turns (existing cancel path), then switches the active provider.
  interruptAndSetActiveProvider: (providerId: string, runningSessionIds: string[]) => Promise<void>
  deleteProvider: (providerId: string) => Promise<void>
  openSettings: () => void
  closeSettings: () => void
}

const createInitialPreflight = (): Preflight => ({
  claudeReady: false,
  activeProviderReady: false
})

// Both hard startup gates satisfied — the condition that latches hasEnteredApp and clears onboarding.
const isPreflightReady = (preflight: Preflight): boolean =>
  preflight.claudeReady && preflight.activeProviderReady

export const createInitialSettingsState = (): SettingsStoreData => ({
  isLoaded: false,
  claude: {},
  activeProviderId: undefined,
  providers: [],
  preflight: createInitialPreflight(),
  hasEnteredApp: false,
  encryptionAvailable: true,
  npmAvailable: true,
  isDetectingClaude: false,
  isInstalling: false,
  installLogs: [],
  isSettingsOpen: false
})

// Applies a fresh main-process snapshot to the renderer cache.
const applySnapshot = (snapshot: SettingsSnapshot): Partial<SettingsStoreData> => ({
  claude: snapshot.claude,
  activeProviderId: snapshot.activeProviderId,
  providers: snapshot.providers
})

// Finds the provider id affected by an upsert: the edited id, or the one new since `before`.
const resolveUpsertedProviderId = (
  request: UpsertProviderRequest,
  before: ProviderView[],
  after: ProviderView[]
): string | undefined => {
  if (request.id) return request.id

  const beforeIds = new Set(before.map((provider) => provider.id))

  return after.find((provider) => !beforeIds.has(provider.id))?.id
}

// Renderer cache of the main-process settings service. The main process stays the source of truth
// for secrets; this store only ever holds masked provider views.
export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...createInitialSettingsState(),

  // Loads settings, preflight, and encryption availability in one startup pass.
  load: async () => {
    const [snapshot, preflight, encryptionAvailable, npmAvailable] = await Promise.all([
      window.api.settings.getSettings(),
      window.api.settings.getPreflight(),
      window.api.settings.isEncryptionAvailable(),
      window.api.settings.isNpmAvailable()
    ])

    set((state) => ({
      ...applySnapshot(snapshot),
      preflight,
      // Latch on only; a later load (e.g. reopening settings on a not-yet-validated provider) must
      // never turn this back off and resurrect onboarding.
      hasEnteredApp: state.hasEnteredApp || isPreflightReady(preflight),
      encryptionAvailable,
      npmAvailable,
      isLoaded: true
    }))
  },

  // Re-checks the two startup gates without reloading the whole snapshot.
  refreshPreflight: async () => {
    const preflight = await window.api.settings.getPreflight()

    // Latch hasEnteredApp on (never off): once the app is entered, a later gate flip in settings must
    // not resurrect the onboarding wizard.
    set((state) => ({
      preflight,
      hasEnteredApp: state.hasEnteredApp || isPreflightReady(preflight)
    }))

    return preflight
  },

  // Detects claude and folds the resolved path/version back into the cache.
  detectClaude: async () => {
    set({ isDetectingClaude: true })

    try {
      const result = await window.api.settings.detectClaude()

      if (result.found && result.path) {
        set({ claude: { resolvedPath: result.path, version: result.version } })
      }

      await get().refreshPreflight()

      return result
    } finally {
      set({ isDetectingClaude: false })
    }
  },

  // Runs a one-click install, streaming output into installLogs, then refreshes settings/preflight.
  installClaude: async (source) => {
    set({ isInstalling: true, installLogs: [] })

    const unsubscribe = window.api.settings.onInstallLog((event) => {
      set((state) => ({ installLogs: [...state.installLogs, event.chunk] }))
    })

    try {
      const result = await window.api.settings.installClaude({ source })

      // A successful install re-detects claude in main; reload so the cache reflects it.
      const snapshot = await window.api.settings.getSettings()

      set(applySnapshot(snapshot))
      await get().refreshPreflight()

      return result
    } finally {
      unsubscribe()
      set({ isInstalling: false })
    }
  },

  clearInstallLogs: () => set({ installLogs: [] }),

  // Persists a provider draft and validates it (without activating), refreshing derived state.
  saveProvider: async (request) => {
    const before = get().providers
    const afterUpsert = await window.api.settings.upsertProvider(request)

    set(applySnapshot(afterUpsert))

    const providerId = resolveUpsertedProviderId(request, before, afterUpsert.providers)

    if (!providerId) {
      return { providerId: '', validation: { ok: false, category: 'unknown' } }
    }

    const validation = await window.api.settings.validateProvider({ providerId })

    // Refresh so the validated-at timestamp / masked key reflect the latest stored state.
    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()

    return { providerId, validation }
  },

  // Persists a provider draft, validates it, and activates it only when validation passes.
  saveAndActivateProvider: async (request) => {
    const result = await get().saveProvider(request)

    if (result.validation.ok && result.providerId) {
      await get().setActiveProvider(result.providerId)
    }

    return result
  },

  // Validates a saved provider or draft without changing the active selection.
  validateProvider: async (request) => {
    const result = await window.api.settings.validateProvider(request)

    if (result.ok) {
      set(applySnapshot(await window.api.settings.getSettings()))
      await get().refreshPreflight()
    }

    return result
  },

  // Switches the active provider (main drops the agent connection so the next prompt reconnects).
  setActiveProvider: async (providerId) => {
    const snapshot = await window.api.settings.setActiveProvider({ id: providerId })

    set(applySnapshot(snapshot))
    await get().refreshPreflight()
  },

  // Inspects the ACP runtime for in-flight turns so the caller can confirm before interrupting them.
  prepareProviderSwitch: async (providerId) => {
    const { promptInFlightSessionIds } = await window.api.acp.getState()

    return {
      providerId,
      runningSessionIds: promptInFlightSessionIds,
      needsConfirm: promptInFlightSessionIds.length > 0
    }
  },

  // Interrupts each in-flight turn (reusing the existing acp cancel path), then switches the active
  // provider. Interrupted turns are not auto-resumed; the user continues by sending a new message.
  interruptAndSetActiveProvider: async (providerId, runningSessionIds) => {
    for (const sessionId of runningSessionIds) {
      await window.api.acp.cancel({ sessionId })
    }

    await get().setActiveProvider(providerId)
  },

  deleteProvider: async (providerId) => {
    const snapshot = await window.api.settings.deleteProvider({ id: providerId })

    set(applySnapshot(snapshot))
    await get().refreshPreflight()
  },

  openSettings: () => set({ isSettingsOpen: true }),

  closeSettings: () => set({ isSettingsOpen: false })
}))

export type { ProviderSwitchPlan, SaveProviderResult }
