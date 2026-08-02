import { create, type StoreApi } from 'zustand'

import type { OfficialVendorId } from '../../../shared/provider-registry'
import {
  codexSubscriptionProviderIdentity,
  claudeSharedProviderIdentity,
  claudeIsolatedProviderIdentity,
  DEFAULT_APP_ICON_VARIANT,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  providerValidationFailed,
  selectClaudeSubscriptionProvider
} from '../../../shared/settings'
import type { PackageMirror } from '../../../shared/mirror'
import type { CloseActionPreference } from '../../../shared/window-controls'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import type { SettingsPanelId } from '../pages/settings/settings-navigation'
import type {
  ClaudeDetectResult,
  ClaudeInfo,
  ClaudeInstallProgressEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  ClaudeSubscriptionProviderId,
  CodexInfo,
  CodexInstallSource,
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

// One runtime's install state. Each framework (Claude / OpenCode / Codex) owns an isolated copy, so an
// install event is attributed to its runtime and rendered by that card only — starting a Codex install
// never drives the OpenCode or Claude card (issue #278).
type RuntimeInstallState = {
  isInstalling: boolean
  installLogs: string[]
  // Latest progress tick driving this runtime's install bar; null when no install is active for it.
  installProgress: ClaudeInstallProgressEvent | null
  // Error message from this runtime's last install attempt; drives auto-expansion of its log pane.
  installError: string | undefined
}

type SettingsStoreData = {
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
  isDetectingCodex: boolean
  // Per-runtime install state, keyed by framework id. Each runtime's install writes only to its own
  // slice so its progress/logs/error render in its own card alone — never mirrored onto the others.
  installStates: Record<AgentFrameworkId, RuntimeInstallState>
  // Whether the settings dialog is open (rendered at the app root, over Home/Workspace).
  isSettingsOpen: boolean
  // Panel requested by an external entry point; Settings consumes it after seeding navigation.
  pendingSettingsPanel?: SettingsPanelId
  // Skill to land on when the dialog opens from a skill mention; consumed once its detail is seeded.
  pendingSkillId?: string
  // Specialist to land on when the dialog opens from the switch approval card; consumed once its
  // editor is seeded. Uses the stable profile id, never the renameable public name.
  pendingSpecialistId?: string
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

type SettingsStore = SettingsStoreData & {
  load: (options?: { force?: boolean }) => Promise<boolean>
  refreshPreflight: () => Promise<Preflight>
  checkEnvironment: (options?: { force?: boolean }) => Promise<EnvironmentCheckResult | undefined>
  detectClaude: () => Promise<ClaudeDetectResult>
  // Detects the opencode executable and refreshes its status card.
  detectOpencode: () => Promise<void>
  detectCodex: () => Promise<void>
  installClaude: (
    source: ClaudeInstallSource,
    managedRegistry?: ManagedClaudeRegistry
  ) => Promise<ClaudeInstallResult>
  // App-managed OpenCode install; writes only to the OpenCode install slice.
  installOpencode: (source?: ClaudeInstallSource) => Promise<ClaudeInstallResult>
  installCodex: (source?: CodexInstallSource) => Promise<ClaudeInstallResult>
  // Removes the app-managed runtime for a framework (guarded main-side to app-managed installs) and
  // applies the refreshed snapshot; main reconnects the agent so the next prompt uses the new state.
  uninstallClaude: () => Promise<void>
  uninstallOpencode: () => Promise<void>
  uninstallCodex: () => Promise<void>
  // Clears the transient logs/progress/error for one runtime (or every runtime when omitted).
  clearInstallLogs: (runtime?: AgentFrameworkId) => void
  // Persists the draft (create/update) without testing it, returning the affected provider id. The
  // Settings page uses this to return to the list immediately, then tests in the background.
  persistProvider: (request: UpsertProviderRequest) => Promise<string>
  // Persists the draft and validates it, without changing the active provider.
  saveProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  // Combined onboarding flow: persist + validate + activate only on success.
  saveAndActivateProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  cancelCodexLogin: () => Promise<void>
  // The explicit isolated sign-in — the only flow that opens the browser login. Resolves with the
  // recorded outcome so callers can react (onboarding advances only on success).
  loginIsolatedCodex: () => Promise<ValidateProviderResult>
  // The explicit isolated sign-out. Resolves with the outcome so callers can surface a failure
  // (e.g. a timeout where the credential may still be in place) rather than silently succeeding.
  logoutIsolatedCodex: () => Promise<ValidateProviderResult>
  // The Claude subscription's browser OAuth login (claude-shared mode). Opens the browser for sign-in
  // via `claude auth login --claudeai`. Resolves with the recorded outcome.
  loginSharedClaude: () => Promise<ValidateProviderResult>
  // Cancels an in-flight claude-shared browser sign-in (mirrors cancelIsolatedClaudeLogin).
  cancelSharedClaudeLogin: () => Promise<void>
  // The Claude subscription's browser OAuth sign-out (claude-shared mode).
  logoutSharedClaude: () => Promise<ValidateProviderResult>
  // The Claude subscription's setup-token paste (claude-isolated mode). Resolves with the recorded
  // outcome; the renderer is responsible for collecting the token from the user (copy command + paste input).
  loginIsolatedClaude: (token: string) => Promise<ValidateProviderResult>
  // The Claude subscription's browser OAuth for claude-isolated mode: the app runs `claude setup-token`
  // (opens the browser) under the isolated config dir and captures the token — no manual paste.
  loginIsolatedClaudeBrowser: () => Promise<ValidateProviderResult>
  // Cancels an in-flight claude-isolated browser sign-in.
  cancelIsolatedClaudeLogin: () => Promise<void>
  // The Claude subscription's sign-out. Same failure semantics as logoutIsolatedCodex: a failed
  // sign-out is surfaced rather than silently swallowed.
  logoutIsolatedClaude: () => Promise<ValidateProviderResult>
  // Fetches a saved provider's live model list from the vendor and refreshes the cache on success.
  refreshProviderModels: (providerId: string) => Promise<RefreshProviderModelsResult>
  // Activates a provider and, optionally, a specific model within it (composer model switch). An
  // omitted model lets main fall back to the provider's default.
  setActiveProvider: (providerId: string, model?: string) => Promise<void>
  // Switches the agent backend (main reconnects so the next prompt uses it).
  setAgentFramework: (id: AgentFrameworkId) => Promise<void>
  // Sets the reasoning-effort level (main reconnects so subsequent requests run at it).
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>
  // Toggles desktop notifications for finished/failed agent tasks; applies immediately.
  setNotificationsEnabled: (enabled: boolean) => Promise<void>
  setConversationSkillImportEnabled: (enabled: boolean) => Promise<void>
  setClosePreference: (preference: CloseActionPreference | undefined) => Promise<void>
  // Sets the app-icon look; main applies it live to the window and dock/taskbar.
  setAppIconVariant: (variant: AppIconVariant) => Promise<void>
  clearSettingsWriteError: () => void
  deleteProvider: (providerId: string) => Promise<void>
  openSettings: () => void
  openSettingsToPanel: (panel: SettingsPanelId) => void
  closeSettings: () => void
  // Opens the dialog straight onto a skill's detail page (used by clickable skill mentions).
  openSettingsToSkill: (skillId: string) => void
  // Opens the dialog straight onto one specialist's editor (used by the switch approval card).
  openSettingsToSpecialist: (specialistId: string) => void
  // Opens the dialog straight to the Compute panel (used by Files panel "Add SSH host…" link).
  openSettingsToCompute: () => void
  // Clears the requested panel after Settings has seeded its local navigation history.
  consumePendingSettingsPanel: () => void
  // Clears the pending skill once its detail view has been seeded, so a later open starts fresh.
  consumePendingSkill: () => void
  consumePendingSpecialist: () => void
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
  // Persists the package mirror config; caches it as undefined when cleared back to unconfigured.
  setPackageMirror: (mirror: PackageMirror) => Promise<void>
}

const createInitialRuntimeInstallState = (): RuntimeInstallState => ({
  isInstalling: false,
  installLogs: [],
  installProgress: null,
  installError: undefined
})

// True while any runtime install is running. Only one install runs at a time, so the settings/onboarding
// pages use this to lock the framework selector and every card's uninstall button during an install.
export const selectAnyInstalling = (state: SettingsStoreData): boolean =>
  state.installStates['claude-code'].isInstalling ||
  state.installStates.opencode.isInstalling ||
  state.installStates.codex.isInstalling

const createInitialPreflight = (): Preflight => ({
  claudeReady: false,
  opencodeReady: false,
  codexReady: false,
  agentFrameworkId: 'claude-code',
  agentReady: false,
  activeProviderReady: false
})

export const createInitialSettingsState = (): SettingsStoreData => ({
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
  isDetectingCodex: false,
  installStates: {
    'claude-code': createInitialRuntimeInstallState(),
    opencode: createInitialRuntimeInstallState(),
    codex: createInitialRuntimeInstallState()
  },
  isSettingsOpen: false,
  pendingSettingsPanel: undefined,
  pendingSkillId: undefined,
  pendingSpecialistId: undefined,
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

// Merges a patch into one runtime's install slice, leaving the other runtimes' slices untouched. This
// isolation is the fix for issue #278: an install event only ever mutates the runtime it belongs to.
const patchInstallState = (
  set: StoreApi<SettingsStore>['setState'],
  runtime: AgentFrameworkId,
  patch: Partial<RuntimeInstallState>
): void =>
  set((state) => ({
    installStates: {
      ...state.installStates,
      [runtime]: { ...state.installStates[runtime], ...patch }
    }
  }))

// Shared install driver for all three runtimes. Streams the (single-channel) install events into the
// given runtime's slice only, then reconciles the snapshot/preflight and records that runtime's error.
// `onInstallLog` is a broadcast channel, so correct attribution requires exactly one live subscription:
// the guard below enforces the single-install invariant in the store itself (not just via the UI lock),
// so even a stray caller or a mid-switch UI race can't start a second install that cross-contaminates
// another runtime's slice (issue #278). Every event the lone subscription sees therefore belongs to
// `runtime`.
const runRuntimeInstall = async (
  set: StoreApi<SettingsStore>['setState'],
  get: StoreApi<SettingsStore>['getState'],
  runtime: AgentFrameworkId,
  invoke: () => Promise<ClaudeInstallResult>
): Promise<ClaudeInstallResult> => {
  // Refuse to start a second concurrent install. The check + set is synchronous (no await between them),
  // so it's atomic against the single-threaded event loop: two callers can't both pass the guard.
  //
  // This is a safety backstop, not a user-facing path: the UI already disables every Install button while
  // any runtime installs (selectAnyInstalling + the cards' busy/installBusy props), so a user cannot reach
  // this branch. It exists only for a stray/programmatic caller or a mid-switch race. The rejection is
  // therefore intentionally silent — it writes to no slice (writing an error here would surface a phantom
  // failure on a runtime the user never touched, the inverse of the #278 bug) and callers ignore the
  // result. If a real UI trigger for this path is ever added, surface the error on the target slice then.
  if (selectAnyInstalling(get())) {
    return { installId: '', ok: false, error: 'Another install is already in progress.' }
  }

  patchInstallState(set, runtime, {
    isInstalling: true,
    installLogs: [],
    installProgress: null,
    installError: undefined
  })

  const unsubscribe = window.api.settings.onInstallLog((event) => {
    if (event.kind === 'progress') {
      patchInstallState(set, runtime, { installProgress: event })
    } else {
      set((state) => ({
        installStates: {
          ...state.installStates,
          [runtime]: {
            ...state.installStates[runtime],
            installLogs: [...state.installStates[runtime].installLogs, event.chunk]
          }
        }
      }))
    }
  })

  try {
    // The install itself and the post-install snapshot reconcile are distinct concerns. Only an install
    // failure (invoke throwing, or a non-ok result) may set installError; a reconcile that throws AFTER
    // a successful install must not relabel it as failed (that would be a phantom failure on a runtime
    // that actually installed).
    let result: ClaudeInstallResult
    try {
      result = await invoke()
    } catch (error) {
      patchInstallState(set, runtime, {
        installError: error instanceof Error ? error.message : 'Install failed.'
      })
      throw error
    }

    // Record the outcome from the install result itself, before the (best-effort) reconcile below.
    patchInstallState(set, runtime, {
      installError: result.ok ? undefined : (result.error ?? 'Install failed.')
    })

    // A successful install re-detected/persisted the runtime in main; reload so the card reflects it.
    // Best-effort: a transient snapshot/preflight error leaves the card briefly stale (corrected on the
    // next detect/refresh), which is preferable to overwriting a good install result with a failure.
    try {
      set(applySnapshot(await window.api.settings.getSettings()))
      await get().refreshPreflight()
    } catch {
      // Intentionally swallowed — the install succeeded; installError already reflects `result`.
    }

    return result
  } finally {
    unsubscribe()
    patchInstallState(set, runtime, { isInstalling: false, installProgress: null })
  }
}

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

// Finds the provider id affected by an upsert: the edited id, or the one new since `before`.
const resolveUpsertedProviderId = (
  request: UpsertProviderRequest,
  before: ProviderView[],
  after: ProviderView[]
): string | undefined => {
  if (isCodexSubscriptionProvider(request.type)) {
    return codexSubscriptionProviderIdentity().id
  }
  // Both Claude subscription modes use fixed builtin ids; return the correct one for the new type
  // so mode switches (shared→isolated or vice versa) resolve to the incoming record, not the old one.
  if (request.type === 'claude-shared') return claudeSharedProviderIdentity().id
  if (request.type === 'claude-isolated') return claudeIsolatedProviderIdentity().id

  if (request.id) return request.id

  const beforeIds = new Set(before.map((provider) => provider.id))

  return after.find((provider) => !beforeIds.has(provider.id))?.id
}

let settingsLoadPromise: Promise<boolean> | undefined
const SAFE_SETTINGS_LOAD_ERROR = 'Open Science could not load settings. Retry to continue.'

// Keep raw IPC diagnostics in the developer channel while renderer state remains path-safe.
const reportSettingsLoadError = (error: unknown): void => {
  console.warn('Settings startup loading failed', error)
}

// Visible copy stays stable and path-safe; raw IPC failures remain in the console for diagnostics.
const SETTINGS_WRITE_ERRORS = {
  activeProvider: 'Could not switch active provider or model. Try again.',
  agentFramework: 'Could not switch agent framework. Try again.',
  reasoningEffort: 'Could not save reasoning effort. Try again.',
  notifications: 'Could not save notification preference. Try again.',
  conversationSkillImport: 'Could not save conversation Skill import preference. Try again.',
  closePreference: 'Could not save window close preference. Try again.',
  appIcon: 'Could not save app icon preference. Try again.'
} as const

type SettingsWriteKey = keyof typeof SETTINGS_WRITE_ERRORS

type SettingsWriteToken = {
  key: SettingsWriteKey
  generation: number
  failuresAtStart: ReadonlyMap<SettingsWriteKey, number>
}

type SettingsWriteFailure = {
  id: number
  message: string
}

type OptimisticSettingsWriteKey =
  'reasoningEffort' | 'notifications' | 'conversationSkillImport' | 'closePreference' | 'appIcon'

type OptimisticSettingsWriteState<T> = {
  confirmedValue: T
  pendingCount: number
}

const settingsWriteGenerations = new Map<SettingsWriteKey, number>()
const settingsWriteFailures = new Map<SettingsWriteKey, SettingsWriteFailure>()
const settingsWriteQueues = new Map<OptimisticSettingsWriteKey, Promise<unknown>>()
const optimisticSettingsWriteStates = new Map<
  OptimisticSettingsWriteKey,
  OptimisticSettingsWriteState<unknown>
>()
let settingsWriteFailureId = 0

const currentSettingsWriteError = (): string | undefined => {
  const messages = [...settingsWriteFailures.values()]
    .sort((left, right) => left.id - right.id)
    .map((failure) => failure.message)

  return messages.length > 0 ? messages.join(' ') : undefined
}

// Generations are isolated per preference: a newer write supersedes stale work for that same
// preference without hiding a failure from a different concurrent write. The token also remembers
// errors visible when the user started this write so a success clears only those stale errors, not a
// different failure that arrived while the write was pending.
const beginSettingsWrite = (key: SettingsWriteKey): SettingsWriteToken => {
  const generation = (settingsWriteGenerations.get(key) ?? 0) + 1
  settingsWriteGenerations.set(key, generation)
  return {
    key,
    generation,
    failuresAtStart: new Map(
      [...settingsWriteFailures].map(([failureKey, failure]) => [failureKey, failure.id])
    )
  }
}

const isCurrentSettingsWrite = (token: SettingsWriteToken): boolean =>
  settingsWriteGenerations.get(token.key) === token.generation

// Preserve click order for one optimistic preference while unrelated preferences still write in
// parallel. This makes the last confirmed value deterministic even when users change one control
// repeatedly before its previous IPC round trip finishes.
const runOptimisticSettingsWrite = async <T>(
  key: OptimisticSettingsWriteKey,
  write: () => Promise<T>
): Promise<T> => {
  const previous = settingsWriteQueues.get(key)
  const current = previous ? previous.catch(() => undefined).then(write) : write()
  settingsWriteQueues.set(key, current)

  try {
    return await current
  } finally {
    if (settingsWriteQueues.get(key) === current) settingsWriteQueues.delete(key)
  }
}

const beginOptimisticSettingsWrite = <T>(
  key: OptimisticSettingsWriteKey,
  confirmedValue: T
): { writeToken: SettingsWriteToken; optimisticState: OptimisticSettingsWriteState<T> } => {
  let optimisticState = optimisticSettingsWriteStates.get(key) as
    OptimisticSettingsWriteState<T> | undefined

  if (!optimisticState) {
    optimisticState = { confirmedValue, pendingCount: 0 }
    optimisticSettingsWriteStates.set(key, optimisticState as OptimisticSettingsWriteState<unknown>)
  }
  optimisticState.pendingCount += 1

  return { writeToken: beginSettingsWrite(key), optimisticState }
}

const completeOptimisticSettingsWrite = <T>(
  key: OptimisticSettingsWriteKey,
  optimisticState: OptimisticSettingsWriteState<T>,
  confirmedValue?: { value: T }
): T => {
  if (confirmedValue) optimisticState.confirmedValue = confirmedValue.value
  optimisticState.pendingCount -= 1

  if (
    optimisticState.pendingCount === 0 &&
    optimisticSettingsWriteStates.get(key) === optimisticState
  ) {
    optimisticSettingsWriteStates.delete(key)
  }

  return optimisticState.confirmedValue
}

const finishSettingsWrite = (
  set: StoreApi<SettingsStore>['setState'],
  token: SettingsWriteToken,
  error?: string
): void => {
  if (!isCurrentSettingsWrite(token)) return

  if (error) {
    settingsWriteFailureId += 1
    settingsWriteFailures.set(token.key, { id: settingsWriteFailureId, message: error })
  } else {
    for (const [failureKey, failureId] of token.failuresAtStart) {
      if (settingsWriteFailures.get(failureKey)?.id === failureId) {
        settingsWriteFailures.delete(failureKey)
      }
    }
  }

  set({ settingsWriteError: currentSettingsWriteError() })
}

// Renderer cache of the main-process settings service. The main process stays the source of truth
// for secrets; this store only ever holds masked provider views.
export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...createInitialSettingsState(),

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
          preflight,
          encryptionAvailable,
          npmAvailable,
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

  // Re-checks the two startup gates without reloading the whole snapshot.
  refreshPreflight: async () => {
    const preflight = await window.api.settings.getPreflight()

    set({ preflight })

    return preflight
  },

  // Full startup inspection: main owns filesystem/network/runtime probes; the renderer caches only
  // their structured, non-secret result. Refresh settings/preflight afterwards because detection may
  // have discovered and persisted a Claude installation that appeared since the previous launch.
  checkEnvironment: async (options) => {
    // React Strict Mode intentionally re-runs mount effects in development. Reuse the in-flight pass
    // only when it targets the currently-selected framework: an auto-switch (e.g. Claude -> a detected
    // OpenCode) changes the target mid-flight, and that call must issue its own probe rather than reuse
    // the previous framework's, or Continue stays disabled on a result that no longer matches.
    const framework = get().agentFrameworkId
    if (!options?.force && get().isCheckingEnvironment && get().checkingFramework === framework) {
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

  // Runs a one-click Claude install, streaming events into the Claude slice only, then refreshes
  // settings/preflight. Log and progress share one channel, routed by `kind` into this runtime's card.
  installClaude: async (source, managedRegistry) =>
    runRuntimeInstall(set, get, 'claude-code', () =>
      window.api.settings.installClaude({ source, managedRegistry })
    ),

  // App-managed OpenCode install; streams into the OpenCode slice only.
  installOpencode: async (source = 'managed') =>
    runRuntimeInstall(set, get, 'opencode', () => window.api.settings.installOpencode({ source })),

  // App-managed / npm Codex install; streams into the Codex slice only.
  installCodex: async (source = 'managed') =>
    runRuntimeInstall(set, get, 'codex', () => window.api.settings.installCodex({ source })),

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

  uninstallCodex: async () => {
    set(applySnapshot(await window.api.settings.uninstallCodex()))
    await get().refreshPreflight()
  },

  clearInstallLogs: (runtime) =>
    set((state) => {
      const runtimes: AgentFrameworkId[] = runtime
        ? [runtime]
        : ['claude-code', 'opencode', 'codex']
      const installStates = { ...state.installStates }
      // Clear only the transient display fields; preserve isInstalling. Resetting the whole slice would
      // flip isInstalling to false mid-install, dropping the single-install lock (selectAnyInstalling)
      // and letting a second install start — the exact invariant this store guards.
      for (const id of runtimes) {
        installStates[id] = {
          ...installStates[id],
          installLogs: [],
          installProgress: null,
          installError: undefined
        }
      }
      return { installStates }
    }),

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

  // Persists a provider draft, validates it, and activates it. The connectivity probe is advisory,
  // not a gate: a provider that saved is activated even if the probe failed (e.g. a custom Responses
  // gateway the probe can't reach or that rejects the minimal ping), so it can be configured in and
  // tested live. The validation result is still recorded and surfaced as an "unverified" warning.
  saveAndActivateProvider: async (request) => {
    const result = await get().saveProvider(request)

    if (result.providerId) {
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

  cancelCodexLogin: () => window.api.settings.cancelCodexLogin(),

  // Mirrors validateProvider's refresh: the recorded outcome (validated-at or failure) lives on the
  // stored provider, so the snapshot and derived readiness are re-applied either way.
  loginIsolatedCodex: async () => {
    const result = await window.api.settings.loginIsolatedCodex()

    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()

    return result
  },

  logoutIsolatedCodex: async () => {
    const result = await window.api.settings.logoutIsolatedCodex()
    // Refresh the snapshot regardless of outcome: a failed sign-out preserves the verified markers
    // on the provider (credential still in place), a successful one clears them. Either way the
    // store must reflect the true stored state rather than a stale cached view.
    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()
    return result
  },

  // Claude subscription's paste-token sign-in. The renderer owns the modal that captures the
  // setup-token output; this action forwards it to main, where it lands encrypted on the fixed
  // builtin-claude-isolated provider record.
  loginIsolatedClaude: async (token: string) => {
    const result = await window.api.settings.loginIsolatedClaude(token)

    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()

    return result
  },

  // Claude subscription's browser OAuth for claude-isolated mode. The app runs `claude setup-token`
  // under the isolated config dir (opens the browser, captures the token) so there's no manual paste.
  loginIsolatedClaudeBrowser: async () => {
    const result = await window.api.settings.loginIsolatedClaudeBrowser()

    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()

    return result
  },

  cancelIsolatedClaudeLogin: async () => {
    await window.api.settings.cancelIsolatedClaudeLogin()
  },

  logoutIsolatedClaude: async () => {
    const result = await window.api.settings.logoutIsolatedClaude()
    // Same refresh rule as the codex path: a failed sign-out keeps the verified markers, so the
    // store must reflect the real stored state regardless of the outcome.
    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()
    return result
  },

  // Claude subscription's browser OAuth sign-in (claude-shared mode). Opens the browser via
  // `claude auth login --claudeai`. The CLI stores credentials in ~/.claude.
  loginSharedClaude: async () => {
    const result = await window.api.settings.loginSharedClaude()

    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()

    return result
  },

  cancelSharedClaudeLogin: async () => {
    await window.api.settings.cancelClaudeLogin()
  },

  logoutSharedClaude: async () => {
    const result = await window.api.settings.logoutSharedClaude()
    set(applySnapshot(await window.api.settings.getSettings()))
    await get().refreshPreflight()
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
    const writeToken = beginSettingsWrite('activeProvider')
    let snapshot: SettingsSnapshot
    try {
      snapshot = await window.api.settings.setActiveProvider({
        id: providerId,
        model: model || undefined
      })
    } catch (error) {
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.activeProvider)
      console.error('Failed to set active provider', error)
      throw error
    }

    if (!isCurrentSettingsWrite(writeToken)) return
    set(applySnapshot(snapshot))
    finishSettingsWrite(set, writeToken)
    await get().refreshPreflight()
  },

  // Switches the agent backend; main reconnects so the choice applies on the next prompt. A failed
  // write leaves the previous framework selected and feeds the shared Settings error banner.
  setAgentFramework: async (id) => {
    const writeToken = beginSettingsWrite('agentFramework')

    let snapshot: SettingsSnapshot
    try {
      snapshot = await window.api.settings.setAgentFramework({ id })
    } catch (error) {
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.agentFramework)
      console.error('Failed to switch agent framework', error)
      throw error
    }

    if (!isCurrentSettingsWrite(writeToken)) return
    set(applySnapshot(snapshot))
    finishSettingsWrite(set, writeToken)

    try {
      // Live-detect the newly-selected framework so a binary installed (or deleted) since the last
      // check is reflected right away, then refresh the readiness gate the install prompt keys off.
      if (id === 'opencode') {
        await get().detectOpencode()
      } else if (id === 'codex') {
        await get().detectCodex()
      } else {
        await get().detectClaude()
      }
      await get().refreshPreflight()
    } catch (error) {
      // The preference is already saved. Keep the new selection and avoid relabelling a follow-up
      // detection problem as a write failure; the next explicit/full environment check can retry.
      console.error('Failed to refresh agent framework status', error)
    }
  },

  // Sets the reasoning-effort level; main reconnects so subsequent requests run at it. The IPC round
  // trip includes that reconnect, which is too slow to gate the selector on — apply the pick
  // optimistically, reconcile from the returned snapshot, and revert if the write fails.
  setReasoningEffort: async (effort) => {
    const previous = get().reasoningEffort
    const { writeToken, optimisticState } = beginOptimisticSettingsWrite(
      'reasoningEffort',
      previous
    )
    set({ reasoningEffort: effort })

    try {
      const snapshot = await runOptimisticSettingsWrite('reasoningEffort', () =>
        window.api.settings.setReasoningEffort({ effort })
      )
      completeOptimisticSettingsWrite('reasoningEffort', optimisticState, {
        value: snapshot.reasoningEffort
      })
      if (!isCurrentSettingsWrite(writeToken)) return
      set(applySnapshot(snapshot))
      finishSettingsWrite(set, writeToken)
    } catch (error) {
      const confirmedValue = completeOptimisticSettingsWrite('reasoningEffort', optimisticState)
      if (isCurrentSettingsWrite(writeToken)) set({ reasoningEffort: confirmedValue })
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.reasoningEffort)
      console.error('Failed to set reasoning effort', error)
    }
  },

  // Toggles desktop notifications. Optimistic like the other preference setters: apply the pick,
  // reconcile from the returned snapshot, and revert if the write fails.
  setNotificationsEnabled: async (enabled) => {
    const previous = get().notificationsEnabled
    const { writeToken, optimisticState } = beginOptimisticSettingsWrite('notifications', previous)
    set({ notificationsEnabled: enabled })

    try {
      const snapshot = await runOptimisticSettingsWrite('notifications', () =>
        window.api.settings.setNotificationsEnabled({ enabled })
      )
      completeOptimisticSettingsWrite('notifications', optimisticState, {
        value: snapshot.notificationsEnabled
      })
      if (!isCurrentSettingsWrite(writeToken)) return
      set(applySnapshot(snapshot))
      finishSettingsWrite(set, writeToken)
    } catch (error) {
      const confirmedValue = completeOptimisticSettingsWrite('notifications', optimisticState)
      if (isCurrentSettingsWrite(writeToken)) set({ notificationsEnabled: confirmedValue })
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.notifications)
      console.error('Failed to set notifications enabled', error)
    }
  },

  setConversationSkillImportEnabled: async (enabled) => {
    const previous = get().conversationSkillImportEnabled
    const { writeToken, optimisticState } = beginOptimisticSettingsWrite(
      'conversationSkillImport',
      previous
    )
    set({ conversationSkillImportEnabled: enabled })

    try {
      const snapshot = await runOptimisticSettingsWrite('conversationSkillImport', () =>
        window.api.settings.setConversationSkillImportEnabled({ enabled })
      )
      completeOptimisticSettingsWrite('conversationSkillImport', optimisticState, {
        value: snapshot.conversationSkillImportEnabled
      })
      if (!isCurrentSettingsWrite(writeToken)) return
      set(applySnapshot(snapshot))
      finishSettingsWrite(set, writeToken)
    } catch (error) {
      const confirmedValue = completeOptimisticSettingsWrite(
        'conversationSkillImport',
        optimisticState
      )
      if (isCurrentSettingsWrite(writeToken)) {
        set({ conversationSkillImportEnabled: confirmedValue })
      }
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.conversationSkillImport)
      console.error('Failed to set conversation Skill import enabled', error)
    }
  },

  setClosePreference: async (preference) => {
    const previous = get().closePreference
    const { writeToken, optimisticState } = beginOptimisticSettingsWrite(
      'closePreference',
      previous
    )
    set({ closePreference: preference })

    try {
      const snapshot = await runOptimisticSettingsWrite('closePreference', () =>
        window.api.settings.setClosePreference({ preference })
      )
      completeOptimisticSettingsWrite('closePreference', optimisticState, {
        value: snapshot.closePreference
      })
      if (!isCurrentSettingsWrite(writeToken)) return
      set(applySnapshot(snapshot))
      finishSettingsWrite(set, writeToken)
    } catch (error) {
      const confirmedValue = completeOptimisticSettingsWrite('closePreference', optimisticState)
      if (isCurrentSettingsWrite(writeToken)) set({ closePreference: confirmedValue })
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.closePreference)
      console.error('Failed to set close preference', error)
    }
  },

  // Sets the app-icon look. Optimistic like the other preference setters: apply the pick, reconcile
  // from the returned snapshot, and revert if the write fails.
  setAppIconVariant: async (variant) => {
    const previous = get().appIconVariant
    const { writeToken, optimisticState } = beginOptimisticSettingsWrite('appIcon', previous)
    set({ appIconVariant: variant })

    try {
      const snapshot = await runOptimisticSettingsWrite('appIcon', () =>
        window.api.settings.setAppIconVariant({ variant })
      )
      completeOptimisticSettingsWrite('appIcon', optimisticState, {
        value: snapshot.appIconVariant
      })
      if (!isCurrentSettingsWrite(writeToken)) return
      set(applySnapshot(snapshot))
      finishSettingsWrite(set, writeToken)
    } catch (error) {
      const confirmedValue = completeOptimisticSettingsWrite('appIcon', optimisticState)
      if (isCurrentSettingsWrite(writeToken)) set({ appIconVariant: confirmedValue })
      finishSettingsWrite(set, writeToken, SETTINGS_WRITE_ERRORS.appIcon)
      console.error('Failed to set app icon variant', error)
    }
  },

  clearSettingsWriteError: () => {
    settingsWriteFailures.clear()
    set({ settingsWriteError: undefined })
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

  detectCodex: async () => {
    set({ isDetectingCodex: true })

    try {
      set(applySnapshot(await window.api.settings.detectCodex()))
    } finally {
      set({ isDetectingCodex: false })
    }
  },

  deleteProvider: async (providerId) => {
    const snapshot = await window.api.settings.deleteProvider({ id: providerId })

    set(applySnapshot(snapshot))
    await get().refreshPreflight()
  },

  openSettings: () => set({ isSettingsOpen: true }),

  openSettingsToPanel: (panel) =>
    set({
      isSettingsOpen: true,
      pendingSettingsPanel: panel,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined
    }),

  // Clearing the pending targets on close stops a later normal open from jumping back to stale state.
  closeSettings: () =>
    set({
      isSettingsOpen: false,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined,
      pendingSettingsPanel: undefined
    }),

  openSettingsToSkill: (skillId) =>
    set({
      isSettingsOpen: true,
      pendingSkillId: skillId,
      pendingSpecialistId: undefined,
      pendingSettingsPanel: undefined
    }),

  // Deep-link straight to one specialist's editor (used by the specialist switch approval card).
  openSettingsToSpecialist: (specialistId) =>
    set({
      isSettingsOpen: true,
      pendingSpecialistId: specialistId,
      pendingSkillId: undefined,
      pendingSettingsPanel: undefined
    }),

  // Keep the domain-specific caller API while routing it through the shared panel target.
  openSettingsToCompute: () =>
    set({
      isSettingsOpen: true,
      pendingSettingsPanel: 'compute',
      pendingSkillId: undefined,
      pendingSpecialistId: undefined
    }),

  consumePendingSettingsPanel: () => set({ pendingSettingsPanel: undefined }),

  consumePendingSkill: () => set({ pendingSkillId: undefined }),

  consumePendingSpecialist: () => set({ pendingSpecialistId: undefined }),

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
  },

  setPackageMirror: async (mirror) => {
    const saved = await window.api.settings.setPackageMirror(mirror)
    set({ packageMirror: isMirrorConfigured(saved) ? saved : undefined })
  }
}))

export type { SaveProviderResult }
