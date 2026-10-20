import { ApplicationCommandError } from '../../../shared/application-command-contract'
import { projectRendererFailure } from '../renderer-diagnostics'
import {
  getDesktopRuntimeEpoch,
  useDesktopRuntimeRecoveryStore
} from './desktop-runtime-recovery-store'
import { ReadDeadlineError, readWithDeadline } from '../lib/read-with-deadline'
import { create, type StoreApi } from 'zustand'

import {
  buildConfiguredModelCatalog,
  buildConfiguredModelInventory,
  configuredModelKey
} from '../../../shared/configured-model-catalog'
import type { PackageMirror } from '../../../shared/mirror'
import type { ModelProtocol, OfficialVendorId } from '@aipoch/providers'
import type { ReasoningEffort } from '../../../shared/model-preference-contract'
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxySettings
} from '../../../shared/network-proxy'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../shared/notebook-network'
import { type NotebookNetworkSettings } from '../../../shared/notebook-network-settings'
import {
  DEFAULT_PERMISSION_PROFILE,
  getDefaultPermissionProfile,
  type PermissionProfileId
} from '../../../shared/permission-profiles'

import type {
  AgentFrameworkId,
  AgentFrameworkView,
  AppIconVariant,
  ClaudeInfo,
  ClaudeSubscriptionProviderId,
  CodeBuddyInfo,
  CodexInfo,
  OpencodeInfo,
  ProjectFilesFilterPreference,
  ProviderType,
  ProviderView,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SettingsSnapshot,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../../shared/settings'
import {
  DEFAULT_APP_ICON_VARIANT,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  DEFAULT_SHOW_NOTIFICATION_CONTENT,
  isCodexSubscriptionProvider,
  parseSettingsSnapshot
} from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import {
  createInitialSettingsConnectorsState,
  createSettingsConnectorsSlice,
  type SettingsConnectorsActions,
  type SettingsConnectorsState
} from './settings-connectors-slice'
import {
  createInitialSettingsNavigationState,
  createSettingsNavigationSlice,
  type SettingsNavigationActions,
  type SettingsNavigationState
} from './settings-navigation-slice'
import {
  createSettingsPreferencesSlice,
  omitInFlightOptimisticPreferences,
  type SettingsPreferencesActions
} from './settings-preferences-slice'
import {
  createProviderAuthSlice,
  type ProviderAuthActions,
  type SaveProviderResult
} from './settings-provider-auth-slice'
import {
  beginPreflightRequest,
  createInitialRuntimeSetupState,
  createRuntimeSetupLoadPatch,
  createRuntimeSetupSlice,
  type RuntimeSetupActions,
  type RuntimeSetupState
} from './settings-runtime-slice'
import {
  createInitialSettingsSkillsState,
  createSettingsSkillsSlice,
  type SettingsSkillsActions,
  type SettingsSkillsState
} from './settings-skills-slice'
import {
  createSettingsWriteCoordinator,
  type SettingsWriteCoordinator
} from './settings-write-coordinator'
export { selectAnyInstalling } from './settings-runtime-slice'

type SettingsStoreData = RuntimeSetupState &
  SettingsNavigationState &
  SettingsSkillsState &
  SettingsConnectorsState & {
    isLoaded: boolean
    isLoading: boolean
    loadError: string | undefined
    loadFailure: SettingsLoadFailure | undefined
    // Latest failed Settings write, shown by the dialog until dismissed or another write starts.
    settingsWriteError: string | undefined
    settingsLoadGeneration: number
    settingsSnapshotRevision: number
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
    credentialStore?: 'os' | 'file'
    encryptionAvailable: boolean
    // Configured package mirror (conda/pip); undefined means automatic mirror selection.
    packageMirror?: PackageMirror
    networkProxy: NetworkProxySettings
    notebookNetwork: NotebookNetworkSettings
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
    // Whether native banners may include task/request details. Defaults off for privacy.
    showNotificationContent: boolean
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
  loadFailure: undefined,
  settingsWriteError: undefined,
  settingsLoadGeneration: 0,
  settingsSnapshotRevision: 0,
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
  notebookNetwork: DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
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
  showNotificationContent: DEFAULT_SHOW_NOTIFICATION_CONTENT,
  conversationSkillImportEnabled: DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  closePreference: undefined,
  appIconVariant: DEFAULT_APP_ICON_VARIANT,
  projectFilesFilter: undefined,
  defaultPermissionProfile: DEFAULT_PERMISSION_PROFILE
})

