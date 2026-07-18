import { create } from 'zustand'

import type { OfficialVendorId } from '../../../shared/provider-registry'
import { providerValidationFailed } from '../../../shared/settings'
import type {
  ClaudeDetectResult,
  ClaudeInfo,
  ClaudeInstallProgressEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  EnvironmentCheckResult,
  ManagedClaudeRegistry,
  Preflight,
  AgentFrameworkId,
  AgentFrameworkView,
  ChatApiEndpoint,
  OpencodeInfo,
  ProviderType,
  ProviderView,
  RefreshProviderModelsResult,
  SettingsSnapshot,
  SkillView,
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillResult,
  SkillBundlePreview,
  ScanRepoResult,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult,
  ConnectorView,
  ConnectorDetailView,
  CustomServerView,
  NcbiCredentialsView,
  ToolPermission,
  SetNcbiCredentialsRequest,
  AddCustomServerRequest,
  UpdateCustomServerRequest,
  ConnectorApprovalRequest,
  ApprovalDecision
} from '../../../shared/settings'

// Result of the combined onboarding save flow (create/edit -> validate -> activate).
type SaveProviderResult = {
  providerId: string
  validation: ValidateProviderResult
}

type SettingsStoreData = {
  isLoaded: boolean
  claude: ClaudeInfo
  activeProviderId: string | undefined
  // Active model within the active provider; undefined means the provider's own default.
  activeModel: string | undefined
  providers: ProviderView[]
  // Selected agent backend and the frameworks available to choose from.
  agentFrameworkId: AgentFrameworkId
  agentFrameworks: AgentFrameworkView[]
  // Detected opencode executable, for the framework-aware detection card.
  opencode: OpencodeInfo
  // Whether each framework's detected runtime is the app-managed install (only these can be uninstalled
  // in-app). Mirrored from the main-process snapshot; a PATH/npm binary reads false.
  claudeManaged: boolean
  opencodeManaged: boolean
  onboardingCompletedAt: number | undefined
  // Bundled skills with their enabled state, loaded lazily when the Skills panel opens.
  skills: SkillView[]
  // Bundled connectors with their enabled/auto-allow state, loaded lazily when the Connectors panel opens.
  connectors: ConnectorView[]
  // User-added custom MCP servers, reconciled alongside the connectors list.
  customServers: CustomServerView[]
  // Pending per-call connector approval requests (external data-egress gate), oldest first.
  pendingApprovals: ConnectorApprovalRequest[]
  // Shared NCBI credential state (never the plaintext key), reconciled alongside the connectors list.
  ncbi: NcbiCredentialsView
  preflight: Preflight
  encryptionAvailable: boolean
  npmAvailable: boolean
  environmentCheck: EnvironmentCheckResult | undefined
  environmentCheckError: string | undefined
  // Transient UI state for the wizard/settings page.
  isCheckingEnvironment: boolean
  // Framework the in-flight environment check was issued for. Used ONLY for the React Strict Mode
  // de-dup: a same-framework duplicate mount reuses the running pass instead of double-probing.
  // Staleness/ownership is decided by envCheckGeneration, never by this field.
  checkingFramework: AgentFrameworkId | undefined
  // Monotonic token stamped by each checkEnvironment call. The success/catch/finally branches only
  // mutate shared state when their captured generation is still current, so an older pass (even one
  // for the same framework, as in a Claude -> OpenCode -> Claude ABA sequence) can never overwrite,
  // fail, or clear the loading flags of a newer pass.
  envCheckGeneration: number
  isDetectingClaude: boolean
  isDetectingOpencode: boolean
  isInstalling: boolean
  installLogs: string[]
  // Latest progress tick driving the install progress bar; null when no install is active.
  installProgress: ClaudeInstallProgressEvent | null
  // Error message from the last install attempt; drives auto-expansion of the log pane. Undefined on
  // success or before the first attempt.
  installError: string | undefined
  // Explicit repair navigation. Completed users stay on Home during background checks and enter the
  // environment page only after choosing the required-item alert.
  isEnvironmentRepairOpen: boolean
  // Whether the settings dialog is open (rendered at the app root, over Home/Workspace).
  isSettingsOpen: boolean
  // Skill to land on when the dialog opens from a skill mention; consumed once its detail is seeded.
  pendingSkillId?: string
}

