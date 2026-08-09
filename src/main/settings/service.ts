import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CloseActionPreference } from '../../shared/window-controls'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  ConnectorDetailView,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  ConnectorsSnapshot,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  AgentHomeSkillView,
  CreateSkillRequest,
  DeleteSkillRequest,
  EnvironmentCheckResult,
  GitHubTokenStatus,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetPackageMirrorRequest,
  SetSkillEnabledRequest,
  SetToolPermissionRequest,
  SettingsSnapshot,
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
  ReasoningEffort,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  SkillSource,
  ScanRepoRequest,
  ScanRepoResult,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { resolveStorageRoot } from '../storage-root'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  listAgentFrameworks,
  type AgentModelChangeTarget,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import type { ClaudeDetectDeps } from './claude-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { InstallManagedOpencodeOptions } from './managed-opencode'
import type { InstallManagedCodexOptions, ManagedCodexInstallOutcome } from './managed-codex'
import type { InstallManagedClaudeOptions, ManagedInstallOutcome } from './managed-claude'
import { isEncryptionAvailable } from './crypto'
import { getUserClaudeConfigDir } from './provider-env'
import { SettingsRepository } from './repository'
import { SettingsPreferencesModule, toSettingsPreferencesSnapshot } from './preferences'
import { NotebookRuntimeSettingsModule } from './notebook-runtime-settings'
import { SkillCatalogModule } from './skill-catalog'
import { ConnectorSettingsModule, type CustomServerSecurityChangeGuard } from './connector-settings'
import { ProviderAccountsModule } from './provider-accounts'
import { AgentRuntimeManager, type ExecuteClaudeProbe } from './agent-runtime-manager'
import {
  AgentBackendResolver,
  type AgentBackendResolutionContext,
  type AgentBackendSelection,
  type ExplicitAgentBackendTarget
} from './backend-resolver'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import type { SkillExportArchive } from '../skills/export'
import type { FetchLike } from '../skills/github-import'
import type { StoredConnectors, StoredCustomMcpOAuthState, StoredSettings } from './types'
import type { CodexAuthControllerPort } from './codex-auth'
import { createSettingsIdSequence } from './id-sequence'

