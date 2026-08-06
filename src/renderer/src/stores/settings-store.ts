import { create, type StoreApi } from 'zustand'

import type { OfficialVendorId } from '../../../shared/provider-registry'
import {
  DEFAULT_APP_ICON_VARIANT,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isClaudeSubscriptionProvider,
  providerValidationFailed,
  selectClaudeSubscriptionProvider
} from '../../../shared/settings'
import type { PackageMirror } from '../../../shared/mirror'
import type { CloseActionPreference } from '../../../shared/window-controls'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import {
  createSettingsWriteCoordinator,
  type SettingsWriteCoordinator
} from './settings-write-coordinator'
import {
  createInitialSettingsNavigationState,
  createSettingsNavigationSlice,
  type SettingsNavigationActions,
  type SettingsNavigationState
} from './settings-navigation-slice'
import {
  createSettingsPreferencesSlice,
  type SettingsPreferencesActions
} from './settings-preferences-slice'
import {
  createProviderAuthSlice,
  type ProviderAuthActions,
  type SaveProviderResult
} from './settings-provider-auth-slice'
import {
  createInitialRuntimeSetupState,
  createRuntimeSetupLoadPatch,
  createRuntimeSetupSlice,
  type RuntimeSetupActions,
  type RuntimeSetupState
} from './settings-runtime-slice'
export { selectAnyInstalling } from './settings-runtime-slice'
import type {
  ClaudeInfo,
  ClaudeSubscriptionProviderId,
  CodexInfo,
  AgentFrameworkId,
  AgentFrameworkView,
  ChatApiEndpoint,
  OpencodeInfo,
  ProviderType,
  ProviderView,
  ReasoningEffort,
  SettingsSnapshot,
  AppIconVariant,
  SkillView,
  AgentHomeSkillRef,
  AgentHomeSkillView,
  ImportAgentHomeSkillsResult,
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillResult,
  ImportSkillZipBatchResult,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  ScanRepoResult,
  ConnectorView,
  ConnectorDetailView,
  CustomServerView,
  NcbiCredentialsView,
  ToolPermission,
  SetNcbiCredentialsRequest,
  AddCustomServerRequest,
  AuthenticateCustomServerRequest,
  UpdateCustomServerRequest,
  ConnectorApprovalRequest,
  ApprovalDecision
} from '../../../shared/settings'

type SettingsStoreData = RuntimeSetupState &
  SettingsNavigationState & {
    isLoaded: boolean
    isLoading: boolean
    loadError: string | undefined
    // Latest failed Settings write, shown by the dialog until dismissed or another write starts.
    settingsWriteError: string | undefined
    settingsLoadGeneration: number
    claude: ClaudeInfo
    activeProviderId: string | undefined
    claudeSubscriptionProviderId: ClaudeSubscriptionProviderId | undefined
    // Active model within the active provider; undefined means the provider's own default.
    activeModel: string | undefined
    providers: ProviderView[]
    // Selected agent backend and the frameworks available to choose from.
    agentFrameworkId: AgentFrameworkId
    agentFrameworks: AgentFrameworkView[]
    // Detected opencode executable, for the framework-aware detection card.
    opencode: OpencodeInfo
    codex: CodexInfo
    // Whether each framework's detected runtime is the app-managed install (only these can be uninstalled
    // in-app). Mirrored from the main-process snapshot; a PATH/npm binary reads false.
    claudeManaged: boolean
    opencodeManaged: boolean
    codexManaged: boolean
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
    encryptionAvailable: boolean
    // Configured package mirror (conda/pip); undefined means public hosts (unconfigured).
    packageMirror?: PackageMirror
    // Reasoning-effort preference applied to agent requests; 'default' leaves the agent's own default.
    reasoningEffort: ReasoningEffort
    // Whether the app posts an OS notification when an agent task finishes or fails while unfocused.
    notificationsEnabled: boolean
    // Whether conversations receive the app-owned Skill package import tool and instructions.
    conversationSkillImportEnabled: boolean
    // Saved Windows titlebar-close behavior. Undefined means ask every time.
    closePreference: CloseActionPreference | undefined
    // Selected built-in app-icon look, applied to the window and dock/taskbar. Defaults to 'light'.
    appIconVariant: AppIconVariant
  }

type SettingsStoreCore = SettingsStoreData &
  ProviderAuthActions &
  SettingsPreferencesActions &
  SettingsNavigationActions &
  SettingsStoreActions