type SettingsStore = SettingsStoreData & {
  load: () => Promise<void>
  refreshPreflight: () => Promise<Preflight>
  checkEnvironment: () => Promise<EnvironmentCheckResult | undefined>
  detectClaude: () => Promise<ClaudeDetectResult>
  // Detects the opencode executable and refreshes its status card.
  detectOpencode: () => Promise<void>
  installClaude: (
    source: ClaudeInstallSource,
    managedRegistry?: ManagedClaudeRegistry
  ) => Promise<ClaudeInstallResult>
  // App-managed OpenCode install; shares the install progress/log state with installClaude.
  installOpencode: (source?: ClaudeInstallSource) => Promise<ClaudeInstallResult>
  // Removes the app-managed runtime for a framework (guarded main-side to app-managed installs) and
  // applies the refreshed snapshot; main reconnects the agent so the next prompt uses the new state.
  uninstallClaude: () => Promise<void>
  uninstallOpencode: () => Promise<void>
  clearInstallLogs: () => void
  openEnvironmentRepair: () => void
  closeEnvironmentRepair: () => void
  // Persists the draft (create/update) without testing it, returning the affected provider id. The
  // Settings page uses this to return to the list immediately, then tests in the background.
  persistProvider: (request: UpsertProviderRequest) => Promise<string>
  // Persists the draft and validates it, without changing the active provider.
  saveProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  // Combined onboarding flow: persist + validate + activate only on success.
  saveAndActivateProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  // Fetches a saved provider's live model list from the vendor and refreshes the cache on success.
  refreshProviderModels: (providerId: string) => Promise<RefreshProviderModelsResult>
  // Activates a provider and, optionally, a specific model within it (composer model switch). An
  // omitted model lets main fall back to the provider's default.
  setActiveProvider: (providerId: string, model?: string) => Promise<void>
  // Switches the agent backend (main reconnects so the next prompt uses it).
  setAgentFramework: (id: AgentFrameworkId) => Promise<void>
  deleteProvider: (providerId: string) => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  // Opens the dialog straight onto a skill's detail page (used by clickable skill mentions).
  openSettingsToSkill: (skillId: string) => void
  // Clears the pending skill once its detail view has been seeded, so a later open starts fresh.
  consumePendingSkill: () => void
  // Loads the bundled-skill list (enabled state included) from the main process.
  loadSkills: () => Promise<void>
  // Toggles one skill; optimistic, then reconciled with the authoritative list from main.
  setSkillEnabled: (id: string, enabled: boolean) => Promise<void>
  // Creates a personal skill, returning its refreshed list.
  createSkill: (request: CreateSkillRequest) => Promise<void>
  // Updates a personal skill in place.
  updateSkill: (request: UpdateSkillRequest) => Promise<void>
  // Deletes a personal or imported skill.
  deleteSkill: (id: string) => Promise<void>
  // Imports a skill from a public GitHub URL, returning the import outcome.
  importSkill: (url: string) => Promise<ImportSkillResult>
  // Imports a skill from an uploaded .zip / .skill bundle (base64), returning the outcome.
  // Imports a skill from an uploaded .zip / .skill bundle (base64). With `replaceId`, the bundle
  // overwrites that already-imported skill in place instead of creating a new one.
  importSkillZip: (
    dataBase64: string,
    opts?: { subPath?: string; replaceId?: string }
  ) => Promise<ImportSkillResult>
  // Parses an uploaded bundle without importing it, for a confirm-before-import preview.
  previewSkillZip: (dataBase64: string) => Promise<SkillBundlePreview[]>
  // Scans a GitHub repo for importable skill directories (does not mutate state).
  scanRepoSkills: (repo: string) => Promise<ScanRepoResult>
  // Loads the bundled-connector list (enabled/auto-allow + NCBI credential state) from main.
  loadConnectors: () => Promise<void>
  // Toggles one connector; optimistic, then reconciled with the authoritative snapshot from main.
  setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>
  // Toggles a connector's "skip approvals" flag; optimistic, then reconciled from main.
  setConnectorAutoAllow: (id: string, autoAllow: boolean) => Promise<void>
  // Sets one tool's permission, returning the affected connector's refreshed detail view (held
  // locally by the component, so nothing is stored here).
  setToolPermission: (toolId: string, permission: ToolPermission) => Promise<ConnectorDetailView>
  // Persists NCBI credentials and reconciles the connectors list + credential state from main.
  setNcbiCredentials: (request: SetNcbiCredentialsRequest) => Promise<void>
  // Adds a custom MCP server (add-time trust is confirmed in the UI), reconciling from main.
  addCustomServer: (request: AddCustomServerRequest) => Promise<void>
  // Edits an existing custom MCP server (name is immutable), reconciling from main.
  updateCustomServer: (request: UpdateCustomServerRequest) => Promise<void>
  // Enables/disables one custom MCP server; optimistic, then reconciled from main.
  setCustomServerEnabled: (id: string, enabled: boolean) => Promise<void>
  // Removes one custom MCP server, reconciling from main.
  removeCustomServer: (id: string) => Promise<void>
  // Queues an incoming approval request (from the main-process connector gate).
  enqueueApproval: (request: ConnectorApprovalRequest) => void
  // Sends the user's decision to main and drops the request from the queue.
  respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>
  // Persists the first-run completion marker and caches it so the startup gate falls through to Home.
  completeOnboarding: () => Promise<void>
}

