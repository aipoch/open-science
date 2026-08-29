import { create, type StoreApi } from 'zustand'

import {
  DEFAULT_APP_ICON_VARIANT,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  isCodexSubscriptionProvider
} from '../../../shared/settings'
import {
  buildConfiguredModelCatalog,
  buildConfiguredModelInventory,
  configuredModelKey
} from '../../../shared/configured-model-catalog'
import type { OfficialVendorId } from '../../../shared/provider-registry'
import type { PackageMirror } from '../../../shared/mirror'
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxySettings
} from '../../../shared/network-proxy'
import type { CloseActionPreference } from '../../../shared/window-controls'
import {
  DEFAULT_PERMISSION_PROFILE,
  getDefaultPermissionProfile,
  type PermissionProfileId
} from '../../../shared/permission-profiles'
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
  createInitialSettingsConnectorsState,
  createSettingsConnectorsSlice,
  type SettingsConnectorsActions,
  type SettingsConnectorsState
} from './settings-connectors-slice'
import {
  createSettingsPreferencesSlice,
  omitInFlightOptimisticPreferences,
  type SettingsPreferencesActions
} from './settings-preferences-slice'
import {
  createInitialSettingsSkillsState,
  createSettingsSkillsSlice,
  type SettingsSkillsActions,
  type SettingsSkillsState
} from './settings-skills-slice'
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
  CodeBuddyInfo,
  AgentFrameworkId,
  AgentFrameworkView,
  ChatApiEndpoint,
  OpencodeInfo,
  ProjectFilesFilterPreference,
  ProviderType,
  ProviderView,
  ReasoningEffort,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SettingsSnapshot,
  AppIconVariant,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../../shared/settings'

type SettingsStoreData = RuntimeSetupState &
  SettingsNavigationState &
  SettingsSkillsState &
  SettingsConnectorsState & {
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
    codebuddy: CodeBuddyInfo
    // Whether each framework's detected runtime is the app-managed install (only these can be uninstalled
    // in-app). Mirrored from the main-process snapshot; a PATH/npm binary reads false.
    claudeManaged: boolean
    opencodeManaged: boolean
    codexManaged: boolean
    codebuddyManaged: boolean
    onboardingCompletedAt: number | undefined
    encryptionAvailable: boolean
    // Configured package mirror (conda/pip); undefined means public hosts (unconfigured).
    packageMirror?: PackageMirror
    networkProxy: NetworkProxySettings
    // Reasoning-effort preference applied to agent requests; 'default' leaves the agent's own default.
    reasoningEffort: ReasoningEffort
    reviewerModel: ReviewerModelConfiguration
    reviewerModelPending: boolean
    sessionDetailsModel: SessionDetailsModelConfiguration
    sessionDetailsModelPending: boolean
    subagentModel: SubagentModelConfiguration
    subagentModelPending: boolean
    visionModel: VisionModelConfiguration | undefined
    visionModelPending: boolean
    // Whether the app posts an OS notification when an agent task finishes or fails while unfocused.
    notificationsEnabled: boolean
    // Whether conversations receive the app-owned Skill package import tool and instructions.
    conversationSkillImportEnabled: boolean
    // Saved Windows titlebar-close behavior. Undefined means ask every time.
    closePreference: CloseActionPreference | undefined
    // Selected built-in app-icon look, applied to the window and dock/taskbar. Defaults to 'light'.
    appIconVariant: AppIconVariant
    // Last Files-tab source filter; undefined means the default ("All artifacts").
    projectFilesFilter: ProjectFilesFilterPreference | undefined
    // Approval profile applied only when creating a new conversation.
    defaultPermissionProfile: PermissionProfileId
  }

type SettingsStoreCore = SettingsStoreData &
  ProviderAuthActions &
  SettingsPreferencesActions &
  SettingsNavigationActions &
  SettingsSkillsActions &
  SettingsConnectorsActions &
  SettingsStoreActions

type SettingsStoreActions = {
  load: (options?: { force?: boolean }) => Promise<boolean>
  acceptCommittedSnapshot: (snapshot: SettingsSnapshot) => void
  clearSettingsWriteError: () => void
}

type SettingsStore = SettingsStoreCore & RuntimeSetupActions