type SettingsStoreActions = {
  load: (options?: { force?: boolean }) => Promise<boolean>
  clearSettingsWriteError: () => void
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
  // Imports several skills from ONE uploaded bundle in a single call (decoded/unpacked once), returning
  // a per-item outcome. Per-item failures are reported inline without aborting the rest.
  importSkillZipBatch: (
    dataBase64: string,
    items: { subPath: string; replaceId?: string }[]
  ) => Promise<ImportSkillZipBatchResult>
  // Parses an uploaded bundle without importing it, for a confirm-before-import preview. Returns the
  // importable skills plus any the bundle contained that were skipped and why.
  previewSkillZip: (dataBase64: string) => Promise<SkillBundlePreviewResult>
  previewGitHubSkill: (url: string) => Promise<SkillImportPreviewContent>
  // Scans a GitHub repo for importable skill directories (does not mutate state).
  scanRepoSkills: (repo: string) => Promise<ScanRepoResult>
  // Lists the shared global skills plus the active framework's installed skills.
  listAgentHomeSkills: () => Promise<AgentHomeSkillView[]>
  previewAgentHomeSkill: (skill: AgentHomeSkillRef) => Promise<SkillImportPreviewContent>
  // Copies checked installed skills into the imported-skill store in one batch.
  importAgentHomeSkills: (skills: AgentHomeSkillRef[]) => Promise<ImportAgentHomeSkillsResult>
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
  authenticateCustomServer: (request: AuthenticateCustomServerRequest) => Promise<void>
  cancelCustomServerAuthentication: (request: AuthenticateCustomServerRequest) => Promise<void>
  // Enables/disables one custom MCP server; optimistic, then reconciled from main.
  setCustomServerEnabled: (id: string, enabled: boolean) => Promise<void>
  // Removes one custom MCP server, reconciling from main.
  removeCustomServer: (id: string) => Promise<void>
  // Queues an incoming approval request (from the main-process connector gate).
  enqueueApproval: (request: ConnectorApprovalRequest) => void
  // Sends the user's decision to main and drops the request from the queue.
  respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>
}

type SettingsStore = SettingsStoreCore & RuntimeSetupActions

export const createInitialSettingsState = (): SettingsStoreData => ({
  ...createInitialRuntimeSetupState(),
  ...createInitialSettingsNavigationState(),
  isLoaded: false,
  isLoading: false,
  loadError: undefined,
  settingsWriteError: undefined,
  settingsLoadGeneration: 0,
  claude: {},
  activeProviderId: undefined,
  claudeSubscriptionProviderId: undefined,
  activeModel: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  onboardingCompletedAt: undefined,
  skills: [],
  connectors: [],
  customServers: [],
  pendingApprovals: [],
  ncbi: { hasApiKey: false },
  encryptionAvailable: true,
  packageMirror: undefined,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
  conversationSkillImportEnabled: DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  closePreference: undefined,
  appIconVariant: DEFAULT_APP_ICON_VARIANT
})