const createInitialPreflight = (): Preflight => ({
  claudeReady: false,
  opencodeReady: false,
  agentFrameworkId: 'claude-code',
  agentReady: false,
  activeProviderReady: false
})

export const createInitialSettingsState = (): SettingsStoreData => ({
  isLoaded: false,
  claude: {},
  activeProviderId: undefined,
  activeModel: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  claudeManaged: false,
  opencodeManaged: false,
  onboardingCompletedAt: undefined,
  skills: [],
  connectors: [],
  customServers: [],
  pendingApprovals: [],
  ncbi: { hasApiKey: false },
  preflight: createInitialPreflight(),
  encryptionAvailable: true,
  npmAvailable: true,
  environmentCheck: undefined,
  environmentCheckError: undefined,
  isCheckingEnvironment: false,
  checkingFramework: undefined,
  envCheckGeneration: 0,
  isDetectingClaude: false,
  isDetectingOpencode: false,
  isInstalling: false,
  installLogs: [],
  installProgress: null,
  installError: undefined,
  isEnvironmentRepairOpen: false,
  isSettingsOpen: false,
  pendingSkillId: undefined
})

// Applies a fresh main-process snapshot to the renderer cache.
const applySnapshot = (snapshot: SettingsSnapshot): Partial<SettingsStoreData> => ({
  claude: snapshot.claude,
  activeProviderId: snapshot.activeProviderId,
  activeModel: snapshot.activeModel,
  providers: snapshot.providers,
  agentFrameworkId: snapshot.agentFrameworkId,
  agentFrameworks: snapshot.agentFrameworks,
  opencode: snapshot.opencode,
  claudeManaged: snapshot.claudeManaged,
  opencodeManaged: snapshot.opencodeManaged,
  onboardingCompletedAt: snapshot.onboardingCompletedAt
})

// Stable fallback reference so the selector returns the same array identity across renders
// (a fresh literal would make useSettingsStore re-render every tick and loop).
const DEFAULT_FRAMEWORK_API_ENDPOINTS: ChatApiEndpoint[] = ['anthropic']