export const createInitialSettingsState = (): SettingsStoreData => ({
  ...createInitialRuntimeSetupState(),
  ...createInitialSettingsNavigationState(),
  ...createInitialSettingsSkillsState(),
  ...createInitialSettingsConnectorsState(),
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
  codebuddy: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  codebuddyManaged: false,
  onboardingCompletedAt: undefined,
  encryptionAvailable: false,
  packageMirror: undefined,
  networkProxy: DEFAULT_NETWORK_PROXY_SETTINGS,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  reviewerModel: { mode: 'inherit' },
  reviewerModelPending: false,
  sessionDetailsModel: DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  sessionDetailsModelPending: false,
  subagentModel: { mode: 'inherit' },
  subagentModelPending: false,
  visionModel: undefined,
  visionModelPending: false,
  notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
  conversationSkillImportEnabled: DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  closePreference: undefined,
  appIconVariant: DEFAULT_APP_ICON_VARIANT,
  projectFilesFilter: undefined,
  defaultPermissionProfile: DEFAULT_PERMISSION_PROFILE
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
  networkProxy: snapshot.networkProxy ?? DEFAULT_NETWORK_PROXY_SETTINGS,
  reasoningEffort: snapshot.reasoningEffort,
  reviewerModel: snapshot.reviewerModel ?? { mode: 'inherit' },
  sessionDetailsModel: snapshot.sessionDetailsModel ?? DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  subagentModel: snapshot.subagentModel ?? { mode: 'inherit' },
  visionModel: snapshot.visionModel,
  // Defensive: main always fills this, but an untyped snapshot (tests, older backends) must not
  // write undefined into the boolean preference.
  notificationsEnabled: snapshot.notificationsEnabled ?? DEFAULT_NOTIFICATIONS_ENABLED,
  conversationSkillImportEnabled:
    snapshot.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  closePreference: snapshot.closePreference,
  appIconVariant: snapshot.appIconVariant ?? DEFAULT_APP_ICON_VARIANT,
  projectFilesFilter: snapshot.projectFilesFilter,
  defaultPermissionProfile: getDefaultPermissionProfile(snapshot),

  agentFrameworkId: snapshot.agentFrameworkId,
  agentFrameworks: snapshot.agentFrameworks,
  opencode: snapshot.opencode,
  codex: snapshot.codex ?? {},
  codebuddy: snapshot.codebuddy ?? {},
  claudeManaged: snapshot.claudeManaged,
  opencodeManaged: snapshot.opencodeManaged,
  codexManaged: snapshot.codexManaged ?? false,
  codebuddyManaged: snapshot.codebuddyManaged ?? false
})

// Stable fallback reference so the selector returns the same array identity across renders
// (a fresh literal would make useSettingsStore re-render every tick and loop).
const DEFAULT_FRAMEWORK_API_ENDPOINTS: ChatApiEndpoint[] = ['anthropic']

// The chat endpoints the currently-selected agent framework can drive; a provider is only usable when
// it shares one. Defaults to Anthropic /v1/messages before the framework list has loaded.
export const selectFrameworkApiEndpoints = (state: SettingsStoreData): ChatApiEndpoint[] =>
  state.agentFrameworks.find((framework) => framework.id === state.agentFrameworkId)
    ?.supportedApiTypes ?? DEFAULT_FRAMEWORK_API_ENDPOINTS

export const selectVisionRelayAvailable = (state: SettingsStoreData): boolean => {
  const configuration = state.visionModel
  if (!configuration) return false
  const selectedKey = configuredModelKey(configuration.providerId, configuration.model)
  return buildConfiguredModelCatalog({
    providers: state.providers,
    activeProviderId: state.activeProviderId,
    claudeSubscriptionProviderId: state.claudeSubscriptionProviderId,
    frameworkId: state.agentFrameworkId,
    frameworkEndpoints: selectFrameworkApiEndpoints(state)
  }).some(
    (entry) =>
      entry.key === selectedKey &&
      entry.selectable &&
      entry.supportsImageInput &&
      !isCodexSubscriptionProvider(entry.providerType)
  )
}

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
  return buildConfiguredModelInventory({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId
  }).map(({ providerId, providerName, providerType, vendorId, model }) => ({
    providerId,
    providerName,
    providerType,
    vendorId,
    model
  }))
}

let settingsLoadPromise: Promise<boolean> | undefined
const SAFE_SETTINGS_LOAD_ERROR = 'Open Science could not load settings. Retry to continue.'