// Applies a fresh main-process snapshot to the renderer cache.
const applySnapshot = (snapshot: SettingsSnapshot): Partial<SettingsStoreData> => ({
  claude: snapshot.claude,
  activeProviderId: snapshot.activeProviderId,
  claudeSubscriptionProviderId: snapshot.claudeSubscriptionProviderId,
  activeModel: snapshot.activeModel,
  providers: snapshot.providers,
  onboardingCompletedAt: snapshot.onboardingCompletedAt,
  packageMirror: isMirrorConfigured(snapshot.packageMirror) ? snapshot.packageMirror : undefined,
  reasoningEffort: snapshot.reasoningEffort,
  // Defensive: main always fills this, but an untyped snapshot (tests, older backends) must not
  // write undefined into the boolean preference.
  notificationsEnabled: snapshot.notificationsEnabled ?? DEFAULT_NOTIFICATIONS_ENABLED,
  conversationSkillImportEnabled:
    snapshot.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  closePreference: snapshot.closePreference,
  appIconVariant: snapshot.appIconVariant ?? DEFAULT_APP_ICON_VARIANT,
  agentFrameworkId: snapshot.agentFrameworkId,
  agentFrameworks: snapshot.agentFrameworks,
  opencode: snapshot.opencode,
  codex: snapshot.codex ?? {},
  claudeManaged: snapshot.claudeManaged,
  opencodeManaged: snapshot.opencodeManaged,
  codexManaged: snapshot.codexManaged ?? false
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
// with no concrete model, meaning "use the provider default".
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
export const selectProviderModelOptions = (
  providers: ProviderView[],
  activeProviderId?: string,
  claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
): ProviderModelOption[] => {
  const selectedClaudeProvider = selectClaudeSubscriptionProvider(
    providers,
    activeProviderId,
    claudeSubscriptionProviderId
  )

  return providers
    .filter(
      (provider) =>
        !isClaudeSubscriptionProvider(provider.type) || provider.id === selectedClaudeProvider?.id
    )
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
}

let settingsLoadPromise: Promise<boolean> | undefined
const SAFE_SETTINGS_LOAD_ERROR = 'Open Science could not load settings. Retry to continue.'

// Keep raw IPC diagnostics in the developer channel while renderer state remains path-safe.
const reportSettingsLoadError = (error: unknown): void => {
  console.warn('Settings startup loading failed', error)
}

// Renderer cache of the main-process settings service. The main process stays the source of truth
// for secrets; this store only ever holds masked provider views.
const createSettingsStoreState = (
  set: StoreApi<SettingsStore>['setState'],
  get: StoreApi<SettingsStore>['getState'],
  writeCoordinator: SettingsWriteCoordinator
): SettingsStore => ({
  ...createInitialSettingsState(),
  ...createRuntimeSetupSlice({
    set,
    get,
    // Resolve browser globals only when an action runs; node-based renderer tests import this store.
    getCommands: () => window.api.settings,
    reconcileSnapshot: (snapshot, runtimePatch = {}) =>
      set({ ...applySnapshot(snapshot), ...runtimePatch }),
    reconcileClaudeDetection: (result, npmAvailable) =>
      set(
        result.found && result.path
          ? { npmAvailable, claude: { resolvedPath: result.path, version: result.version } }
          : { npmAvailable }
      )
  }),
  ...createProviderAuthSlice({
    get,
    getCommands: () => window.api.settings,
    reconcileSnapshot: (snapshot) => set(applySnapshot(snapshot)),
    refreshPreflight: () => get().refreshPreflight(),
    refreshFrameworkStatus: async (id) => {
      if (id === 'opencode') {
        await get().detectOpencode()
      } else if (id === 'codex') {
        await get().detectCodex()
      } else {
        await get().detectClaude()
      }
      await get().refreshPreflight()
    },
    writeCoordinator
  }),
  ...createSettingsPreferencesSlice({
    getState: get,
    setState: (patch) => set(patch),
    getCommands: () => window.api.settings,
    reconcileSnapshot: (snapshot) => set(applySnapshot(snapshot)),
    writeCoordinator
  }),
  ...createSettingsNavigationSlice({ setState: (patch) => set(patch) }),

  // Loads settings, preflight, and encryption availability in one startup pass.
  load: (options) => {
    // StrictMode replays the startup effect. Reuse that identical in-flight pass so a duplicate
    // request cannot supersede its successful result; an explicit user retry still starts a new
    // generation and remains authoritative over any older request.
    if (!options?.force && settingsLoadPromise) return settingsLoadPromise

    const generation = get().settingsLoadGeneration + 1
    set({ settingsLoadGeneration: generation, isLoading: true, loadError: undefined })

    const loadPromise = (async (): Promise<boolean> => {
      try {
        const [snapshot, preflight, encryptionAvailable, npmAvailable] = await Promise.all([
          window.api.settings.getSettings(),
          window.api.settings.getPreflight(),
          window.api.settings.isEncryptionAvailable(),
          window.api.settings.isNpmAvailable()
        ])

        if (get().settingsLoadGeneration !== generation) return false

        set({
          ...applySnapshot(snapshot),
          ...createRuntimeSetupLoadPatch(preflight, npmAvailable),
          encryptionAvailable,
          isLoaded: true,
          isLoading: false,
          loadError: undefined
        })
        return true
      } catch (error) {
        if (get().settingsLoadGeneration !== generation) return false

        reportSettingsLoadError(error)
        set({
          isLoading: false,
          loadError: SAFE_SETTINGS_LOAD_ERROR
        })
        return false
      }
    })()

    settingsLoadPromise = loadPromise
    void loadPromise.then(() => {
      if (settingsLoadPromise === loadPromise) settingsLoadPromise = undefined
    })
    return loadPromise
  },

  clearSettingsWriteError: () => writeCoordinator.clearFailures(),

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

  importSkillZipBatch: async (dataBase64, items) => {
    const result = await window.api.settings.importSkillZipBatch({ dataBase64, items })
    set({ skills: result.skills })
    return result
  },

  previewSkillZip: async (dataBase64) => window.api.settings.previewSkillZip({ dataBase64 }),

  previewGitHubSkill: async (url) => window.api.settings.previewGitHubSkill({ url }),

  scanRepoSkills: async (repo) => window.api.settings.scanRepoSkills({ repo }),

  // Installed-skill discovery is read-only. Batch import returns the refreshed catalog directly.
  listAgentHomeSkills: async () => window.api.settings.listAgentHomeSkills(),
  previewAgentHomeSkill: async (skill) => window.api.settings.previewAgentHomeSkill(skill),
  importAgentHomeSkills: async (skills) => {
    const result = await window.api.settings.importAgentHomeSkills({ skills })
    set({ skills: result.skills })

    return result
  },

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

  authenticateCustomServer: async (request) => {
    try {
      const { connectors, customServers, ncbi } =
        await window.api.settings.authenticateCustomServer(request)
      set({ connectors, customServers, ncbi })
    } catch (error) {
      // Authentication can invalidate stale tokens before failing. Refresh the projection so the
      // connector does not remain visibly "Connected" after main has cleared its credentials.
      await get()
        .loadConnectors()
        .catch(() => undefined)
      throw error
    }
  },

  cancelCustomServerAuthentication: (request) =>
    window.api.settings.cancelCustomServerAuthentication(request),

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
  }
})

export const useSettingsStore = create<SettingsStore>((set, get) =>
  createSettingsStoreState(
    set,
    get,
    createSettingsWriteCoordinator((settingsWriteError) => set({ settingsWriteError }))
  )
)

export type { SaveProviderResult }
