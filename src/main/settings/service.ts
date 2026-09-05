import { homedir } from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { CloseActionPreference } from '../../shared/window-controls'
import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  ConnectorDetailView,
  CreateDeviceCredentialRequest,
  CreateDeviceCredentialResult,
  DeviceCredentialsSnapshot,
  DeviceCredentialAuthenticationRequest,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  ConnectorsSnapshot,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  RemoveDeviceCredentialRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  UpdateDeviceCredentialRequest,
  AgentHomeSkillView,
  CreateSkillRequest,
  DeleteSkillRequest,
  EnvironmentCheckResult,
  GitHubTokenStatus,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  InstallClaudeRequest,
  InstallCodeBuddyRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  ResolveSkillDocumentRequest,
  ResolvedSkillDocument,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  ValidateOpenAlexCredentialRequest,
  OpenAlexCredentialValidation,
  SetPackageMirrorRequest,
  SetNetworkProxyRequest,
  SetNotebookNetworkRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SetToolPermissionRequest,
  SettingsSnapshot,
  SetAgentRoutingRequest,
  AppIconVariant,
  SkillDetailView,
  SkillView,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  ProjectFilesFilterPreference,
  ReasoningEffort,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration as SessionDetailsModel,
  SubagentModelConfiguration,
  VisionModelConfiguration as VisionModel,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  SkillSource,
  ScanRepoRequest,
  ScanRepoResult,
  ProviderDeletionScenarioModelHandling,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import { createLogger, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import type { PackageMirror } from '../../shared/mirror'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { NotebookNetworkSettings, NotebookNetworkStatus } from '../../shared/notebook-network'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { resolveConfigRoot } from '../storage-root'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  type AgentModelChangeTarget,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import type { ClaudeDetectDeps } from './claude-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { CodeBuddyDetectDeps } from './codebuddy-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { InstallManagedOpencodeOptions } from './managed-opencode'
import type { InstallManagedCodexOptions, ManagedCodexInstallOutcome } from './managed-codex'
import type { InstallManagedClaudeOptions, ManagedInstallOutcome } from './managed-claude'
import { isEncryptionAvailable } from './crypto'
import { getUserClaudeConfigDir } from './provider-env'
import { SettingsRepository } from './repository'
import { SettingsPreferencesModule, type SetDataRootOptions } from './preferences'
import { buildSettingsSnapshot } from './settings-view'
import { NotebookRuntimeSettingsModule } from './notebook-runtime-settings'
import { SkillCatalogModule, type SkillCatalogEntry } from './skill-catalog'
import { ConnectorSettingsModule, type CustomServerSecurityChangeGuard } from './connector-settings'
import type {
  CustomServerRuntimeProjectionProvider,
  DeviceCredentialConsumerMutation
} from './connector-settings'
import { DeviceCredentialStore, type ResolvedOAuthDeviceCredential } from './device-credentials'
import { ProviderAccountsModule } from './provider-accounts'
import { AgentRuntimeManager, type ExecuteClaudeProbe } from './agent-runtime-manager'
import {
  AgentBackendResolver,
  type AgentBackendResolutionContext,
  type AgentBackendSelection,
  type ExplicitAgentBackendTarget
} from './backend-resolver'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { SAFE_SKILL_NAME } from '../skills/skill-name'
import { parseFrontmatter } from '../skills/frontmatter'
import { SKILL_IMPORT_LIMITS } from '../skills/import-limits'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { ALL_CONNECTOR_IDS } from '../connectors/registry'
import { renderSkillDoc } from '../connectors/skill-doc'
import { connectorSkillSourceDir } from '../connectors/provision'
import type { SkillExportArchive } from '../skills/export'
import type { FetchLike } from '../skills/github-import'
import type { StoredConnectors, StoredCustomMcpOAuthState, StoredSettings } from './types'
import type { CodexAuthControllerPort } from './codex-auth'
import { createSettingsIdSequence } from './id-sequence'
import { ScenarioModelOwner, createScenarioModels } from './scenario-model-owner'
import type { SystemProxyEnvironment } from './system-proxy'
import { type ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import { type ClaudeSharedAuthControllerPort } from './claude-shared-auth'
import { NetworkProxySettingsOwner } from './network-proxy-settings-owner'
import { NotebookNetworkSettingsOwner } from './notebook-network-settings-owner'
import { PackageMirrorSettingsOwner } from './package-mirror-settings-owner'

// Outcome of uninstalling a managed runtime. `activeBackendAffected` is true only when the removed
// runtime backed the active framework, so the IPC layer reconnects the agent for that case alone —
// removing the inactive framework's runtime leaves the live agent untouched.
export type UninstallResult = {
  snapshot: SettingsSnapshot
  activeBackendAffected: boolean
}

export type SettingsServiceOptions = {
  repository?: SettingsRepository
  configRoot?: string
  // Packaged main entry reused as the isolated stdio Skill runtime MCP child.
  skillRuntimeMcpEntryPath?: string
  log?: Logger
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  codebuddyDetectDeps?: CodeBuddyDetectDeps
  // Reserves the authenticated loopback HTTP port exposed by `opencode acp`. Injectable so settings
  // tests do not bind real sockets.
  allocateOpenCodeUsagePort?: () => Promise<number>
  codexDetectDeps?: CodexDetectDeps
  // The machine's own Claude config dir, used by the shared provider for auth/spawn and scanned as a
  // user skill source. Injectable so tests don't touch the real ~/.claude.
  userClaudeDir?: string
  // The machine's own Codex config dir, scanned for installed skills; injectable like userClaudeDir.
  userCodexDir?: string
  // The framework-neutral Agents config dir. Codex and other compatible agents discover skills
  // under ~/.agents/skills; it is scanned regardless of the active framework.
  userAgentsDir?: string
  skillRegistry?: SkillRegistry
  userSkills?: UserSkillRepository
  withUserSkillRecoveryBarrier?: <T>(operation: () => Promise<T>) => Promise<T>
  githubFetch?: FetchLike
  // OpenAlex validation transport. Production injects Electron net.fetch so proxy settings apply.
  openAlexFetch?: typeof fetch
  // One-shot Claude command runner, injectable so validation tests can inspect the exact auth env.
  executeClaudeProbe?: ExecuteClaudeProbe
  // One-shot managed Claude installer, injectable so tests avoid real network/fs.
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  // Same for the managed OpenCode installer.
  installManagedOpencodeImpl?: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodexImpl?: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  codexAuth?: CodexAuthControllerPort
  // Resolves the user's current native/PAC proxy for Codex subscription traffic. Injectable so
  // tests do not depend on the host machine's Electron session configuration.
  resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
  // Projects a persisted proxy preference into the live Electron Session and future child process
  // environment. Tests omit it to keep SettingsService free of host-global side effects.
  applyNetworkProxy?: (settings: NetworkProxySettings) => Promise<void>
  // Applies a committed Notebook egress policy to live kernels without requiring a restart.
  applyNotebookNetwork?: (settings: NotebookNetworkSettings) => Promise<void>
  validatePackageMirror?: (settings: SetPackageMirrorRequest) => Promise<void>
  applyPackageMirror?: (settings: PackageMirror) => Promise<void>
  beforePackageMirrorCaBundleChange?: () => Promise<void>
  getNotebookNetworkStatus?: () => Promise<NotebookNetworkStatus>
  installNotebookNetwork?: () => Promise<{ cancelled: boolean }>
  removeNotebookNetwork?: () => Promise<{ cancelled: boolean }>
  // Encrypted-token controller for claude-isolated; default-constructed against this.configRoot
  // when omitted. Storage is delegated to the host's SettingsRepository + encrypt/tryDecryptKey
  // pipeline, mirroring how CodexAuthController delegates to openCodexAuthSession.
  claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
  // Browser OAuth controller for claude-shared; default-constructed when omitted. Calls
  // `claude auth login --claudeai` to open the browser and stores credentials in ~/.claude.
  claudeSharedAuth?: ClaudeSharedAuthControllerPort
}

// Orchestrates the settings units (repository + crypto + detect/install + validate) behind one
// object shared by the settings IPC handlers and the ACP runtime. Secrets are decrypted here only
// transiently; nothing that leaves this object (views, spawn config aside) carries plaintext.
class SettingsService {
  private readonly repository: SettingsRepository
  private readonly preferences: SettingsPreferencesModule
  private readonly notebookRuntimeSettings: NotebookRuntimeSettingsModule
  private readonly skills: SkillCatalogModule
  private readonly connectors: ConnectorSettingsModule
  private readonly providers: ProviderAccountsModule
  private readonly runtimeManager: AgentRuntimeManager
  private readonly backendResolver: AgentBackendResolver
  private readonly scenarioModels: ScenarioModelOwner
  private readonly configRoot: string
  private readonly networkProxy: NetworkProxySettingsOwner
  private readonly notebookNetwork: NotebookNetworkSettingsOwner
  private readonly packageMirror: PackageMirrorSettingsOwner
  private readonly getNotebookNetworkStatusImpl: () => Promise<NotebookNetworkStatus>
  private readonly installNotebookNetworkImpl: () => Promise<{ cancelled: boolean }>
  private readonly removeNotebookNetworkImpl: () => Promise<{ cancelled: boolean }>
  private readonly userClaudeDir: string
  private readonly log: Logger
  private customServerAuthenticator?: (serverId: string) => Promise<void>
  private customServerAuthenticationCanceller?: (serverId: string) => Promise<void>
  private customServerDisconnector?: (serverId: string) => Promise<void>
  private deviceCredentialAuthenticator?: (credentialId: string) => Promise<void>
  private deviceCredentialAuthenticationCanceller?: (credentialId: string) => Promise<void>
  private deviceCredentialDisconnector?: (credentialId: string) => Promise<void>
  private skillDeletionGuard?: (skillId: string) => Promise<void>
  constructor(options: SettingsServiceOptions = {}) {
    this.configRoot = options.configRoot ?? resolveConfigRoot()
    this.repository = options.repository ?? new SettingsRepository(this.configRoot)
    this.networkProxy = new NetworkProxySettingsOwner({
      repository: this.repository,
      apply: options.applyNetworkProxy ?? (async () => undefined)
    })
    this.notebookNetwork = new NotebookNetworkSettingsOwner({
      repository: this.repository,
      apply: options.applyNotebookNetwork ?? (async () => undefined)
    })
    this.packageMirror = new PackageMirrorSettingsOwner({
      repository: this.repository,
      validate: options.validatePackageMirror ?? (async () => undefined),
      apply: options.applyPackageMirror ?? (async () => undefined),
      beforeCaBundleChange: options.beforePackageMirrorCaBundleChange
    })
    this.getNotebookNetworkStatusImpl =
      options.getNotebookNetworkStatus ??
      (async () => ({ kind: 'error', reason: 'runtimeFailure' }))
    this.installNotebookNetworkImpl =
      options.installNotebookNetwork ??
      (async () => {
        throw new Error('Notebook network sandbox installation is unavailable.')
      })
    this.removeNotebookNetworkImpl =
      options.removeNotebookNetwork ??
      (async () => {
        throw new Error('Notebook network sandbox removal is unavailable.')
      })
    this.log = options.log ?? createLogger('settings')
    this.preferences = new SettingsPreferencesModule(this.repository)
    this.notebookRuntimeSettings = new NotebookRuntimeSettingsModule(this.repository)
    this.connectors = new ConnectorSettingsModule(
      this.repository,
      options.openAlexFetch,
      new DeviceCredentialStore(this.configRoot)
    )
    this.userClaudeDir = options.userClaudeDir ?? getUserClaudeConfigDir()
    const userCodexDir = options.userCodexDir ?? join(homedir(), '.codex')
    this.skills = new SkillCatalogModule({
      repository: this.repository,
      storageRoot: this.configRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir,
      userAgentsDir: options.userAgentsDir ?? join(homedir(), '.agents'),
      skillRegistry: options.skillRegistry ?? new SkillRegistry(),
      userSkills: options.userSkills,
      withUserSkillRecoveryBarrier: options.withUserSkillRecoveryBarrier,
      githubFetch: options.githubFetch
    })
    const allocateSettingsIdSequence = createSettingsIdSequence()
    this.runtimeManager = new AgentRuntimeManager({
      repository: this.repository,
      configRoot: this.configRoot,
      userClaudeDir: this.userClaudeDir,
      skills: this.skills,
      connectors: this.connectors,
      allocateSettingsIdSequence,
      detectDeps: options.detectDeps,
      opencodeDetectDeps: options.opencodeDetectDeps,
      codebuddyDetectDeps: options.codebuddyDetectDeps,
      codexDetectDeps: options.codexDetectDeps,
      allocateOpenCodeUsagePort: options.allocateOpenCodeUsagePort,
      executeClaudeProbe: options.executeClaudeProbe,
      installManagedClaudeImpl: options.installManagedClaudeImpl,
      installManagedOpencodeImpl: options.installManagedOpencodeImpl,
      installManagedCodexImpl: options.installManagedCodexImpl,
      resolveCodexProxyEnvironment: options.resolveCodexProxyEnvironment
    })
    this.providers = new ProviderAccountsModule({
      repository: this.repository,
      storageRoot: this.configRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir,
      allocateSettingsIdSequence,
      resolveCodexExecutable: (adapterPath, nativePath) =>
        this.runtimeManager.resolveCodexExecutable(adapterPath, nativePath),
      resolveCodexProxyEnvironment: () => this.runtimeManager.resolveCodexProxyEnvironment(),
      runClaudeSubscriptionProbe: (provider, settings) =>
        this.runtimeManager.runClaudeSubscriptionProbe(provider, settings),
      codexAuth: options.codexAuth,
      claudeIsolatedAuth: options.claudeIsolatedAuth,
      claudeSharedAuth: options.claudeSharedAuth
    })
    this.backendResolver = new AgentBackendResolver({
      readSettings: () => this.repository.getSettings(),
      providers: this.providers,
      runtime: this.runtimeManager,
      connectors: this.connectors,
      storageRoot: this.configRoot,
      userClaudeDir: this.userClaudeDir,
      skillRuntimeMcpEntryPath: options.skillRuntimeMcpEntryPath ?? process.argv[1] ?? '',
      getXaiOAuthAccessToken: (forceRefresh) => this.providers.getXaiOAuthAccessToken(forceRefresh)
    })
    this.scenarioModels = createScenarioModels(
      this.repository,
      this.providers,
      this.backendResolver
    )
  }

  // Returns the raw stored settings document (unmasked), for main-process bootstrap needs (e.g. priming
  // the data-root cache) that shouldn't go through the renderer-safe view.
  async getStoredSettings(): Promise<StoredSettings> {
    return this.migrateLegacyKeyRefs(await this.repository.getSettings())
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const operation = startDiagnosticOperation(this.log, { operation: 'settings-load' })
    try {
      operation.phase('read-authority')
      const stored = await this.repository.getSettings()
      operation.phase('migrate-legacy-key-refs')
      const settings = await this.migrateLegacyKeyRefs(stored)
      operation.phase('build-renderer-view')
      const snapshot = buildSettingsSnapshot(settings, this.runtimeManager, this.providers)
      operation.complete({ providerCount: settings.providers.length })
      return snapshot
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }

  async getPackageMirror(): Promise<PackageMirror> {
    return this.notebookRuntimeSettings.getPackageMirror()
  }

  // The persisted v4 environment enablement for a language, read fresh. Always returns a concrete
  // RuntimeEnablement (empty maps when nothing is stored) so callers can index it and apply the
  // provenance default (isEnvEnabled) without a null check.
  async getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).runtimeEnablement
  }

  // Sets one env's explicit enabled override (keyed by envId) for a language, read-modify-write over
  // the per-language RuntimeEnablement, returning the refreshed value. The enabled map records the
  // explicit choice regardless of the provenance default, so it survives re-detection.
  async setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement> {
    return this.notebookRuntimeSettings.setEnvironmentEnabled(language, envId, enabled)
  }

  // Sets one env's high-risk package-install authorization (keyed by envId) for a language, returning
  // the refreshed enablement. This is the separate opt-in that lets Open Science write packages into an
  // external env; it does not affect whether the env is enabled for execution.
  async setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement> {
    return this.notebookRuntimeSettings.setInstallAuthorized(language, envId, authorized)
  }

  async getAgentEnvironmentCreationEnabled(): Promise<boolean> {
    return this.notebookRuntimeSettings.getAgentEnvironmentCreationEnabled()
  }

  async setAgentEnvironmentCreationEnabled(enabled: boolean): Promise<boolean> {
    return this.notebookRuntimeSettings.setAgentEnvironmentCreationEnabled(enabled)
  }

  async getManualInterpreters(language: NotebookLanguage): Promise<string[]> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).manualInterpreters
  }

  async addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.addManualInterpreter(language, path)
  }

  async removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.removeManualInterpreter(language, path)
  }

  async setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    return this.packageMirror.set(request)
  }

  setNetworkProxy(request: SetNetworkProxyRequest): Promise<NetworkProxySettings> {
    return this.networkProxy.set(request)
  }

  async setNotebookNetwork(request: SetNotebookNetworkRequest): Promise<NotebookNetworkSettings> {
    return this.notebookNetwork.set(request)
  }

  getNotebookNetwork(): Promise<NotebookNetworkSettings> {
    return this.notebookNetwork.get()
  }

  allowNotebookNetworkDomain(hostname: string): Promise<NotebookNetworkSettings> {
    return this.notebookNetwork.allowDomain(hostname)
  }

  getNotebookNetworkStatus(): Promise<NotebookNetworkStatus> {
    return this.getNotebookNetworkStatusImpl()
  }

  async installNotebookNetwork(): Promise<NotebookNetworkStatus> {
    await this.installNotebookNetworkImpl()
    return this.getNotebookNetworkStatusImpl()
  }

  async removeNotebookNetwork(): Promise<NotebookNetworkStatus> {
    await this.removeNotebookNetworkImpl()
    return this.getNotebookNetworkStatusImpl()
  }

  private async migrateLegacyKeyRefs(settings: StoredSettings): Promise<StoredSettings> {
    if (!isEncryptionAvailable()) return settings
    let changed = await this.providers.migrateLegacyKeyRefs(settings.providers)
    changed = (await this.connectors.migrateLegacyNcbiKeyRef(settings.connectors)) || changed
    return changed ? this.repository.getSettings() : settings
  }

  async setAgentFramework(id: AgentFrameworkId): Promise<SettingsSnapshot> {
    await this.repository.setAgentFramework(id)
    return this.getSettingsView()
  }

  async setAgentRouting(request: SetAgentRoutingRequest): Promise<SettingsSnapshot> {
    if (
      request.framework === undefined &&
      request.reviewer === undefined &&
      request.subagent === undefined
    ) {
      throw new Error('Agent routing update requires at least one field.')
    }
    await this.repository.setAgentRouting(request, (candidate) => {
      const frameworkId = candidate.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
      return {
        ...candidate,
        reviewerModel: this.scenarioModels.reviewer.validate(
          candidate,
          candidate.reviewerModel ?? { mode: 'inherit' },
          frameworkId
        ),
        subagentModel: this.scenarioModels.subagent.validate(
          candidate,
          candidate.subagentModel ?? { mode: 'inherit' },
          frameworkId
        )
      }
    })
    return this.getSettingsView()
  }

  // Sets the reasoning-effort preference. Where the framework supports it the caller applies the
  // level live over ACP (otherwise it reconnects); the persisted value drives the next spawn.
  async setReasoningEffort(effort: ReasoningEffort): Promise<SettingsSnapshot> {
    await this.preferences.setReasoningEffort(effort)
    return this.getSettingsView()
  }

  async setSubagentModel(configuration: SubagentModelConfiguration): Promise<SettingsSnapshot> {
    await this.scenarioModels.subagent.set(configuration)
    return this.getSettingsView()
  }

  async setReviewerModel(configuration: ReviewerModelConfiguration): Promise<SettingsSnapshot> {
    await this.scenarioModels.reviewer.set(configuration)
    return this.getSettingsView()
  }

  async setSessionDetailsModel(configuration: SessionDetailsModel): Promise<SettingsSnapshot> {
    await this.scenarioModels.sessionDetails.set(configuration)
    return this.getSettingsView()
  }

  async admitSessionDetailsExecutionTarget(
    ...args: Parameters<ScenarioModelOwner['sessionDetails']['admit']>
  ): ReturnType<ScenarioModelOwner['sessionDetails']['admit']> {
    return this.scenarioModels.sessionDetails.admit(...args)
  }

  async setVisionModel(configuration: VisionModel | undefined): Promise<SettingsSnapshot> {
    await this.scenarioModels.vision.set(configuration)
    return this.getSettingsView()
  }

  async admitVisionModel(): ReturnType<ScenarioModelOwner['vision']['admit']> {
    return this.scenarioModels.vision.admit()
  }

  async admitReviewerExecutionModel(): ReturnType<ScenarioModelOwner['reviewer']['admit']> {
    return this.scenarioModels.reviewer.admit()
  }

  // Projects one of the app's five stable user-intent slots through the active model's static effort
  // profile. This is intentionally async only because settings are read from disk; capability lookup
  // is synchronous and never performs provider discovery or a network request.
  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    return this.backendResolver.resolveActiveReasoningEffort(intent)
  }

  async admitSubagentExecutionModel(
    ...args: Parameters<ScenarioModelOwner['subagent']['admit']>
  ): ReturnType<ScenarioModelOwner['subagent']['admit']> {
    return this.scenarioModels.subagent.admit(...args)
  }

  async resolveSubagentExecutionModel(
    ...args: Parameters<ScenarioModelOwner['subagent']['resolve']>
  ): ReturnType<ScenarioModelOwner['subagent']['resolve']> {
    return this.scenarioModels.subagent.resolve(...args)
  }

  async resolveActiveModelChangeTarget(): Promise<AgentModelChangeTarget | undefined> {
    return this.backendResolver.resolveActiveModelChangeTarget()
  }

  async getNotificationsEnabled(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).notificationsEnabled
  }

  async getShowNotificationContent(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).showNotificationContent
  }

  async setNotificationsEnabled(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setNotificationsEnabled(enabled)
    return this.getSettingsView()
  }

  async setShowNotificationContent(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setShowNotificationContent(enabled)
    return this.getSettingsView()
  }

  // Read fresh for every agent-session MCP build so disabling the feature removes the server and its
  // prompt guidance after the settings-triggered reconnect without restarting the app.
  async getConversationSkillImportEnabled(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).conversationSkillImportEnabled
  }

  async setConversationSkillImportEnabled(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setConversationSkillImportEnabled(enabled)
    return this.getSettingsView()
  }

  async getClosePreference(): Promise<CloseActionPreference | undefined> {
    return (await this.preferences.getSnapshot()).closePreference
  }

  async setClosePreference(
    preference: CloseActionPreference | undefined
  ): Promise<SettingsSnapshot> {
    await this.preferences.setClosePreference(preference)
    return this.getSettingsView()
  }

  async setProjectFilesFilter(
    filter: ProjectFilesFilterPreference | undefined
  ): Promise<SettingsSnapshot> {
    await this.preferences.setProjectFilesFilter(filter)
    return this.getSettingsView()
  }

  async getAppIconVariant(): Promise<AppIconVariant> {
    return (await this.preferences.getSnapshot()).appIconVariant
  }

  async setAppIconVariant(variant: AppIconVariant): Promise<SettingsSnapshot> {
    await this.preferences.setAppIconVariant(variant)
    return this.getSettingsView()
  }

  async setDefaultPermissionProfile(profile: PermissionProfileId): Promise<SettingsSnapshot> {
    await this.preferences.setDefaultPermissionProfile(profile)
    return this.getSettingsView()
  }

  async detectOpencode(): Promise<SettingsSnapshot> {
    await this.runtimeManager.detectOpencode()
    return this.getSettingsView()
  }

  async detectCodeBuddy(): Promise<SettingsSnapshot> {
    await this.runtimeManager.detectCodeBuddy()
    return this.getSettingsView()
  }

  async detectCodex(): Promise<SettingsSnapshot> {
    await this.runtimeManager.detectCodex()
    return this.getSettingsView()
  }

  async listSkills(): Promise<SkillView[]> {
    return this.skills.listSkills()
  }
  // Internal main-process adapter used by host.skills. Unlike listSkills(), this includes bundled
  // internal Skills and returns source directories only to the trusted caller callback.
  async listHostSkills(): Promise<BundledSkill[]> {
    return this.skills.listHostSkills()
  }
  registeredHelperCatalog(): ReturnType<SkillCatalogModule['registeredHelperCatalog']> {
    return this.skills.registeredHelperCatalog()
  }
  async listUserSkills(): Promise<BundledSkill[]> {
    return this.skills.listUserSkills()
  }
  async withHostSkillRead<T>(
    id: string,
    read: (skill: BundledSkill) => Promise<T>
  ): Promise<T | undefined> {
    return this.skills.withHostSkillRead(id, read)
  }

  async publishHostSkill(name: string, sourcePath: string, overwrite: boolean): Promise<string> {
    return this.skills.publishHostSkill(name, sourcePath, overwrite)
  }

  async buildSkillExport(id: string): Promise<SkillExportArchive> {
    return this.skills.buildSkillExport(id)
  }

  // Specialist scopes see the installed catalog irrespective of Main Agent toggles. Bundled
  // Specialist startup validation can restrict this to immutable application resources.
  async listSpecialistSkillCatalog(options: { bundledOnly?: boolean } = {}): Promise<
    Array<{
      id: string
      frameworkName: string
      displayName: string
      source: SkillSource
      mainEnabled: boolean
      available: boolean
      compatibility?: string
    }>
  > {
    return this.skills.listSpecialistSkillCatalog(options)
  }

  // Returns the mcp-<id> skill names for connectors provisioned at the Main Agent level (enabled
  // bundled connectors + enabled custom MCP servers). Specialist sessions merge these into their
  // skill whitelist so the agent can discover connector tools; the per-call ConnectorService gate
  // still enforces the specialist's own connector access config.
  async provisionedConnectorSkillNames(): Promise<string[]> {
    return this.connectors.provisionedConnectorSkillNames()
  }

  setCustomServerRuntimeProjectionProvider(provider: CustomServerRuntimeProjectionProvider): void {
    this.connectors.setCustomServerRuntimeProjectionProvider(provider)
  }
  // Returns the subset of forced ids that are currently disabled in settings — i.e. the picks that need
  // a respawn to materialize. Enabled picks are already present and need no reconnect.
  async skillsNeedingForceLoad(forcedIds: string[]): Promise<string[]> {
    return this.skills.skillsNeedingForceLoad(forcedIds)
  }

  // Resolves picker ids to the names the agent's Skill tool accepts. Bundled skills use their
  // manifest id as frontmatter name, while personal/imported ids have an app-owned source prefix and
  // must use the frontmatter name kept in the user skill catalog.
  async skillNudgeNamesForIds(ids: string[]): Promise<string[]> {
    return this.skills.skillNudgeNamesForIds(ids)
  }

  async codexSkillDescriptorsForIds(
    ids: string[],
    codexHome: string | undefined
  ): Promise<Array<{ name: string; path: string }>> {
    return this.skills.codexSkillDescriptorsForIds(ids, codexHome)
  }

  async codexSkillCatalog(codexHome: string | undefined): Promise<SkillCatalogEntry[]> {
    return this.skills.codexSkillCatalog(codexHome, (settings) =>
      this.connectors.connectorSkillCatalogEntries(settings.connectors)
    )
  }

  async codeBuddySkillCatalog(runtimeRoot: string | undefined): Promise<SkillCatalogEntry[]> {
    return this.skills.codeBuddySkillCatalog(runtimeRoot, (settings) =>
      this.connectors.connectorSkillCatalogEntries(settings.connectors)
    )
  }

  async getSkillDetail(id: string): Promise<SkillDetailView> {
    return this.skills.getSkillDetail(id)
  }

  // Resolves a renderable SKILL.md document by canonical invocation name across every source the
  // runtime can load from. The permission card and transcript rows need this because connector
  // skills (mcp-<id> for enabled bundled connectors, materialized custom MCP server skills) are
  // invocable through load_skill but are NOT part of the renderer's managed catalog. Sources, in
  // order: the managed catalog (an enabled entry wins a name collision, mirroring the renderer's
  // own rule), enabled bundled connectors (document rendered on the fly), then materialized custom
  // server skills (read from the provisioned source dir, gated by the provisioned-name projection
  // so arbitrary directories are never served). Returns null when no source provides the name.
  async resolveSkillDocument(
    request: ResolveSkillDocumentRequest
  ): Promise<ResolvedSkillDocument | null> {
    const name = request.name.trim()
    // The same lowercase-hyphen shape the runtime accepts; keeps the filesystem read below safe.
    if (!SAFE_SKILL_NAME.test(name)) return null

    const skills = await this.skills.listSkills()
    const entry =
      skills.find((skill) => skill.name === name && skill.enabled) ??
      skills.find((skill) => skill.name === name)
    if (entry) {
      const detail = await this.getSkillDetail(entry.id)
      return {
        name: detail.name,
        displayName: detail.displayName,
        description: detail.description,
        body: detail.body
      }
    }

    const bundledId = /^mcp-(.+)$/.exec(name)?.[1]
    if (bundledId && ALL_CONNECTOR_IDS.includes(bundledId)) {
      const settings = await this.repository.getSettings()
      if (!this.connectors.enabledConnectorIds(settings.connectors).includes(bundledId)) {
        return null
      }
      const meta = CONNECTOR_CATALOG.find((connector) => connector.id === bundledId)
      const { fields, body } = parseFrontmatter(renderSkillDoc(bundledId))
      return {
        name,
        ...(meta ? { displayName: meta.displayName } : {}),
        ...(fields.description ? { description: fields.description } : {}),
        body
      }
    }

    if (!(await this.connectors.provisionedConnectorSkillNames()).includes(name)) return null
    const filePath = join(connectorSkillSourceDir(this.configRoot), name, 'SKILL.md')
    const metadata = await stat(filePath).catch(() => undefined)
    // The body is renderer-bound preview text; cap it at the shared preview budget before reading.
    if (!metadata?.isFile() || metadata.size > SKILL_IMPORT_LIMITS.maxPreviewContentBytes) {
      return null
    }
    const raw = await readFile(filePath, 'utf8').catch(() => undefined)
    if (!raw) return null
    const { fields, body } = parseFrontmatter(raw)
    if (fields.name !== name) return null
    return {
      name,
      ...(fields.description ? { description: fields.description } : {}),
      body
    }
  }

  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    return this.skills.setSkillEnabled(request)
  }

  async setSkillsEnabled(request: SetSkillsEnabledRequest): Promise<SkillView[]> {
    return this.skills.setSkillsEnabled(request)
  }

  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    return this.skills.createSkill(request)
  }

  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    return this.skills.updateSkill(request)
  }

  // Deletes a personal or imported skill, returning the refreshed list.
  async deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]> {
    return this.skills.deleteSkill(request, this.skillDeletionGuard)
  }

  setSkillDeletionGuard(guard: (skillId: string) => Promise<void>): void {
    this.skillDeletionGuard = guard
  }

  // Imports a skill from a public GitHub URL (deduplicated), returning the outcome + refreshed list.
  async importSkill(request: ImportSkillRequest, signal?: AbortSignal): Promise<ImportSkillResult> {
    return this.skills.importSkill(request, signal)
  }

  async getGitHubTokenStatus(): Promise<GitHubTokenStatus> {
    return this.skills.getGitHubTokenStatus()
  }

  async saveGitHubToken(token: string): Promise<GitHubTokenStatus> {
    return this.skills.saveGitHubToken(token)
  }

  async removeGitHubToken(): Promise<GitHubTokenStatus> {
    return this.skills.removeGitHubToken()
  }

  // Imports a skill from an uploaded .zip / .skill bundle, returning the outcome + refreshed list. The
  // decode is bounded by the (larger) whole-bundle cap since one upload may carry many skills.
  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    return this.skills.importSkillZip(request)
  }

  // Imports several skills from ONE uploaded bundle in a single call (the bundle is decoded and
  // unpacked once). Per-item failures are reported without aborting the rest; the refreshed list is
  // returned once at the end.
  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): Promise<ImportSkillZipBatchResult> {
    return this.skills.importSkillZipBatch(request)
  }

  // Parses an uploaded bundle for a confirm-before-import preview, without writing anything. Returns
  // the importable skills plus any the bundle contained that were skipped (too large, no SKILL.md, ...).
  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult> {
    return this.skills.previewSkillZip(request)
  }

  // Main-process callers that already own validated bytes use these archive-level methods directly;
  // renderer IPC remains base64-shaped, while conversation imports avoid a redundant encode/decode.
  async previewSkillArchive(zip: Buffer): Promise<SkillBundlePreviewResult> {
    return this.skills.previewSkillArchive(zip)
  }

  async importSkillArchiveBatch(
    zip: Buffer,
    items: ImportSkillZipBatchRequest['items']
  ): ReturnType<UserSkillRepository['importFromZipBatch']> {
    return this.skills.importSkillArchiveBatch(zip, items)
  }

  // Lazily previews one GitHub skill without exposing host paths.
  async previewGitHubSkill(
    request: PreviewGitHubSkillRequest,
    signal?: AbortSignal
  ): Promise<SkillImportPreviewContent> {
    return this.skills.previewGitHubSkill(request, signal)
  }

  // Scans a GitHub repo for importable skill directories (marking already-imported ones).
  async scanRepoSkills(request: ScanRepoRequest, signal?: AbortSignal): Promise<ScanRepoResult> {
    return this.skills.scanRepoSkills(request, signal)
  }

  // Compatibility facade for installed Skill discovery, preview, and batch import.
  async listAgentHomeSkills(): Promise<AgentHomeSkillView[]> {
    return this.skills.listAgentHomeSkills()
  }

  async migrateAgentHomeSkillIdentities(): Promise<void> {
    await this.skills.migrateAgentHomeSkillIdentities()
  }

  async previewAgentHomeSkill(
    request: PreviewAgentHomeSkillRequest
  ): Promise<SkillImportPreviewContent> {
    return this.skills.previewAgentHomeSkill(request)
  }

  async importAgentHomeSkills(
    request: ImportAgentHomeSkillsRequest
  ): Promise<ImportAgentHomeSkillsResult> {
    return this.skills.importAgentHomeSkills(request)
  }
  // Computes the startup gates from a fresh or immediate startup-chain runtime probe.
  async getPreflight(): Promise<Preflight> {
    return this.runtimeManager.getPreflight(this.providers)
  }

  // Re-runs the complete host inspection on every app launch, for the SELECTED framework's runtime, so
  // a runtime installed outside Open Science between launches is picked up and onboarding can be
  // completed with Claude or OpenCode alone.
  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    return this.runtimeManager.checkEnvironment()
  }

  // Detects claude and persists the resolved path/version for later spawns.
  async detectClaude(): Promise<ClaudeDetectResult> {
    return this.runtimeManager.detectClaude()
  }

  // Runs the one-click installer, then re-detects claude so a success immediately unblocks the gate.
  // The app-managed source downloads the native binary itself and persists its exact path; the npm and
  // official-script sources shell out (with an automatic npm fallback when the official script is
  // region-blocked) and rely on PATH re-detection.
  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    return this.runtimeManager.installClaude(request, onEvent)
  }

  // Installs OpenCode from the requested source (app-managed download is the first recommendation, like
  // Claude). Managed downloads the native binary and persists its path + version; npm/script shell out
  // and then re-detect. Streams progress on the shared install-log channel.
  async installOpencode(
    request: InstallOpencodeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    return this.runtimeManager.installOpencode(request, onEvent)
  }

  async installCodeBuddy(
    request: InstallCodeBuddyRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    return this.runtimeManager.installCodeBuddy(request, onEvent)
  }

  async installCodex(
    request: InstallCodexRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    return this.runtimeManager.installCodex(request, onEvent)
  }

  // Uninstalls the app-managed Claude runtime. Only an install we own (a binary inside the app's data
  // dir) is removed; a PATH/npm Claude we merely detected is left untouched (a no-op that just returns
  // the current snapshot). When Claude was the active framework, the active backend auto-switches to
  // OpenCode if that is installed. `activeBackendAffected` is true only when Claude was the active
  // framework, so the IPC layer can reconnect the agent for that case alone — uninstalling the inactive
  // runtime leaves the live agent untouched and needs no reconnect.
  async uninstallClaude(): Promise<UninstallResult> {
    const { activeBackendAffected } = await this.runtimeManager.uninstallClaude()
    return { snapshot: await this.getSettingsView(), activeBackendAffected }
  }

  // Uninstalls the app-managed OpenCode runtime, mirroring uninstallClaude (guard, delete, re-detect,
  // auto-switch to Claude when OpenCode was active). Only an install inside the app's data dir is
  // removed; a PATH/npm opencode is left untouched. `activeBackendAffected` is true only when OpenCode
  // was active.
  async uninstallOpencode(): Promise<UninstallResult> {
    const { activeBackendAffected } = await this.runtimeManager.uninstallOpencode()
    return { snapshot: await this.getSettingsView(), activeBackendAffected }
  }

  async uninstallCodeBuddy(): Promise<UninstallResult> {
    const { activeBackendAffected } = await this.runtimeManager.uninstallCodeBuddy()
    return { snapshot: await this.getSettingsView(), activeBackendAffected }
  }

  async uninstallCodex(): Promise<UninstallResult> {
    const { activeBackendAffected } = await this.runtimeManager.uninstallCodex()
    return { snapshot: await this.getSettingsView(), activeBackendAffected }
  }

  // Records that first-run onboarding finished so later launches skip the wizard.
  async markOnboardingComplete(): Promise<SettingsSnapshot> {
    await this.preferences.markOnboardingComplete()
    return this.getSettingsView()
  }

  // Records that the one-time legacy-absolute-path normalization pass has succeeded, so later
  // launches skip it. The caller is responsible for only invoking this after the pass actually
  // completed without throwing (see normalizeLegacyDataPaths).
  async markPathsNormalized(): Promise<void> {
    await this.preferences.markPathsNormalized()
  }

  // Persists the new data-root path after a successful migration (see storage/migration-service.ts).
  // The caller is responsible for only invoking this once the move itself has succeeded.
  async setDataRoot(path: string, options?: SetDataRootOptions): Promise<void> {
    await this.preferences.setDataRoot(path, options)
  }

  // Records that the user has answered the one-time legacy-data-move prompt (moved, relocated, or
  // declined), so it is never shown again. Idempotent-once at the repository layer.
  async dismissLegacyDataMovePrompt(): Promise<void> {
    await this.preferences.dismissLegacyDataMovePrompt()
  }

  // Provider account state lives behind one owner; this façade keeps every existing transport and
  // renderer contract stable while whole-settings snapshot composition remains here.
  async upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot> {
    await this.providers.upsertProvider(request)
    return this.getSettingsView()
  }

  async rememberCodexAutoHttpsFallback(): Promise<boolean> {
    return this.repository.rememberCodexAutoHttpsFallback()
  }

  async deleteProvider(
    id: string,
    scenarioModelHandling?: ProviderDeletionScenarioModelHandling
  ): Promise<SettingsSnapshot> {
    await this.providers.deleteProvider(id, scenarioModelHandling)
    return this.getSettingsView()
  }

  beginXaiOAuthLogin(): ReturnType<ProviderAccountsModule['beginXaiOAuthLogin']> {
    return this.providers.beginXaiOAuthLogin()
  }

  waitXaiOAuthLogin(): ReturnType<ProviderAccountsModule['waitXaiOAuthLogin']> {
    return this.providers.waitXaiOAuthLogin()
  }

  cancelXaiOAuthLogin(): void {
    this.providers.cancelXaiOAuthLogin()
  }

  async logoutXaiOAuth(): Promise<SettingsSnapshot> {
    await this.providers.logoutXaiOAuth()
    return this.getSettingsView()
  }

  cancelCodexLogin(): void {
    this.providers.cancelCodexLogin()
  }

  cancelClaudeLogin(): void {
    this.providers.cancelClaudeLogin()
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedCodex()
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.providers.logoutIsolatedCodex()
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedClaude(token)
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedClaudeBrowser()
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    return this.providers.cancelClaudeIsolatedLogin()
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    return this.providers.logoutIsolatedClaude()
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    return this.providers.loginClaudeShared()
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    return this.providers.logoutClaudeShared()
  }

  async setActiveProvider(id: string, model?: string): Promise<SettingsSnapshot> {
    await this.providers.setActiveProvider(id, model)
    return this.getSettingsView()
  }

  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    return this.providers.validateProvider(request)
  }

  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    return this.providers.refreshProviderModels(request)
  }

  // Reports whether the OS keychain is usable so the UI can warn before a save is attempted.
  isEncryptionAvailable(): boolean {
    return isEncryptionAvailable()
  }

  // Reads the connector enablement/config block, read fresh so callers see the latest saved state.
  // Undefined when no connector has ever been configured.
  async getConnectors(): Promise<StoredConnectors | undefined> {
    return this.connectors.getConnectors()
  }

  // Lists every bundled connector with enabled / auto-allow state, plus shared NCBI credential state.
  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.connectors.listConnectors()
  }

  async listDeviceCredentials(): Promise<DeviceCredentialsSnapshot> {
    return this.connectors.listDeviceCredentials()
  }

  async deviceCredentialConsumerIds(id: string): Promise<string[]> {
    return this.connectors.deviceCredentialConsumerIds(id)
  }

  async deviceCredentialIdForServer(serverId: string): Promise<string | undefined> {
    return this.connectors.deviceCredentialIdForServer(serverId)
  }

  async createDeviceCredential(
    request: CreateDeviceCredentialRequest
  ): Promise<CreateDeviceCredentialResult> {
    return this.connectors.createDeviceCredential(request)
  }

  async updateDeviceCredential(
    request: UpdateDeviceCredentialRequest,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<DeviceCredentialsSnapshot> {
    return this.connectors.updateDeviceCredential(request, withConsumersBlocked)
  }

  async removeDeviceCredential(
    request: RemoveDeviceCredentialRequest
  ): Promise<DeviceCredentialsSnapshot> {
    return this.connectors.removeDeviceCredential(request)
  }

  async resolveDeviceOAuthCredential(
    id: string
  ): Promise<ResolvedOAuthDeviceCredential | undefined> {
    return this.connectors.resolveDeviceOAuthCredential(id)
  }

  setDeviceCredentialAuthenticator(
    authenticate: (credentialId: string) => Promise<void>,
    cancel: (credentialId: string) => Promise<void>,
    disconnect: (credentialId: string) => Promise<void>
  ): void {
    this.deviceCredentialAuthenticator = authenticate
    this.deviceCredentialAuthenticationCanceller = cancel
    this.deviceCredentialDisconnector = disconnect
  }

  async authenticateDeviceCredential(
    request: DeviceCredentialAuthenticationRequest
  ): Promise<DeviceCredentialsSnapshot> {
    if (!this.deviceCredentialAuthenticator) throw new Error('Device OAuth is unavailable')
    await this.deviceCredentialAuthenticator(request.id)
    return this.connectors.listDeviceCredentials()
  }

  async cancelDeviceCredentialAuthentication(
    request: DeviceCredentialAuthenticationRequest
  ): Promise<void> {
    await this.deviceCredentialAuthenticationCanceller?.(request.id)
  }

  async disconnectDeviceCredential(
    request: DeviceCredentialAuthenticationRequest,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<DeviceCredentialsSnapshot> {
    await this.deviceCredentialDisconnector?.(request.id)
    return this.connectors.disconnectDeviceCredential(request.id, withConsumersBlocked)
  }

  async previewCustomServerTemplateExport(id: string): Promise<ConnectorTemplateExportPreview> {
    return (await this.connectors.buildCustomServerTemplateExport(id)).preview
  }

  async buildCustomServerTemplateExport(id: string): Promise<{
    preview: ConnectorTemplateExportPreview
    contents?: string
  }> {
    return this.connectors.buildCustomServerTemplateExport(id)
  }

  async previewCustomServerTemplateImport(contents: string): Promise<ConnectorTemplatePreview> {
    return this.connectors.previewCustomServerTemplateImport(contents)
  }

  // Returns one connector's view plus its tools (with per-tool permission) and metadata.
  async getConnectorDetail(id: string): Promise<ConnectorDetailView> {
    return this.connectors.getConnectorDetail(id)
  }

  // Enables/disables one bundled connector and returns the refreshed snapshot.
  async setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setConnectorEnabled(request)
  }

  // Toggles "skip approvals" for one connector (autoAllowIds) and returns the refreshed snapshot.
  async setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setConnectorAutoAllow(request)
  }

  // Sets one tool's policy (allow = run without a prompt [default], ask = require approval when no
  // remembered Broker grant applies, block = denied) and returns the refreshed detail.
  async setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView> {
    return this.connectors.setToolPermission(request)
  }

  // Sets or clears the shared contact email and NCBI API key (encrypted at rest), returning state.
  async setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setNcbiCredentials(request)
  }

  async setOpenAlexCredential(request: SetOpenAlexCredentialRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setOpenAlexCredential(request)
  }

  async validateOpenAlexCredential(
    request: ValidateOpenAlexCredentialRequest
  ): Promise<OpenAlexCredentialValidation> {
    return this.connectors.validateOpenAlexCredential(request)
  }

  // Adds a user-provided custom MCP server (add-time trust is the caller's responsibility). The
  // config is sanitized to enforce per-transport requirements before it is persisted.
  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.addCustomServer(request)
  }

  // Enables/disables one custom MCP server and returns the refreshed snapshot.
  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    return this.connectors.setCustomServerEnabled(request)
  }

  async removeCustomServer(
    request: RemoveCustomServerRequest,
    afterPersistedRemoval: (serverId: string) => Promise<void>
  ): Promise<ConnectorsSnapshot> {
    return this.connectors.removeCustomServer(request, afterPersistedRemoval)
  }
  // Edits an existing custom MCP server, keeping its immutable identity (id, name, enabled, trust).
  // Omitted env/headers keep the stored secret values; providing them replaces the set. A caller can
  // invalidate remembered authority after validation but before persistence whenever the executable,
  // endpoint, transport, arguments, or credentials change. If invalidation fails, the old server
  // configuration remains authoritative.
  async updateCustomServer(
    request: UpdateCustomServerRequest,
    beforeSecuritySensitiveUpdate?: (
      serverId: string
    ) => Promise<CustomServerSecurityChangeGuard | void>
  ): Promise<ConnectorsSnapshot> {
    return this.connectors.updateCustomServer(request, beforeSecuritySensitiveUpdate)
  }

  // Persists OAuth state through the connector module's encrypted safeStorage projection. This is
  // intentionally main-process-only; renderer settings never receive the token-bearing state.
  async saveCustomServerOAuthState(
    serverId: string,
    state: StoredCustomMcpOAuthState | undefined,
    expectedConfigurationFingerprint?: string,
    expectedOAuthClientSecretRef?: string
  ): Promise<void> {
    return this.connectors.saveCustomServerOAuthState(
      serverId,
      state,
      expectedConfigurationFingerprint,
      expectedOAuthClientSecretRef
    )
  }

  setCustomServerAuthenticator(
    authenticator: (serverId: string) => Promise<void>,
    cancel: (serverId: string) => Promise<void>,
    disconnect?: (serverId: string) => Promise<void>
  ): void {
    this.customServerAuthenticator = authenticator
    this.customServerAuthenticationCanceller = cancel
    this.customServerDisconnector = disconnect
  }

  async authenticateCustomServer(serverId: string): Promise<ConnectorsSnapshot> {
    if (!this.customServerAuthenticator) {
      throw new Error('Custom MCP OAuth is not available yet')
    }
    await this.customServerAuthenticator(serverId)
    return this.connectors.setCustomServerEnabled({ id: serverId, enabled: true })
  }

  async cancelCustomServerAuthentication(serverId: string): Promise<void> {
    await this.customServerAuthenticationCanceller?.(serverId)
  }

  async disconnectCustomServer(
    serverId: string,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<ConnectorsSnapshot> {
    const credentialId = await this.connectors.deviceCredentialIdForServer(serverId)
    if (credentialId) {
      if (!this.deviceCredentialDisconnector) {
        throw new Error('Device OAuth disconnect is not available yet')
      }
      await this.deviceCredentialDisconnector(credentialId)
    } else {
      if (!this.customServerDisconnector) {
        throw new Error('Custom MCP OAuth disconnect is not available yet')
      }
      await this.customServerDisconnector(serverId)
    }
    return this.connectors.disconnectCustomServer(serverId, withConsumersBlocked)
  }

  // Reports whether npm is on PATH so the installer UI can default to/enable the npm source.
  async isNpmAvailable(): Promise<boolean> {
    return this.runtimeManager.isNpmAvailable()
  }

  // Returns the bookmark folders for a provider. Used by the remote file browser Go-to dropdown.
  async getComputeBookmarks(providerId: string): Promise<string[]> {
    const settings = await this.repository.getSettings()
    const store = settings.computeBookmarks ?? {}
    const folders = store[providerId]
    return Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : []
  }

  // Sets the bookmark folders for a provider. Replaces the full array for that provider.
  async setComputeBookmarks(providerId: string, folders: string[]): Promise<void> {
    await this.repository.setComputeBookmarks(providerId, folders)
  }

  // Reads the legacy settings.json granted-roots field for the one-time import into the
  // GrantedLocalRoot table (see local-fs/granted-roots-repository.ts). Malformed entries (e.g. from
  // a hand-edited settings.json) are dropped rather than failing the import. Production reads and
  // writes of granted roots go through the SQLite repository, never here.
  async getGrantedLocalRoots(): Promise<GrantedLocalRoot[]> {
    const settings = await this.repository.getSettings()
    return (settings.grantedLocalRoots ?? []).filter(
      (root): root is GrantedLocalRoot =>
        typeof root?.id === 'string' &&
        typeof root?.path === 'string' &&
        typeof root?.name === 'string' &&
        (root?.access === 'ro' || root?.access === 'rw')
    )
  }

  // Removes the legacy settings.json granted-roots field once the import into the GrantedLocalRoot
  // table has completed (see getGrantedLocalRoots).
  async clearGrantedLocalRoots(): Promise<void> {
    await this.repository.clearGrantedLocalRoots()
  }

  // Captures only non-secret backend identity. Runtime generations resolve credentials again at spawn,
  // so decrypted keys are not retained by the coordinator after AcpRuntime finishes authentication.
  async captureActiveAgentBackendSelection(): Promise<AgentBackendSelection> {
    return this.backendResolver.captureConfiguredSelection()
  }

  async captureActiveExplicitAgentBackendTarget(): Promise<ExplicitAgentBackendTarget> {
    return this.backendResolver.captureExplicitTarget()
  }

  async resolveExplicitAgentBackend(
    target: ExplicitAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.backendResolver.resolveExplicitTarget(target, context)
  }

  async resolveAdmittedSubagentBackend(
    ...args: Parameters<ScenarioModelOwner['subagent']['resolveAdmittedBackend']>
  ): ReturnType<ScenarioModelOwner['subagent']['resolveAdmittedBackend']> {
    return this.scenarioModels.subagent.resolveAdmittedBackend(...args)
  }

  async resolveAgentBackend(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.backendResolver.resolveSelection(selection, context)
  }
}

// Production service rooted at the fixed config root with real detection dependencies.
const createDefaultSettingsService = (): SettingsService => new SettingsService()

export { SettingsService, createDefaultSettingsService }
export type { CustomServerSecurityChangeGuard }
export type { AgentBackendResolutionContext, AgentBackendSelection } from './backend-resolver'