import type { SystemProxyEnvironment } from './system-proxy'
import { type ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import { type ClaudeSharedAuthControllerPort } from './claude-shared-auth'

// Outcome of uninstalling a managed runtime. `activeBackendAffected` is true only when the removed
// runtime backed the active framework, so the IPC layer reconnects the agent for that case alone —
// removing the inactive framework's runtime leaves the live agent untouched.
export type UninstallResult = {
  snapshot: SettingsSnapshot
  activeBackendAffected: boolean
}

export type SettingsServiceOptions = {
  repository?: SettingsRepository
  storageRoot?: string
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  // Reserves the authenticated loopback HTTP port exposed by `opencode acp`. Injectable so settings
  // tests do not bind real sockets.
  allocateOpenCodeUsagePort?: () => Promise<number>
  codexDetectDeps?: CodexDetectDeps
  // The machine's own Claude config dir, used by the shared provider for auth/spawn and scanned as a
  // user skill source. Injectable so tests don't touch the real ~/.claude.
  userClaudeDir?: string
  // The machine's own Codex config dir, scanned for installed skills while Codex is active.
  // Injectable for the same reason as userClaudeDir.
  userCodexDir?: string
  // The framework-neutral Agents config dir. Codex and other compatible agents discover skills
  // under ~/.agents/skills; it is scanned regardless of the active framework.
  userAgentsDir?: string
  // Bundled-skill source, injectable so tests can point at a seeded temp dir instead of app resources.
  skillRegistry?: SkillRegistry
  // Writable personal/imported skill store, injectable so tests can use a temp storage root.
  userSkills?: UserSkillRepository
  // GitHub request implementation, injectable so credential tests never hit the network.
  githubFetch?: FetchLike
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
  // Encrypted-token controller for claude-isolated; default-constructed against this.storageRoot
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
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private customServerAuthenticator?: (serverId: string) => Promise<void>
  private customServerAuthenticationCanceller?: (serverId: string) => Promise<void>
  private skillDeletionGuard?: (skillId: string) => Promise<void>
  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
    this.preferences = new SettingsPreferencesModule(this.repository)
    this.notebookRuntimeSettings = new NotebookRuntimeSettingsModule(this.repository)
    this.connectors = new ConnectorSettingsModule(this.repository)
    this.userClaudeDir = options.userClaudeDir ?? getUserClaudeConfigDir()
    const userCodexDir = options.userCodexDir ?? join(homedir(), '.codex')
    this.skills = new SkillCatalogModule({
      repository: this.repository,
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir,
      userAgentsDir: options.userAgentsDir ?? join(homedir(), '.agents'),
      skillRegistry: options.skillRegistry ?? new SkillRegistry(),
      userSkills: options.userSkills ?? new UserSkillRepository(this.storageRoot),
      githubFetch: options.githubFetch
    })
    const allocateSettingsIdSequence = createSettingsIdSequence()
    this.runtimeManager = new AgentRuntimeManager({
      repository: this.repository,
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir,
      skills: this.skills,
      connectors: this.connectors,
      allocateSettingsIdSequence,
      detectDeps: options.detectDeps,
      opencodeDetectDeps: options.opencodeDetectDeps,
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
      storageRoot: this.storageRoot,
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
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir
    })
  }

  // Returns the raw stored settings document (unmasked), for main-process bootstrap needs (e.g. priming
  // the data-root cache) that shouldn't go through the renderer-safe view.
  async getStoredSettings(): Promise<StoredSettings> {
    return this.migrateLegacyKeyRefs(await this.repository.getSettings())
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.migrateLegacyKeyRefs(await this.repository.getSettings())
    const preferences = toSettingsPreferencesSnapshot(settings)

    return {
      claude: settings.claude ?? {},
      opencode: { resolvedPath: settings.opencodePath, version: settings.opencodeVersion },
      codex: {
        resolvedPath: settings.codex?.resolvedPath,
        version: settings.codex?.version,
        nativeVersion: settings.codex?.nativeVersion
      },
      claudeManaged: settings.claude?.resolvedPath
        ? this.runtimeManager.isManagedRuntimePath('claude-code', settings.claude.resolvedPath)
        : false,
      opencodeManaged: settings.opencodePath
        ? this.runtimeManager.isManagedRuntimePath('opencode', settings.opencodePath)
        : false,
      codexManaged: settings.codex?.resolvedPath
        ? this.runtimeManager.isManagedRuntimePath('codex', settings.codex.resolvedPath)
        : false,
      activeProviderId: settings.activeProviderId,
      claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
      activeModel: settings.activeModel,
      providers: settings.providers.map((provider) =>
        this.providers.toProviderView(
          provider,
          provider.id === settings.activeProviderId ? settings.activeModel : undefined
        )
      ),
      onboardingCompletedAt: preferences.onboardingCompletedAt,
      packageMirror: settings.packageMirror,
      reasoningEffort: preferences.reasoningEffort,
      notificationsEnabled: preferences.notificationsEnabled,
      conversationSkillImportEnabled: preferences.conversationSkillImportEnabled,
      closePreference: preferences.closePreference,
      appIconVariant: preferences.appIconVariant,
      defaultPermissionProfile: preferences.defaultPermissionProfile,
      agentFrameworkId: settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
      agentFrameworks: listAgentFrameworks().map((framework) => ({
        id: framework.id,
        displayName: framework.displayName,
        supportsSkills: framework.supportsSkills,
        supportedApiTypes: [...framework.supportedApiTypes]
      }))
    }
  }

  // Reads the package-mirror configuration, read fresh so callers see the latest saved state.
  // Empty object means public hosts (no override configured).
  async getPackageMirror(): Promise<PackageMirror> {
    return this.notebookRuntimeSettings.getPackageMirror()
  }

  // The persisted notebook runtime selection for a language (managed vs the user's own interpreter),
  // read fresh. undefined means "not chosen" -> the notebook runtime resolves to the managed default.
  async getRuntimeSelection(language: NotebookLanguage): Promise<RuntimeSelection | undefined> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).runtimeSelection
  }

  // Sets (or clears, when `selection` is null) the persisted runtime choice for a language, returning
  // the resulting per-language selection (undefined once cleared, or when a bad value was dropped).
  // Validation/rejection (bad shape, external R) lives in the repository so it can never be bypassed.
  async setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined> {
    return this.notebookRuntimeSettings.setRuntimeSelection(language, selection)
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

  // The manual-interpreter catalog for a language (paths added via "Add interpreter…"), for merging
  // into environment discovery. Empty array when none.
  async getManualInterpreters(language: NotebookLanguage): Promise<string[]> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).manualInterpreters
  }

  // Adds an interpreter path to a language's manual catalog (idempotent), returning the refreshed list.
  async addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.addManualInterpreter(language, path)
  }

  // Removes an interpreter path from a language's manual catalog, returning the refreshed list.
  async removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.removeManualInterpreter(language, path)
  }

  // Sets (or clears) the package-mirror configuration and returns the sanitized, persisted value.
  async setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    return this.notebookRuntimeSettings.setPackageMirror(request)
  }

  private async migrateLegacyKeyRefs(settings: StoredSettings): Promise<StoredSettings> {
    if (!isEncryptionAvailable()) return settings
    let changed = await this.providers.migrateLegacyKeyRefs(settings.providers)

    changed = (await this.connectors.migrateLegacyNcbiKeyRef(settings.connectors)) || changed

    return changed ? this.repository.getSettings() : settings
  }

  // Selects the agent backend to drive; the caller reconnects so the choice applies to the next spawn.
  async setAgentFramework(id: AgentFrameworkId): Promise<SettingsSnapshot> {
    await this.repository.setAgentFramework(id)

    return this.getSettingsView()
  }

  // Sets the reasoning-effort preference. Where the framework supports it the caller applies the
  // level live over ACP (otherwise it reconnects); the persisted value drives the next spawn.
  async setReasoningEffort(effort: ReasoningEffort): Promise<SettingsSnapshot> {
    await this.preferences.setReasoningEffort(effort)

    return this.getSettingsView()
  }

  // Projects one of the app's five stable user-intent slots through the active model's static effort
  // profile. This is intentionally async only because settings are read from disk; capability lookup
  // is synchronous and never performs provider discovery or a network request.
  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    return this.backendResolver.resolveActiveReasoningEffort(intent)
  }

  async resolveActiveModelChangeTarget(): Promise<AgentModelChangeTarget | undefined> {
    return this.backendResolver.resolveActiveModelChangeTarget()
  }

  // Whether desktop notifications for finished/failed agent tasks are on, read fresh so the
  // notification path sees a toggle change immediately (no restart, no cached copy to go stale).
  async getNotificationsEnabled(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).notificationsEnabled
  }

  // Sets the desktop-notification preference and returns the refreshed snapshot for the renderer.
  async setNotificationsEnabled(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setNotificationsEnabled(enabled)

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

  // The selected app-icon look, read fresh so the startup apply reflects the latest saved choice.
  async getAppIconVariant(): Promise<AppIconVariant> {
    return (await this.preferences.getSnapshot()).appIconVariant
  }

  // Persists the app-icon look; the caller applies it live to the window and dock/taskbar.
  async setAppIconVariant(variant: AppIconVariant): Promise<SettingsSnapshot> {
    await this.preferences.setAppIconVariant(variant)

    return this.getSettingsView()
  }

  async setDefaultPermissionProfile(profile: PermissionProfileId): Promise<SettingsSnapshot> {
    await this.preferences.setDefaultPermissionProfile(profile)

    return this.getSettingsView()
  }

  // Detects the opencode executable and persists its path, mirroring detectClaude. Returns the refreshed
  // snapshot so the settings card reflects the result.
  async detectOpencode(): Promise<SettingsSnapshot> {
    await this.runtimeManager.detectOpencode()
    return this.getSettingsView()
  }

  async detectCodex(): Promise<SettingsSnapshot> {
    await this.runtimeManager.detectCodex()
    return this.getSettingsView()
  }

  // Compatibility facade: Skill state and filesystem rules live in SkillCatalogModule.
  async listSkills(): Promise<SkillView[]> {
    return this.skills.listSkills()
  }

  // Internal main-process adapter used by host.skills. Unlike listSkills(), this includes bundled
  // internal Skills and returns source directories only to the trusted caller callback.
  async listHostSkills(): Promise<BundledSkill[]> {
    return this.skills.listHostSkills()
  }

  async withHostSkillRead<T>(
    id: string,
    read: (skill: BundledSkill) => Promise<T>
  ): Promise<T | undefined> {
    return this.skills.withHostSkillRead(id, read)
  }

  async publishHostSkill(slug: string, sourcePath: string, overwrite: boolean): Promise<string> {
    return this.skills.publishHostSkill(slug, sourcePath, overwrite)
  }

  async buildSkillExport(id: string): Promise<SkillExportArchive> {
    return this.skills.buildSkillExport(id)
  }

  // Specialist scopes intentionally see the installed catalog irrespective of Main Agent toggles.
  // The result is rebuilt for every caller so future imports and removals take effect on the next turn.
  async listSpecialistSkillCatalog(): Promise<
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
    return this.skills.listSpecialistSkillCatalog()
  }

  // Returns the mcp-<id> skill names for connectors provisioned at the Main Agent level (enabled
  // bundled connectors + enabled custom MCP servers). Specialist sessions merge these into their
  // skill whitelist so the agent can discover connector tools; the per-call ConnectorService gate
  // still enforces the specialist's own connector access config.
  async provisionedConnectorSkillNames(): Promise<string[]> {
    return this.connectors.provisionedConnectorSkillNames()
  }

  setMaterializedCustomSkillNamesProvider(provider: () => readonly string[]): void {
    this.connectors.setMaterializedCustomSkillNamesProvider(provider)
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

  async codexSkillCatalog(
    codexHome: string | undefined
  ): Promise<Array<{ name: string; description: string; path: string; source?: 'connector' }>> {
    return this.skills.codexSkillCatalog(codexHome, (settings) => {
      return this.connectors.enabledConnectorIds(settings.connectors).flatMap((id) => {
        const connector = CONNECTOR_CATALOG.find((candidate) => candidate.id === id)
        return connector
          ? [
              {
                directory: `mcp-${id}`,
                name: `mcp-${id}`,
                description: connector.useWhen,
                source: 'connector' as const
              }
            ]
          : []
      })
    })
  }

  // Returns one skill's view plus its SKILL.md body for the detail view (any source).
  async getSkillDetail(id: string): Promise<SkillDetailView> {
    return this.skills.getSkillDetail(id)
  }

  // Toggles a skill and returns the refreshed list. The agent picks up the change on its next reconnect
  // (driven by the IPC layer's onSkillsChanged), which re-provisions the config dir.
  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    return this.skills.setSkillEnabled(request)
  }

  // Creates a personal skill from the in-app editor, returning the refreshed list.
  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    return this.skills.createSkill(request)
  }

  // Updates an existing personal skill in place, returning the refreshed list.
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
  async importSkill(request: ImportSkillRequest): Promise<ImportSkillResult> {
    return this.skills.importSkill(request)
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

  // Lazily loads one selected GitHub candidate. The repository's bounded helper downloads only its
  // SKILL.md; the display label is reconstructed from the public URL and contains no host paths.
  async previewGitHubSkill(request: PreviewGitHubSkillRequest): Promise<SkillImportPreviewContent> {
    return this.skills.previewGitHubSkill(request)
  }

  // Scans a GitHub repo for importable skill directories (marking already-imported ones).
  async scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult> {
    return this.skills.scanRepoSkills(request)
  }

  // Compatibility facade for installed Skill discovery, preview, and batch import.
  async listAgentHomeSkills(): Promise<AgentHomeSkillView[]> {
    return this.skills.listAgentHomeSkills()
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
  // Computes the two startup gates, re-checking the claude path each call as the design requires.
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
  async setDataRoot(path: string): Promise<void> {
    await this.preferences.setDataRoot(path)
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

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    await this.providers.deleteProvider(id)
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

  // Removes one custom MCP server and returns the refreshed snapshot.
  async removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.removeCustomServer(request)
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
    state: StoredCustomMcpOAuthState | undefined
  ): Promise<void> {
    return this.connectors.saveCustomServerOAuthState(serverId, state)
  }

  setCustomServerAuthenticator(
    authenticator: (serverId: string) => Promise<void>,
    cancel: (serverId: string) => Promise<void>
  ): void {
    this.customServerAuthenticator = authenticator
    this.customServerAuthenticationCanceller = cancel
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

  async resolveAgentBackend(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.backendResolver.resolveSelection(selection, context)
  }
}

// Production service rooted at the shared storage root with real detection dependencies.
const createDefaultSettingsService = (): SettingsService => new SettingsService()

export { SettingsService, createDefaultSettingsService }
export type { CustomServerSecurityChangeGuard }
export type { AgentBackendResolutionContext, AgentBackendSelection } from './backend-resolver'