// The chat endpoints the currently-selected agent framework can drive; a provider is only usable when
// it shares one. Defaults to Anthropic /v1/messages before the framework list has loaded.
export const selectFrameworkApiEndpoints = (state: SettingsStoreData): ChatApiEndpoint[] =>
  state.agentFrameworks.find((framework) => framework.id === state.agentFrameworkId)
    ?.supportedApiTypes ?? DEFAULT_FRAMEWORK_API_ENDPOINTS

// A single selectable (provider, model) entry for the composer picker. `model` is '' for a provider
// with no concrete model (a claude-default without an override), meaning "use the provider default".
export type ProviderModelOption = {
  providerId: string
  providerName: string
  providerType: ProviderType
  vendorId?: OfficialVendorId
  model: string
}

// Flattens providers into the composer's (provider, model) options: one per catalog model for an
// official vendor, the single model for a custom provider, and one default entry for a provider that
// exposes no concrete model. Providers whose last test failed are excluded so a broken provider can't
// be picked as a model source. Pure so the composer and its tests can share it.
export const selectProviderModelOptions = (providers: ProviderView[]): ProviderModelOption[] =>
  providers
    .filter((provider) => !providerValidationFailed(provider))
    .flatMap((provider) => {
      const models = provider.models.length > 0 ? provider.models : ['']

      return models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        vendorId: provider.vendorId,
        model
      }))
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

    set({
      ...applySnapshot(snapshot),
      preflight,
      encryptionAvailable,
      npmAvailable,
      isLoaded: true
    })
  },

  // Re-checks the two startup gates without reloading the whole snapshot.
  refreshPreflight: async () => {
    const preflight = await window.api.settings.getPreflight()

    set({ preflight })

    return preflight
  },

  // Full startup inspection: main owns filesystem/network/runtime probes; the renderer caches only
  // their structured, non-secret result. Refresh settings/preflight afterwards because detection may
  // have discovered and persisted a Claude installation that appeared since the previous launch.
  checkEnvironment: async () => {
    // React Strict Mode intentionally re-runs mount effects in development. Reuse the in-flight pass
    // only when it targets the currently-selected framework: an auto-switch (e.g. Claude -> a detected
    // OpenCode) changes the target mid-flight, and that call must issue its own probe rather than reuse
    // the previous framework's, or Continue stays disabled on a result that no longer matches.
    const framework = get().agentFrameworkId
    if (get().isCheckingEnvironment && get().checkingFramework === framework) {
      return get().environmentCheck
    }

    // Stamp a fresh generation; only the branch whose captured token is still current may mutate
    // shared state. This defeats an ABA sequence (Claude -> OpenCode -> Claude) where an older pass
    // shares the framework id of the newest one and would otherwise pass a framework-only staleness
    // check.
    const generation = get().envCheckGeneration + 1

    set({
      envCheckGeneration: generation,
      isCheckingEnvironment: true,
      checkingFramework: framework,
      isDetectingClaude: true,
      environmentCheckError: undefined
    })

    try {
      const environmentCheck = await window.api.settings.checkEnvironment()
      const [snapshot, preflight, npmAvailable] = await Promise.all([
        window.api.settings.getSettings(),
        window.api.settings.getPreflight(),
        window.api.settings.isNpmAvailable()
      ])

      // Discard a stale result: a newer pass has stamped a later generation and now owns the visible
      // state, so this older probe must not overwrite it (defensively also require the result to
      // still match the selected framework).
      if (
        get().envCheckGeneration !== generation ||
        environmentCheck.agentFrameworkId !== get().agentFrameworkId
      ) {
        return environmentCheck
      }

      set({
        ...applySnapshot(snapshot),
        environmentCheck,
        preflight,
        npmAvailable
      })

      return environmentCheck
    } catch (error) {
      // A late failure from a superseded pass must not clobber a newer pass's successful result.
      if (get().envCheckGeneration === generation) {
        set({
          environmentCheckError:
            error instanceof Error ? error.message : 'Environment detection could not be completed.'
        })
      }
      return undefined
    } finally {
      // Only clear the loading flags when this pass is still the current one; a newer pass may
      // already be running and now owns them.
      set((state) =>
        state.envCheckGeneration === generation
          ? { isCheckingEnvironment: false, checkingFramework: undefined, isDetectingClaude: false }
          : {}
      )
    }
  },

  // Detects claude and folds the resolved path/version back into the cache.
  detectClaude: async () => {
    set({ isDetectingClaude: true })

    try {
      // Re-detect claude and npm together so a mid-onboarding Node.js install is picked up by the same
      // Re-detect action. npm has no separate refresh; it was previously latched at load() only, so
      // users who installed Node.js after opening onboarding were stuck until an app restart.
      const [result, npmAvailable] = await Promise.all([
        window.api.settings.detectClaude(),
        window.api.settings.isNpmAvailable()
      ])

      set(() =>
        result.found && result.path
          ? { npmAvailable, claude: { resolvedPath: result.path, version: result.version } }
          : { npmAvailable }
      )

      await get().refreshPreflight()

      return result
    } finally {
      set({ isDetectingClaude: false })
    }
  },

  // Runs a one-click install, streaming events into installProgress/installLogs, then refreshes
  // settings/preflight. Log and progress share one channel, routed here by `kind`.
  installClaude: async (source, managedRegistry) => {
    set({ isInstalling: true, installLogs: [], installProgress: null, installError: undefined })

    const unsubscribe = window.api.settings.onInstallLog((event) => {
      if (event.kind === 'progress') {
        set({ installProgress: event })
      } else {
        set((state) => ({ installLogs: [...state.installLogs, event.chunk] }))
      }
    })

    try {
      const result = await window.api.settings.installClaude({ source, managedRegistry })

      // A successful install re-detects claude in main; reload so the cache reflects it.
      const snapshot = await window.api.settings.getSettings()

      set(applySnapshot(snapshot))
      await get().refreshPreflight()

      set({ installError: result.ok ? undefined : (result.error ?? 'Install failed.') })

      return result
    } catch (error) {
      set({ installError: error instanceof Error ? error.message : 'Install failed.' })
      throw error
    } finally {
      unsubscribe()
      set({ isInstalling: false, installProgress: null })
    }
  },

  // App-managed OpenCode install, mirroring installClaude's shared progress/log handling.
  installOpencode: async (source = 'managed') => {
    set({ isInstalling: true, installLogs: [], installProgress: null, installError: undefined })

    const unsubscribe = window.api.settings.onInstallLog((event) => {
      if (event.kind === 'progress') {
        set({ installProgress: event })
      } else {
        set((state) => ({ installLogs: [...state.installLogs, event.chunk] }))
      }
    })

    try {
      const result = await window.api.settings.installOpencode({ source })

      // A successful install persisted opencode's path/version in main; reload so the card reflects it.
      set(applySnapshot(await window.api.settings.getSettings()))
      await get().refreshPreflight()
      set({ installError: result.ok ? undefined : (result.error ?? 'Install failed.') })

      return result
    } catch (error) {
      set({ installError: error instanceof Error ? error.message : 'Install failed.' })
      throw error
    } finally {
      unsubscribe()
      set({ isInstalling: false, installProgress: null })
    }
  },

  // Removes the app-managed Claude runtime; main deletes it, re-detects, and may auto-switch the active
  // framework. Applies the refreshed snapshot and re-evaluates the readiness gate.
  uninstallClaude: async () => {
    set(applySnapshot(await window.api.settings.uninstallClaude()))
    await get().refreshPreflight()
  },

  // Removes the app-managed OpenCode runtime, mirroring uninstallClaude.
  uninstallOpencode: async () => {
    set(applySnapshot(await window.api.settings.uninstallOpencode()))
    await get().refreshPreflight()
  },

  clearInstallLogs: () => set({ installLogs: [], installProgress: null, installError: undefined }),

  openEnvironmentRepair: () => set({ isEnvironmentRepairOpen: true }),

  closeEnvironmentRepair: () => set({ isEnvironmentRepairOpen: false }),

  // Persists a provider draft (create/update) and refreshes derived state, without testing it.
  persistProvider: async (request) => {
    const before = get().providers
    const afterUpsert = await window.api.settings.upsertProvider(request)

    set(applySnapshot(afterUpsert))
    await get().refreshPreflight()

    return resolveUpsertedProviderId(request, before, afterUpsert.providers) ?? ''
  },

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

    // Refresh so the validated-at time / recorded failure / masked key reflect the latest stored
    // state. A failed test keeps the provider (flagged as unverified in the list and excluded from the
    // model pickers); it is not rolled back, so the user can fix the key and retry.
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

    // Refresh whenever a saved provider was tested, pass or fail: success stamps lastValidatedAt, a
    // failure records the reason and surfaces the "unverified" warning. Draft validations (no
    // providerId) change nothing stored, so they skip the refresh.
    if (request.providerId) {
      set(applySnapshot(await window.api.settings.getSettings()))
      await get().refreshPreflight()
    }

    return result
  },

  // Fetches a provider's live models from the vendor; on success the persisted list is reflected here.
  refreshProviderModels: async (providerId) => {
    const result = await window.api.settings.refreshProviderModels({ providerId })

    if (result.ok) {
      set(applySnapshot(await window.api.settings.getSettings()))
    }

    return result
  },

  // Switches the active provider/model (main drops the agent connection so the next prompt reconnects).
  // An empty model string is treated as "no specific model" so main uses the provider default.
  setActiveProvider: async (providerId, model) => {
    const snapshot = await window.api.settings.setActiveProvider({
      id: providerId,
      model: model || undefined
    })

    set(applySnapshot(snapshot))
    await get().refreshPreflight()
  },

  // Switches the agent backend; main reconnects so the choice applies on the next prompt. Surfaces
  // failures (e.g. a stale preload bundle where the IPC is missing after a renderer-only hot reload)
  // to the console instead of silently reverting the selector.
  setAgentFramework: async (id) => {
    try {
      set(applySnapshot(await window.api.settings.setAgentFramework({ id })))
      // Live-detect the newly-selected framework so a binary installed (or deleted) since the last
      // check is reflected right away, then refresh the readiness gate the install prompt keys off.
      if (id === 'opencode') {
        await get().detectOpencode()
      } else {
        await get().detectClaude()
      }
      await get().refreshPreflight()
    } catch (error) {
      console.error('Failed to switch agent framework', error)
    }
  },

  // Detects the opencode executable and refreshes its status card.
  detectOpencode: async () => {
    set({ isDetectingOpencode: true })

    try {
      set(applySnapshot(await window.api.settings.detectOpencode()))
    } finally {
      set({ isDetectingOpencode: false })
    }
  },

  deleteProvider: async (providerId) => {
    const snapshot = await window.api.settings.deleteProvider({ id: providerId })

    set(applySnapshot(snapshot))
    await get().refreshPreflight()
  },

  openSettings: () => set({ isSettingsOpen: true }),

  // Clearing the pending skill on close stops a later normal open from jumping back to a stale skill.
  closeSettings: () => set({ isSettingsOpen: false, pendingSkillId: undefined }),

  openSettingsToSkill: (skillId) => set({ isSettingsOpen: true, pendingSkillId: skillId }),

  consumePendingSkill: () => set({ pendingSkillId: undefined }),

  loadSkills: async () => {
    const skills = await window.api.settings.listSkills()
    set({ skills })
  },

  // Optimistically flips the toggle, then reconciles with the authoritative list from main.
  setSkillEnabled: async (id, enabled) => {
    set((state) => ({
      skills: state.skills.map((skill) => (skill.id === id ? { ...skill, enabled } : skill))
    }))
    const skills = await window.api.settings.setSkillEnabled({ id, enabled })
    set({ skills })
  },

  createSkill: async (request) => {
    const skills = await window.api.settings.createSkill(request)
    set({ skills })
  },

  updateSkill: async (request) => {
    const skills = await window.api.settings.updateSkill(request)
    set({ skills })
  },

  deleteSkill: async (id) => {
    const skills = await window.api.settings.deleteSkill({ id })
    set({ skills })
  },

  importSkill: async (url) => {
    const result = await window.api.settings.importSkill({ url })
    set({ skills: result.skills })
    return result
  },

  importSkillZip: async (dataBase64, opts) => {
    const result = await window.api.settings.importSkillZip({
      dataBase64,
      subPath: opts?.subPath,
      replaceId: opts?.replaceId
    })
    set({ skills: result.skills })
    return result
  },

  previewSkillZip: async (dataBase64) => window.api.settings.previewSkillZip({ dataBase64 }),

  scanRepoSkills: async (repo) => window.api.settings.scanRepoSkills({ repo }),

  loadConnectors: async () => {
    const { connectors, customServers, ncbi } = await window.api.settings.listConnectors()
    set({ connectors, customServers, ncbi })
  },

  // Optimistically flips the toggle, then reconciles with the authoritative snapshot from main.
  setConnectorEnabled: async (id, enabled) => {
    set((state) => ({
      connectors: state.connectors.map((connector) =>
        connector.id === id ? { ...connector, enabled } : connector
      )
    }))
    const { connectors, customServers, ncbi } = await window.api.settings.setConnectorEnabled({
      id,
      enabled
    })
    set({ connectors, customServers, ncbi })
  },

  // Optimistically flips "skip approvals", then reconciles from main.
  setConnectorAutoAllow: async (id, autoAllow) => {
    set((state) => ({
      connectors: state.connectors.map((connector) =>
        connector.id === id ? { ...connector, autoAllow } : connector
      )
    }))
    const { connectors, customServers, ncbi } = await window.api.settings.setConnectorAutoAllow({
      id,
      autoAllow
    })
    set({ connectors, customServers, ncbi })
  },

  setToolPermission: async (toolId, permission) =>
    window.api.settings.setToolPermission({ toolId, permission }),

  setNcbiCredentials: async (request) => {
    const { connectors, customServers, ncbi } =
      await window.api.settings.setNcbiCredentials(request)
    set({ connectors, customServers, ncbi })
  },

  addCustomServer: async (request) => {
    const { connectors, customServers, ncbi } = await window.api.settings.addCustomServer(request)
    set({ connectors, customServers, ncbi })
  },

  updateCustomServer: async (request) => {
    const { connectors, customServers, ncbi } =
      await window.api.settings.updateCustomServer(request)
    set({ connectors, customServers, ncbi })
  },

  // Optimistically flips the server toggle, then reconciles from main.
  setCustomServerEnabled: async (id, enabled) => {
    set((state) => ({
      customServers: state.customServers.map((server) =>
        server.id === id ? { ...server, enabled } : server
      )
    }))
    const { connectors, customServers, ncbi } = await window.api.settings.setCustomServerEnabled({
      id,
      enabled
    })
    set({ connectors, customServers, ncbi })
  },

  removeCustomServer: async (id) => {
    const { connectors, customServers, ncbi } = await window.api.settings.removeCustomServer({ id })
    set({ connectors, customServers, ncbi })
  },

  enqueueApproval: (request) => {
    set((state) =>
      state.pendingApprovals.some((r) => r.id === request.id)
        ? state
        : { pendingApprovals: [...state.pendingApprovals, request] }
    )
  },

  respondApproval: async (id, decision) => {
    // Drop it from the queue immediately so the card can't be double-answered, then notify main.
    set((state) => ({ pendingApprovals: state.pendingApprovals.filter((r) => r.id !== id) }))
    await window.api.settings.respondConnectorApproval({ id, decision })
  },

  completeOnboarding: async () => {
    const snapshot = await window.api.settings.markOnboardingComplete()

    set(applySnapshot(snapshot))
  }
}))

export type { SaveProviderResult }