// Keep raw IPC diagnostics in the developer channel while renderer state remains path-safe.
const reportSettingsLoadError = (error: unknown): void => {
  console.warn('Settings loading failed', error)
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
      } else if (id === 'codebuddy') {
        await get().detectCodeBuddy()
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
  ...createSettingsNavigationSlice({
    getState: get,
    setState: (patch) => set(patch)
  }),
  ...createSettingsSkillsSlice({
    getState: get,
    setState: (patch) => set(patch),
    getCommands: () => window.api.settings
  }),
  ...createSettingsConnectorsSlice({
    getState: get,
    setState: (patch) => set(patch),
    getCommands: () => window.api.settings
  }),

  // Loads settings and capabilities in one pass. Reopening Settings refreshes the lightweight
  // snapshot and secure-storage capability, while startup-only subprocess probes stay cached.
  load: (options) => {
    // StrictMode replays the startup effect. Reuse that identical in-flight pass so a duplicate
    // request cannot supersede its successful result; an explicit user retry still starts a new
    // generation and remains authoritative over any older request.
    if (!options?.force && settingsLoadPromise) return settingsLoadPromise
    const generation = get().settingsLoadGeneration + 1
    const shouldInitializeRuntime = options?.force || !get().isLoaded
    set(
      shouldInitializeRuntime
        ? {
            settingsLoadGeneration: generation,
            isLoading: true,
            loadError: undefined,
            encryptionAvailable: false
          }
        : { settingsLoadGeneration: generation, encryptionAvailable: false }
    )

    const loadPromise = (async (): Promise<boolean> => {
      const settingsPromise = window.api.settings.getSettings()
      const encryptionAvailability = Promise.allSettled([
        window.api.settings.isEncryptionAvailable()
      ])
      const runtimeInitialization = shouldInitializeRuntime
        ? Promise.allSettled([
            window.api.settings.getPreflight(),
            window.api.settings.isNpmAvailable()
          ])
        : undefined

      try {
        const snapshot = await settingsPromise

        if (get().settingsLoadGeneration !== generation) return false

        // The persisted Settings authority is enough for an existing user to enter Home. Capability
        // probes continue in this same deduplicated pass; first-run onboarding still waits in App.
        set({
          ...applySnapshot(snapshot),
          ...(shouldInitializeRuntime ? { isLoaded: true } : {}),
          loadError: undefined
        })

        const [[encryptionResult], runtimeResults] = await Promise.all([
          encryptionAvailability,
          Promise.resolve(runtimeInitialization)
        ])
        if (get().settingsLoadGeneration !== generation) return false

        if (encryptionResult.status === 'rejected') {
          reportSettingsLoadError(encryptionResult.reason)
        }

        if (runtimeResults) {
          const [preflightResult, npmAvailableResult] = runtimeResults
          if (preflightResult.status === 'rejected') {
            reportSettingsLoadError(preflightResult.reason)
          }
          if (npmAvailableResult.status === 'rejected') {
            reportSettingsLoadError(npmAvailableResult.reason)
          }

          set({
            ...createRuntimeSetupLoadPatch(
              preflightResult.status === 'fulfilled' ? preflightResult.value : get().preflight,
              npmAvailableResult.status === 'fulfilled'
                ? npmAvailableResult.value
                : get().npmAvailable
            ),
            encryptionAvailable:
              encryptionResult.status === 'fulfilled' ? encryptionResult.value : false,
            isLoading: false,
            loadError: undefined
          })
        } else {
          set({
            encryptionAvailable:
              encryptionResult.status === 'fulfilled' ? encryptionResult.value : false,
            loadError: undefined
          })
        }
        return true
      } catch (error) {
        if (get().settingsLoadGeneration !== generation) return false

        reportSettingsLoadError(error)
        if (shouldInitializeRuntime) {
          set({
            isLoading: false,
            loadError: SAFE_SETTINGS_LOAD_ERROR
          })
        }
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
  acceptCommittedSnapshot: (snapshot) =>
    set(() =>
      omitInFlightOptimisticPreferences(applySnapshot(snapshot), writeCoordinator.hasPending)
    )
})

export const useSettingsStore = create<SettingsStore>((set, get) =>
  createSettingsStoreState(
    set,
    get,
    createSettingsWriteCoordinator((settingsWriteError) => set({ settingsWriteError }))
  )
)

export type { SaveProviderResult }