// Applies a fresh main-process snapshot to the renderer cache.
const applySnapshot = (snapshot: SettingsSnapshot): Partial<SettingsStoreData> => ({
  credentialStore: snapshot.credentialStore ?? 'os',
  claude: snapshot.claude,
  activeProviderId: snapshot.activeProviderId,
  claudeSubscriptionProviderId: snapshot.claudeSubscriptionProviderId,
  activeModel: snapshot.activeModel,
  providers: snapshot.providers,
  onboardingCompletedAt: snapshot.onboardingCompletedAt,
  packageMirror: isMirrorConfigured(snapshot.packageMirror) ? snapshot.packageMirror : undefined,
  networkProxy: snapshot.networkProxy ?? DEFAULT_NETWORK_PROXY_SETTINGS,
  notebookNetwork: snapshot.notebookNetwork ?? DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  reasoningEffort: snapshot.reasoningEffort,
  reviewerModel: snapshot.reviewerModel ?? { mode: 'inherit' },
  sessionDetailsModel: snapshot.sessionDetailsModel ?? DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  subagentModel: snapshot.subagentModel ?? { mode: 'inherit' },
  visionModel: snapshot.visionModel,
  // Defensive: main always fills this, but an untyped snapshot (tests, older backends) must not
  // write undefined into the boolean preference.
  notificationsEnabled: snapshot.notificationsEnabled ?? DEFAULT_NOTIFICATIONS_ENABLED,
  showNotificationContent: snapshot.showNotificationContent ?? DEFAULT_SHOW_NOTIFICATION_CONTENT,
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

const canApplySnapshot = (state: SettingsStoreData, snapshot: SettingsSnapshot): boolean =>
  snapshot.revision === undefined
    ? state.settingsSnapshotRevision === 0
    : snapshot.revision >= state.settingsSnapshotRevision

const mergeSnapshot = (
  state: SettingsStoreData,
  snapshot: SettingsSnapshot,
  writeCoordinator: SettingsWriteCoordinator,
  extra: Partial<SettingsStoreData> = {}
): Partial<SettingsStoreData> =>
  canApplySnapshot(state, snapshot)
    ? {
        ...omitInFlightOptimisticPreferences(
          applySnapshot(snapshot),
          writeCoordinator.hasPending,
          writeCoordinator.acceptCommitted
        ),
        ...(snapshot.revision === undefined ? {} : { settingsSnapshotRevision: snapshot.revision }),
        ...extra
      }
    : extra

// Stable fallback reference so the selector returns the same array identity across renders
// (a fresh literal would make useSettingsStore re-render every tick and loop).
const DEFAULT_FRAMEWORK_API_ENDPOINTS: ModelProtocol[] = ['messages']

// The chat endpoints the currently-selected agent framework can drive; a provider is only usable when
// it shares one. Defaults to Anthropic /v1/messages before the framework list has loaded.
export const selectFrameworkApiEndpoints = (state: SettingsStoreData): ModelProtocol[] =>
  state.agentFrameworks.find((framework) => framework.id === state.agentFrameworkId)
    ?.supportedApiTypes ?? DEFAULT_FRAMEWORK_API_ENDPOINTS

// The currently-selected agent framework's descriptor; undefined before the framework list has
// loaded. Returns the stored view object (stable reference), never a fresh literal.
export const selectActiveAgentFramework = (
  state: SettingsStoreData
): AgentFrameworkView | undefined =>
  state.agentFrameworks.find((framework) => framework.id === state.agentFrameworkId)

// Display name of the active agent framework for surfaces that mention it in copy; falls back to
// the framework id until the framework list has loaded.
export const selectFrameworkDisplayName = (state: SettingsStoreData): string =>
  selectActiveAgentFramework(state)?.displayName ?? state.agentFrameworkId

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

export type SettingsLoadFailure =
  | 'backend-unavailable'
  | 'read-timeout'
  | 'storage-unavailable'
  | 'invalid-settings'
  | 'credential-unavailable'
  | 'unknown'

const settingsLoadFailure = (error: unknown): SettingsLoadFailure => {
  if (error instanceof ReadDeadlineError) return 'read-timeout'
  if (error && typeof error === 'object' && 'code' in error) {
    switch (error.code) {
      case 'command-unavailable':
        return 'backend-unavailable'
      case 'invalid-command-result':
      case 'settings-invalid':
        return 'invalid-settings'
      case 'settings-storage-unavailable':
        return 'storage-unavailable'
      case 'settings-credential-unavailable':
        return 'credential-unavailable'
    }
  }
  return 'unknown'
}

// Retries can observe an outstanding read, but must not enqueue unbounded work behind a stuck
// authority. A new desktop epoch is the only reason to replace a still-unsettled transport read.
const pendingSettingsReads = new WeakMap<
  () => Promise<unknown>,
  { epoch: number; promise: Promise<unknown> }
>()
const readSettings = <T>(read: () => Promise<T>, epoch: number): Promise<T> => {
  const current = pendingSettingsReads.get(read)
  if (current?.epoch === epoch) return readWithDeadline(() => current.promise as Promise<T>, 15_000)
  let promise: Promise<T>
  try {
    promise = read()
  } catch (error) {
    return Promise.reject(error)
  }
  const pending = { epoch, promise }
  pendingSettingsReads.set(read, pending)
  const clear = (): void => {
    if (pendingSettingsReads.get(read) === pending) pendingSettingsReads.delete(read)
  }
  void promise.then(clear, clear)
  return readWithDeadline(() => promise, 15_000)
}

let settingsLoadPromise: Promise<boolean> | undefined
const SAFE_SETTINGS_LOAD_ERROR = 'Open-Science could not load settings. Retry to continue.'

// Keep raw IPC diagnostics in the developer channel while renderer state remains path-safe.
const reportSettingsLoadError = (
  error: unknown,
  context: 'settings-load' | 'settings-capability' = 'settings-capability'
): void => {
  try {
    window.api?.diagnostics?.reportRendererFailure(
      projectRendererFailure('handled-error', error, 'settings', context)
    )
  } catch {
    /* A missing diagnostics bridge must not block recovery. */
  }
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
      set((state) => mergeSnapshot(state, snapshot, writeCoordinator, runtimePatch))
  }),
  ...createProviderAuthSlice({
    get,
    getCommands: () => window.api.settings,
    reconcileSnapshot: (snapshot) =>
      set((state) => mergeSnapshot(state, snapshot, writeCoordinator)),
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
    reconcileSnapshot: (snapshot) => {
      if (!canApplySnapshot(get(), snapshot)) return false
      set((state) => mergeSnapshot(state, snapshot, writeCoordinator))
      return true
    },
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
    const epoch = getDesktopRuntimeEpoch()
    const shouldInitializeRuntime = options?.force || !get().isLoaded
    set(
      shouldInitializeRuntime
        ? {
            settingsLoadGeneration: generation,
            isLoading: true,
            loadError: undefined,
            loadFailure: undefined,
            encryptionAvailable: false
          }
        : { settingsLoadGeneration: generation, encryptionAvailable: false }
    )

    const loadPromise = (async (): Promise<boolean> => {
      try {
        const phase = useDesktopRuntimeRecoveryStore.getState().phase
        if (phase !== 'connected' && phase !== 'reconciling')
          throw new ApplicationCommandError('command-unavailable', 'Backend unavailable.')
        const settingsPromise = readSettings(window.api.settings.getSettings, epoch)
        const encryptionAvailability = Promise.allSettled([
          readSettings(window.api.settings.isEncryptionAvailable, epoch)
        ])
        const isCurrentPreflight = shouldInitializeRuntime
          ? beginPreflightRequest(set, get)
          : () => false
        const runtimeInitialization = shouldInitializeRuntime
          ? Promise.allSettled([
              readSettings(window.api.settings.getPreflight, epoch),
              readSettings(window.api.settings.isNpmAvailable, epoch)
            ])
          : undefined

        const snapshot = await settingsPromise
        parseSettingsSnapshot(snapshot)
        if (epoch !== getDesktopRuntimeEpoch())
          throw new ApplicationCommandError('command-unavailable', 'Backend connection changed.')

        if (get().settingsLoadGeneration !== generation) return false

        // The persisted Settings authority is enough for an existing user to enter Home. Capability
        // probes continue in this same deduplicated pass; first-run onboarding still waits in App.
        set((state) =>
          mergeSnapshot(state, snapshot, writeCoordinator, {
            ...(shouldInitializeRuntime ? { isLoaded: true } : {}),
            loadError: undefined,
            loadFailure: undefined
          })
        )

        const [[encryptionResult], runtimeResults] = await Promise.all([
          encryptionAvailability,
          Promise.resolve(runtimeInitialization)
        ])
        if (epoch !== getDesktopRuntimeEpoch())
          throw new ApplicationCommandError('command-unavailable', 'Backend connection changed.')
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
            preflightFailed: isCurrentPreflight()
              ? preflightResult.status === 'rejected'
              : get().preflightFailed,
            ...createRuntimeSetupLoadPatch(
              isCurrentPreflight() && preflightResult.status === 'fulfilled'
                ? preflightResult.value
                : get().preflight,
              npmAvailableResult.status === 'fulfilled'
                ? npmAvailableResult.value
                : get().npmAvailable
            ),
            encryptionAvailable:
              encryptionResult.status === 'fulfilled' ? encryptionResult.value : false,
            isLoading: false,
            loadError: undefined,
            loadFailure: undefined
          })
        } else {
          set({
            encryptionAvailable:
              encryptionResult.status === 'fulfilled' ? encryptionResult.value : false,
            loadError: undefined,
            loadFailure: undefined
          })
        }
        return true
      } catch (error) {
        if (get().settingsLoadGeneration !== generation) return false

        reportSettingsLoadError(error, 'settings-load')
        if (shouldInitializeRuntime) {
          set({
            isLoading: false,
            loadError: SAFE_SETTINGS_LOAD_ERROR,
            loadFailure: settingsLoadFailure(error)
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
    set((state) => mergeSnapshot(state, snapshot, writeCoordinator))
})

export const useSettingsStore = create<SettingsStore>((set, get) =>
  createSettingsStoreState(
    set,
    get,
    createSettingsWriteCoordinator((settingsWriteError) => set({ settingsWriteError }))
  )
)

export type { SaveProviderResult }
