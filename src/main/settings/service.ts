import { execFile } from 'node:child_process'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  ConnectorDetailView,
  ConnectorsSnapshot,
  ConnectorView,
  CustomServerView,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  CreateSkillRequest,
  DeleteSkillRequest,
  EnvironmentCheckResult,
  InstallClaudeRequest,
  NcbiCredentialsView,
  Preflight,
  ProviderApiType,
  ProviderDraft,
  ProviderView,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetSkillEnabledRequest,
  SetToolPermissionRequest,
  SettingsSnapshot,
  SkillDetailView,
  SkillView,
  ToolPermission,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  PreviewSkillZipRequest,
  SkillBundlePreview,
  ScanRepoRequest,
  ScanRepoResult,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import {
  defaultVendorModel,
  getOfficialVendor,
  isOfficialVendorId,
  resolveVendorApiType,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl
} from '../../shared/provider-registry'
import { resolveStorageRoot } from '../storage-root'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  listAgentFrameworks,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import { detectOpencode } from './opencode-detect'
import { installManagedOpencode } from './managed-opencode'
import { opencodeConfigDir } from '../agent-framework/opencode'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import { provisionAppClaudeConfigDir } from './claude-config-provision'
import { detectNpmAvailable, runInstallWithFallback } from './claude-install'
import { runEnvironmentCheck } from './environment-check'
import {
  DEFAULT_REGISTRIES,
  installManagedClaude,
  managedClaudeDir,
  type InstallManagedClaudeOptions,
  type ManagedInstallOutcome
} from './managed-claude'
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
import { applyLocalClaudeAuth, defaultUserClaudeDir } from './local-claude-auth'
import { computePreflight } from './preflight'
import { listProviderModels } from './list-models'
import { buildProviderEnv, getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import { SettingsRepository } from './repository'
import { sanitizeCustomMcpServer } from './repository'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { getConnectorTools } from '../connectors/registry'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { decodeBoundedBase64 } from '../skills/import-limits'
import { readSkillFile } from '../skills/skill-files'
import type {
  StoredConnectors,
  StoredCustomMcpServer,
  StoredProvider,
  StoredSettings
} from './types'
import { classifyStatus, validateProvider, type ClaudeProbeResult } from './validate'

const execFileAsync = promisify(execFile)

// Hard ceiling for the claude-default probe so a stuck local claude can never hang the wizard.
const CLAUDE_PROBE_TIMEOUT_MS = 20_000

type ExecuteClaudeProbe = (executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>

const executeClaudeProbe: ExecuteClaudeProbe = async (executablePath, env) => {
  await execFileAsync(executablePath, ['-p', 'ok'], {
    env,
    timeout: CLAUDE_PROBE_TIMEOUT_MS,
    // On Windows the detected claude is a `claude.cmd` shim, which execFile can't launch without a
    // shell (spawn EINVAL); route the probe through the shell there.
    shell: process.platform === 'win32',
    windowsHide: true
  })
}

// Detects a child-process timeout (SIGTERM kill or ETIMEDOUT) so the probe can report it distinctly.
const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as { killed?: boolean; signal?: string; code?: string }

  return (
    candidate.killed === true || candidate.signal === 'SIGTERM' || candidate.code === 'ETIMEDOUT'
  )
}

// A spawn configuration the ACP runtime reads at connect time so the active provider's credentials
// are always current.
export type AgentSpawnConfig = {
  envOverrides: Record<string, string>
  executablePath: string
}

export type SettingsServiceOptions = {
  repository?: SettingsRepository
  storageRoot?: string
  detectDeps?: ClaudeDetectDeps
  // The machine's own Claude config dir, read to reuse its login for the "local" provider. Injectable
  // so tests don't touch the real ~/.claude.
  userClaudeDir?: string
  // Bundled-skill source, injectable so tests can point at a seeded temp dir instead of app resources.
  skillRegistry?: SkillRegistry
  // Writable personal/imported skill store, injectable so tests can use a temp storage root.
  userSkills?: UserSkillRepository
  // One-shot Claude command runner, injectable so validation tests can inspect the exact auth env.
  executeClaudeProbe?: ExecuteClaudeProbe
  // One-shot managed Claude installer, injectable so tests avoid real network/fs.
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
}

// Orchestrates the settings units (repository + crypto + detect/install + validate) behind one
// object shared by the settings IPC handlers and the ACP runtime. Secrets are decrypted here only
// transiently; nothing that leaves this object (views, spawn config aside) carries plaintext.
class SettingsService {
  private readonly repository: SettingsRepository
  private readonly storageRoot: string
  private readonly detectDeps: ClaudeDetectDeps
  private readonly userClaudeDir: string
  private readonly skillRegistry: SkillRegistry
  private readonly userSkills: UserSkillRepository
  private readonly executeClaudeProbe: ExecuteClaudeProbe
  private readonly installManagedClaudeImpl: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  private providerSequence = 0
  // Skills force-loaded for the current turn: subtracted from the stored disabled set at spawn time so
  // a picked-but-disabled skill materializes for this prompt only, without mutating stored settings.
  private turnForcedSkillIds = new Set<string>()

  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
    // Probe the app-managed install dir too, so a managed Claude is re-detected even if the cached
    // path is ever cleared (e.g. a manual re-detect).
    const baseDetectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.detectDeps = {
      ...baseDetectDeps,
      extraDirs: [...(baseDetectDeps.extraDirs ?? []), managedClaudeDir(this.storageRoot)]
    }
    this.userClaudeDir = options.userClaudeDir ?? defaultUserClaudeDir()
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.userSkills = options.userSkills ?? new UserSkillRepository(this.storageRoot)
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
    this.installManagedClaudeImpl = options.installManagedClaudeImpl ?? installManagedClaude
  }

  // Returns the raw stored settings document (unmasked), for main-process bootstrap needs (e.g. priming
  // the data-root cache) that shouldn't go through the renderer-safe view.
  async getStoredSettings(): Promise<StoredSettings> {
    return this.repository.getSettings()
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()

    return {
      claude: settings.claude ?? {},
      opencode: { resolvedPath: settings.opencodePath, version: settings.opencodeVersion },
      activeProviderId: settings.activeProviderId,
      activeModel: settings.activeModel,
      providers: settings.providers.map((provider) => this.toProviderView(provider)),
      agentFrameworkId: settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
      agentFrameworks: listAgentFrameworks().map((framework) => ({
        id: framework.id,
        displayName: framework.displayName,
        supportsSkills: framework.supportsSkills,
        supportedApiTypes: [...framework.supportedApiTypes]
      })),
      onboardingCompletedAt: settings.onboardingCompletedAt
    }
  }

  // Selects the agent backend to drive; the caller reconnects so the choice applies to the next spawn.
  async setAgentFramework(id: AgentFrameworkId): Promise<SettingsSnapshot> {
    await this.repository.setAgentFramework(id)

    return this.getSettingsView()
  }

  // Detects the opencode executable and persists its path, mirroring detectClaude. Returns the refreshed
  // snapshot so the settings card reflects the result.
  async detectOpencode(): Promise<SettingsSnapshot> {
    const detected = await detectOpencode()

    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
    }

    return this.getSettingsView()
  }

  // The full skill catalog across every source: bundled (featured) + imported + personal.
  private async skillCatalog(): Promise<BundledSkill[]> {
    const [featured, user] = await Promise.all([this.skillRegistry.list(), this.userSkills.list()])

    return [...featured, ...user]
  }

  // Lists all skills (featured + imported + personal) with enabled state from the stored disabled set.
  async listSkills(): Promise<SkillView[]> {
    const [skills, settings] = await Promise.all([
      this.skillCatalog(),
      this.repository.getSettings()
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])

    return skills.map((skill) => this.toSkillView(skill, disabled))
  }

  // Sets the skills to force-load for the current turn (picked in the composer). Cleared after the turn.
  setTurnForcedSkillIds(ids: string[]): void {
    this.turnForcedSkillIds = new Set(ids)
  }

  // Clears the turn-scoped force-load set so later spawns use the normal enabled set.
  clearTurnForcedSkillIds(): void {
    this.turnForcedSkillIds.clear()
  }

  // Returns the subset of forced ids that are currently disabled in settings — i.e. the picks that need
  // a respawn to materialize. Enabled picks are already present and need no reconnect.
  async skillsNeedingForceLoad(forcedIds: string[]): Promise<string[]> {
    const settings = await this.repository.getSettings()
    const disabled = new Set(settings.disabledSkillIds ?? [])

    return forcedIds.filter((id) => disabled.has(id))
  }

  // Maps skill ids to their display names in the given order, skipping unknown ids. Used for the nudge.
  async skillNamesForIds(ids: string[]): Promise<string[]> {
    const skills = await this.skillCatalog()
    const nameById = new Map(skills.map((skill) => [skill.id, skill.name]))

    return ids.map((id) => nameById.get(id)).filter((name): name is string => name !== undefined)
  }

  // Returns one skill's view plus its SKILL.md body for the detail view (any source).
  async getSkillDetail(id: string): Promise<SkillDetailView> {
    const [skills, settings] = await Promise.all([
      this.skillCatalog(),
      this.repository.getSettings()
    ])
    const skill = skills.find((entry) => entry.id === id)

    if (!skill) {
      throw new Error(`Unknown skill: ${id}`)
    }

    const disabled = new Set(settings.disabledSkillIds ?? [])
    const { body } = await readSkillFile(skill.sourceDir)
    const references = await this.listSkillReferences(skill.sourceDir)

    return { ...this.toSkillView(skill, disabled), body, references }
  }

  // Lists the file names directly under a skill's `references/` directory (empty when absent).
  private async listSkillReferences(sourceDir: string): Promise<{ path: string }[]> {
    try {
      const entries = await readdir(join(sourceDir, 'references'), { withFileTypes: true })

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({ path: entry.name }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch {
      return []
    }
  }

  // Toggles a skill and returns the refreshed list. The agent picks up the change on its next reconnect
  // (driven by the IPC layer's onSkillsChanged), which re-provisions the config dir.
  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    await this.repository.setSkillEnabled(request.id, request.enabled)

    return this.listSkills()
  }

  // Creates a personal skill from the in-app editor, returning the refreshed list.
  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.createPersonal(request, request.slug)

    return this.listSkills()
  }

  // Updates an existing personal skill in place, returning the refreshed list.
  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.updatePersonal(request.id, {
      name: request.name,
      description: request.description,
      body: request.body,
      references: request.references
    })

    return this.listSkills()
  }

  // Deletes a personal or imported skill, returning the refreshed list.
  async deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]> {
    await this.userSkills.delete(request.id)
    // Drop any stale disabled entry so a re-created skill with the same id starts enabled.
    await this.repository.setSkillEnabled(request.id, true)

    return this.listSkills()
  }

  // Imports a skill from a public GitHub URL (deduplicated), returning the outcome + refreshed list.
  async importSkill(request: ImportSkillRequest): Promise<ImportSkillResult> {
    const outcome = await this.userSkills.importFromGitHub(request.url)

    return { status: outcome.status, id: outcome.id, skills: await this.listSkills() }
  }

  // Imports a skill from an uploaded .zip / .skill bundle, returning the outcome + refreshed list.
  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    const outcome = await this.userSkills.importFromZip(decodeBoundedBase64(request.dataBase64), {
      subPath: request.subPath,
      replaceId: request.replaceId
    })

    return { status: outcome.status, id: outcome.id, skills: await this.listSkills() }
  }

  // Parses an uploaded bundle for a confirm-before-import preview, without writing anything. Returns
  // one preview per skill root the bundle contains.
  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreview[]> {
    return this.userSkills.previewZip(decodeBoundedBase64(request.dataBase64))
  }

  // Scans a GitHub repo for importable skill directories (marking already-imported ones).
  async scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult> {
    return { skills: await this.userSkills.scanRepo(request.repo) }
  }

  // Projects a catalog skill into its renderer-safe view given the disabled set.
  private toSkillView(skill: BundledSkill, disabled: Set<string>): SkillView {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      updatedAt: skill.updatedAt,
      enabled: !disabled.has(skill.id),
      author: skill.author,
      license: skill.license,
      thirdParty: skill.thirdParty
    }
  }

  // Computes the two startup gates, re-checking the claude path each call as the design requires.
  async getPreflight(): Promise<Preflight> {
    const settings = await this.repository.getSettings()
    const claudePathExists = settings.claude?.resolvedPath
      ? await this.pathExists(settings.claude.resolvedPath)
      : false

    return computePreflight({
      settings,
      claudePathExists,
      isProviderKeyUsable: (provider) => this.isProviderKeyUsable(provider)
    })
  }

  // Re-runs the complete host inspection on every app launch. Claude detection is part of the same
  // pass so a runtime installed outside Open Science between launches is picked up immediately.
  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    // Prefer a previously recorded runtime that still runs over this launch's re-detection. This keeps
    // a healthy app-managed (or manually chosen) executable from being silently replaced by a PATH
    // entry discovered later — e.g. an npm `claude.cmd` that only works via a shell — and uses the
    // `--version` probe (not mere file existence) as the real usability signal, so a stale-but-present
    // path is never reported as healthy.
    const cached = (await this.repository.getSettings()).claude
    let claude: ClaudeDetectResult | undefined

    if (cached?.resolvedPath) {
      const version = await this.detectDeps.getVersion(cached.resolvedPath)

      if (version) {
        claude = { found: true, path: cached.resolvedPath, version }

        // Keep the stored version in sync when an in-place update changed it under the same path.
        if (version !== cached.version) {
          await this.repository.setClaudeInfo({ resolvedPath: cached.resolvedPath, version })
        }
      }
    }

    // No healthy recorded runtime: fall back to a full detection pass, which persists what it finds so
    // a runtime installed outside Open Science between launches is picked up.
    if (!claude) {
      claude = await this.detectClaude()
    }

    return runEnvironmentCheck({
      storageRoot: this.storageRoot,
      claude,
      encryptionAvailable: this.isEncryptionAvailable()
    })
  }

  // Detects claude and persists the resolved path/version for later spawns.
  async detectClaude(): Promise<ClaudeDetectResult> {
    const result = await detectClaude(this.detectDeps)

    if (result.found && result.path) {
      await this.repository.setClaudeInfo({ resolvedPath: result.path, version: result.version })
    }

    return result
  }

  // Runs the one-click installer, then re-detects claude so a success immediately unblocks the gate.
  // The app-managed source downloads the native binary itself and persists its exact path; the npm and
  // official-script sources shell out (with an automatic npm fallback when the official script is
  // region-blocked) and rely on PATH re-detection.
  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    this.providerSequence += 1
    const installId = `install-${Date.now()}-${this.providerSequence}`

    if (request.source === 'managed') {
      const registries =
        request.managedRegistry === 'npmmirror'
          ? [DEFAULT_REGISTRIES[1], DEFAULT_REGISTRIES[0]]
          : DEFAULT_REGISTRIES
      const outcome = await this.installManagedClaudeImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot,
        registries
      })

      if (outcome.result.ok && outcome.resolvedPath) {
        const installedVersion = await this.detectDeps.getVersion(outcome.resolvedPath)

        if (!installedVersion) {
          const error =
            'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
          onEvent({ kind: 'log', installId, stream: 'system', chunk: `${error}\n` })
          return { installId, ok: false, error }
        }

        await this.repository.setClaudeInfo({
          resolvedPath: outcome.resolvedPath,
          version: outcome.version
        })
      }

      return outcome.result
    }

    const result = await runInstallWithFallback({ source: request.source, installId, onEvent })

    if (result.ok) {
      await this.detectClaude()
    }

    return result
  }

  // App-managed OpenCode install (first recommendation, like Claude): downloads the native binary and
  // persists its path + version. Streams progress on the shared install-log channel.
  async installOpencode(
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    this.providerSequence += 1
    const installId = `install-opencode-${Date.now()}-${this.providerSequence}`
    const outcome = await installManagedOpencode({ installId, onEvent, dataRoot: this.storageRoot })

    if (outcome.result.ok && outcome.resolvedPath) {
      await this.repository.setOpencodeInfo(outcome.resolvedPath, outcome.version)
    }

    return outcome.result
  }

  // Records that first-run onboarding finished so later launches skip the wizard.
  async markOnboardingComplete(): Promise<SettingsSnapshot> {
    await this.repository.markOnboardingComplete(Date.now())

    return this.getSettingsView()
  }

  // Records that the one-time legacy-absolute-path normalization pass has succeeded, so later
  // launches skip it. The caller is responsible for only invoking this after the pass actually
  // completed without throwing (see normalizeLegacyDataPaths).
  async markPathsNormalized(): Promise<void> {
    await this.repository.markPathsNormalized(Date.now())
  }

  // Persists the new data-root path after a successful migration (see storage/migration-service.ts).
  // The caller is responsible for only invoking this once the move itself has succeeded.
  async setDataRoot(path: string): Promise<void> {
    await this.repository.setDataRoot(path)
  }

  // Records that the user has answered the one-time legacy-data-move prompt (moved, relocated, or
  // declined), so it is never shown again. Idempotent-once at the repository layer.
  async dismissLegacyDataMovePrompt(): Promise<void> {
    await this.repository.markLegacyDataMovePromptDismissed(Date.now())
  }

  // Encrypts any new key, recomputes its mask, and inserts/updates the provider record.
  async upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()
    const existing = request.id
      ? settings.providers.find((provider) => provider.id === request.id)
      : undefined

    const provider: StoredProvider = {
      id: existing?.id ?? this.createProviderId(),
      type: request.type,
      name: request.name?.trim() || existing?.name || 'Untitled provider'
    }

    // Both custom and official gateways authenticate with a bearer key; carry it (or keep the stored
    // ciphertext on edit) via one shared helper.
    const carryKey = (): boolean => {
      const hasKey = Boolean(request.key) || Boolean(existing?.keyRef)

      if (request.key) {
        provider.keyRef = encryptKey(request.key)
        provider.keyMask = maskKey(request.key)
      } else if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }

      return hasKey
    }

    // Tracks whether credentials/endpoint changed, which invalidates a prior validation.
    let credentialsChanged = false

    if (request.type === 'official') {
      // Base URL and model catalog come from the registry; the provider only stores which vendor
      // (and, for multi-region vendors, which endpoint) plus the key.
      const vendorId = isOfficialVendorId(request.vendorId) ? request.vendorId : existing?.vendorId

      if (!vendorId) throw new Error('A vendor is required for an official provider.')

      const region = request.region ?? existing?.region

      // Official providers store no model of their own: the catalog is fixed by the registry and the
      // chosen model is the global selection (activeModel). Only vendor/region/key are persisted.
      provider.vendorId = vendorId
      if (region) provider.region = region
      // Keep any live-fetched models across an edit, unless the vendor itself changed (then they're
      // stale and will be re-fetched on demand).
      if (existing?.fetchedModels && vendorId === existing.vendorId) {
        provider.fetchedModels = existing.fetchedModels
      }

      if (!carryKey()) throw new Error('API key is required for an official provider.')

      credentialsChanged =
        Boolean(request.key) ||
        provider.vendorId !== existing?.vendorId ||
        provider.region !== existing?.region
    } else if (request.type === 'custom') {
      const baseUrl = request.baseUrl?.trim() || existing?.baseUrl
      const model = request.model?.trim() || existing?.model

      // Required-field guard: never persist an incomplete custom provider, even if the UI is bypassed.
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!carryKey()) throw new Error('API key is required for a custom provider.')

      provider.baseUrl = baseUrl
      provider.model = model
      // Which chat API this gateway speaks (drives per-framework availability); defaults to anthropic.
      provider.apiType = request.apiType ?? existing?.apiType ?? 'anthropic'
      credentialsChanged = Boolean(request.key)
    } else {
      // claude-default: optional model override, no credentials of its own.
      const model = request.model?.trim() || existing?.model

      if (model) provider.model = model
    }

    // A re-test is required before a changed provider can re-gate onboarding.
    if (existing?.lastValidatedAt !== undefined && !credentialsChanged) {
      provider.lastValidatedAt = existing.lastValidatedAt
    }

    // Carry a prior failure only while credentials are unchanged; a credential change invalidates it
    // (the provider must be re-tested), so it drops and the warning clears until the next test.
    if (existing?.lastValidationFailure !== undefined && !credentialsChanged) {
      provider.lastValidationFailure = existing.lastValidationFailure
    }

    await this.repository.upsertProvider(provider)

    return this.getSettingsView()
  }

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    await this.repository.deleteProvider(id)

    return this.getSettingsView()
  }

  // Activates a provider and the model to run within it. An omitted/unknown model falls back to the
  // provider's default (its stored model, or the vendor's first catalog entry).
  async setActiveProvider(id: string, model?: string): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find((candidate) => candidate.id === id)
    const resolvedModel = this.resolveActiveModel(provider, model)

    await this.repository.setActiveProvider(id, resolvedModel)

    return this.getSettingsView()
  }

  // Validates a saved provider or an unsaved draft; on success for a saved provider records the time.
  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const resolved = this.resolveValidationTarget(request, settings)

    if (!resolved) {
      return { ok: false, category: 'unknown', message: 'No provider to validate.' }
    }

    const result = await validateProvider(resolved.provider, {
      runClaudeProbe:
        resolved.provider.type === 'claude-default'
          ? () => this.runClaudeProbe(resolved.provider, settings)
          : undefined
    })

    if (resolved.storedId) {
      const stored = settings.providers.find((provider) => provider.id === resolved.storedId)!

      // Success stamps the validated time and clears any prior failure. A failure keeps the provider
      // but records why, so the list can flag it and the model pickers exclude it until it passes.
      await this.repository.upsertProvider(
        result.ok
          ? { ...stored, lastValidatedAt: Date.now(), lastValidationFailure: undefined }
          : {
              ...stored,
              lastValidationFailure: {
                at: Date.now(),
                category: result.category,
                status: result.status,
                message: result.message
              }
            }
      )
    }

    return result
  }

  // Fetches a saved provider's live model list from the vendor and, on success, persists it as the
  // provider's models (overriding the bundled catalog). Failures leave the bundled catalog in place.
  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    const settings = await this.repository.getSettings()
    const stored = settings.providers.find((provider) => provider.id === request.providerId)

    if (!stored) return { ok: false, category: 'unknown', message: 'Provider not found.' }

    const modelsUrl =
      stored.type === 'official' && stored.vendorId
        ? resolveVendorModelsUrl(stored.vendorId, stored.region)
        : undefined

    if (!modelsUrl) {
      return {
        ok: false,
        category: 'unknown',
        message: 'This provider has no model-list endpoint.'
      }
    }

    const result = await listProviderModels({
      url: modelsUrl,
      key: this.resolveProvider(stored).key
    })

    if (!result.ok || !result.models) {
      return {
        ok: false,
        category: result.status ? classifyStatus(result.status) : 'network',
        message: result.message
      }
    }

    await this.repository.upsertProvider({ ...stored, fetchedModels: result.models })

    return { ok: true, category: 'ok', models: result.models }
  }

  // Reports whether the OS keychain is usable so the UI can warn before a save is attempted.
  isEncryptionAvailable(): boolean {
    return isEncryptionAvailable()
  }

  // Reads the connector enablement/config block, read fresh so callers see the latest saved state.
  // Undefined when no connector has ever been configured.
  async getConnectors(): Promise<StoredConnectors | undefined> {
    const settings = await this.repository.getSettings()

    return settings.connectors
  }

  // Materializes the enabled skill set into opencode's isolated config dir (same skills/<name>/SKILL.md
  // layout Claude uses), so opencode's native skill tool discovers them. A turn-forced skill overrides
  // its disabled state, mirroring the Claude provisioning path.
  private async materializeOpencodeSkills(settings: StoredSettings): Promise<void> {
    const disabled = new Set(
      (settings.disabledSkillIds ?? []).filter((id) => !this.turnForcedSkillIds.has(id))
    )
    const enabled = (await this.skillCatalog()).filter((skill) => !disabled.has(skill.id))

    await new ClaudeCodeSkillMaterializer().sync(opencodeConfigDir(this.storageRoot), enabled)
  }

  // Bundled connectors the user hasn't turned off (default-on), for opencode instruction delivery.
  private enabledConnectorIds(connectors: StoredConnectors | undefined): string[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => meta.id).filter((id) => !disabled.has(id))
  }

  // Projects the bundled catalog into renderer views, applying the stored opt-out / auto-allow sets.
  private toConnectorViews(connectors: StoredConnectors | undefined): ConnectorView[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])
    const autoAllow = new Set(connectors?.autoAllowIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => ({
      id: meta.id,
      displayName: meta.displayName,
      description: meta.description,
      sources: meta.sources,
      requiresNcbi: meta.requiresNcbi,
      enabled: !disabled.has(meta.id),
      autoAllow: autoAllow.has(meta.id),
      group: meta.group ?? 'featured'
    })).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private ncbiView(connectors: StoredConnectors | undefined): NcbiCredentialsView {
    return { contactEmail: connectors?.contactEmail, hasApiKey: !!connectors?.ncbiApiKeyRef }
  }

  // Projects stored custom MCP servers into renderer views (no secret env/header values).
  private toCustomServerViews(connectors: StoredConnectors | undefined): CustomServerView[] {
    return (connectors?.customMcpServers ?? [])
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        transport: s.transport,
        enabled: s.enabled,
        command: s.command,
        args: s.args,
        url: s.url
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async connectorsSnapshot(): Promise<ConnectorsSnapshot> {
    const connectors = await this.getConnectors()

    return {
      connectors: this.toConnectorViews(connectors),
      customServers: this.toCustomServerViews(connectors),
      ncbi: this.ncbiView(connectors)
    }
  }

  // Lists every bundled connector with enabled / auto-allow state, plus shared NCBI credential state.
  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.connectorsSnapshot()
  }

  // Returns one connector's view plus its tools (with per-tool permission) and metadata.
  async getConnectorDetail(id: string): Promise<ConnectorDetailView> {
    const meta = CONNECTOR_CATALOG.find((entry) => entry.id === id)

    if (!meta) throw new Error(`Unknown connector: ${id}`)

    const connectors = await this.getConnectors()
    const view = this.toConnectorViews(connectors).find((entry) => entry.id === id)
    const blocked = new Set(connectors?.blockedToolIds ?? [])
    const ask = new Set(connectors?.askToolIds ?? [])
    const tools = getConnectorTools(id).map((tool) => {
      const toolId = `${id}/${tool.id}`
      // Precedence: block > ask > allow (the default; tools run without a prompt unless opted in).
      const permission: ToolPermission = blocked.has(toolId)
        ? 'block'
        : ask.has(toolId)
          ? 'ask'
          : 'allow'

      return { id: toolId, method: tool.id, description: tool.description, permission }
    })

    return { ...view!, useWhen: meta.useWhen, termsUrl: meta.termsUrl, tools }
  }

  // Enables/disables one bundled connector and returns the refreshed snapshot.
  async setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorDisabled(request.id, !request.enabled)

    return this.connectorsSnapshot()
  }

  // Toggles "skip approvals" for one connector (autoAllowIds) and returns the refreshed snapshot.
  async setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorAutoAllow(request.id, request.autoAllow)

    return this.connectorsSnapshot()
  }

  // Sets one tool's permission (allow = run without a prompt [default], ask = prompt each call,
  // block = denied) and returns the connector's refreshed detail.
  async setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView> {
    await this.repository.setToolPolicy(
      request.toolId,
      request.permission === 'ask',
      request.permission === 'block'
    )
    const connectorId = request.toolId.split('/')[0]

    return this.getConnectorDetail(connectorId)
  }

  // Sets or clears the shared contact email and NCBI API key (encrypted at rest), returning state.
  async setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot> {
    const existing = await this.getConnectors()
    // An omitted apiKey leaves the stored key unchanged; an empty string clears it.
    const apiKeyRef =
      request.apiKey === undefined
        ? existing?.ncbiApiKeyRef
        : request.apiKey === ''
          ? undefined
          : encryptKey(request.apiKey)

    await this.repository.setNcbiCredentials(request.contactEmail?.trim() || undefined, apiKeyRef)

    return this.connectorsSnapshot()
  }

  // Adds a user-provided custom MCP server (add-time trust is the caller's responsibility). The
  // config is sanitized to enforce per-transport requirements before it is persisted.
  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    const candidate: StoredCustomMcpServer = {
      id: randomUUID(),
      name: request.name.trim(),
      transport: request.transport,
      enabled: true,
      trustedAt: Date.now(),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(request.env && Object.keys(request.env).length > 0 ? { env: request.env } : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(request.headers && Object.keys(request.headers).length > 0
        ? { headers: request.headers }
        : {})
    }
    const server = sanitizeCustomMcpServer(candidate)

    if (!server) throw new Error('Invalid custom connector configuration')

    await this.repository.addCustomServer(server)

    return this.connectorsSnapshot()
  }

  // Enables/disables one custom MCP server and returns the refreshed snapshot.
  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    await this.repository.setCustomServerEnabled(request.id, request.enabled)

    return this.connectorsSnapshot()
  }

  // Removes one custom MCP server and returns the refreshed snapshot.
  async removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot> {
    await this.repository.removeCustomServer(request.id)

    return this.connectorsSnapshot()
  }

  // Edits an existing custom MCP server, keeping its immutable identity (id, name, enabled, trust).
  // Omitted env/headers keep the stored secret values; providing them replaces the set.
  async updateCustomServer(request: UpdateCustomServerRequest): Promise<ConnectorsSnapshot> {
    const existing = (await this.getConnectors())?.customMcpServers?.find(
      (s) => s.id === request.id
    )

    if (!existing) throw new Error(`Unknown custom connector: ${request.id}`)

    const env = request.env ?? existing.env
    const headers = request.headers ?? existing.headers
    const merged: StoredCustomMcpServer = {
      id: existing.id,
      name: existing.name,
      transport: request.transport,
      enabled: existing.enabled,
      ...(existing.trustedAt !== undefined ? { trustedAt: existing.trustedAt } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
    }
    const server = sanitizeCustomMcpServer(merged)

    if (!server) throw new Error('Invalid custom connector configuration')

    await this.repository.updateCustomServer(request.id, server)

    return this.connectorsSnapshot()
  }

  // Reports whether npm is on PATH so the installer UI can default to/enable the npm source.
  async isNpmAvailable(): Promise<boolean> {
    const { available } = await detectNpmAvailable()

    return available
  }

  // Builds the spawn env for the active provider, read fresh so switching takes effect on reconnect.
  async resolveActiveSpawnConfig(): Promise<AgentSpawnConfig> {
    const settings = await this.repository.getSettings()
    const executablePath = settings.claude?.resolvedPath

    if (!executablePath) {
      throw new Error('Claude executable is not configured. Complete onboarding in settings.')
    }

    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error('No active model provider is configured. Configure one in settings.')
    }

    // Ensure the app-owned config dir exists (and app assets are injected) before the agent spawns. The
    // enabled skill set (featured + imported + personal) is materialized here, so a toggle/create/import
    // takes effect on the next spawn. Any skill force-loaded for the current turn is subtracted from the
    // disabled set so a picked-but-disabled skill materializes for this prompt without mutating settings.
    const appConfigDir = getAppClaudeConfigDir(this.storageRoot)
    const disabledSkillIds = (settings.disabledSkillIds ?? []).filter(
      (id) => !this.turnForcedSkillIds.has(id)
    )
    await provisionAppClaudeConfigDir(appConfigDir, {
      skills: await this.skillCatalog(),
      disabledSkillIds
    })

    let envOverrides = buildProviderEnv(
      this.resolveProvider(activeProvider, settings.activeModel),
      {
        storageRoot: this.storageRoot,
        claudeExecutablePath: executablePath
      }
    )

    // The "local" provider reuses the machine's own Claude login: inject its token/base URL (or copy
    // OAuth credentials) at spawn time. OS-store-only OAuth falls back to Claude's implicit default
    // config context, because setting CLAUDE_CONFIG_DIR makes that native login invisible.
    if (activeProvider.type === 'claude-default') {
      envOverrides = await applyLocalClaudeAuth(envOverrides, {
        userClaudeDir: this.userClaudeDir,
        appConfigDir
      })
    }

    return { envOverrides, executablePath }
  }

  // Resolves the active agent backend for one connect: the selected framework plus its spawn inputs.
  // Claude reuses the existing provider-env path unchanged; other frameworks (opencode) map the active
  // provider to their own native config (a generated opencode.json) via the framework adapter and get
  // it written to disk before spawn. The framework can be forced with OPEN_SCIENCE_AGENT_FRAMEWORK for
  // the spike until the settings selector lands.
  async resolveActiveAgentBackend(): Promise<ResolvedAgentBackend> {
    const settings = await this.repository.getSettings()
    const forced = process.env.OPEN_SCIENCE_AGENT_FRAMEWORK
    const frameworkId: AgentFrameworkId =
      forced === 'opencode' || forced === 'claude-code'
        ? forced
        : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    const framework = getAgentFramework(frameworkId)

    if (framework.id === 'claude-code') {
      // Unchanged Claude path: skills provisioning + Anthropic-shaped env + local-auth handling.
      const { envOverrides, executablePath } = await this.resolveActiveSpawnConfig()

      return { framework, executablePath, env: envOverrides }
    }

    // opencode maps the provider onto its own isolated config; the adapter writes it before spawn, and
    // the enabled skill set is materialized into opencode's config dir (its native skill tool discovers
    // them on-demand, same SKILL.md layout as Claude).
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error('No active model provider is configured. Configure one in settings.')
    }

    await this.materializeOpencodeSkills(settings)
    const executablePath = await this.resolveOpencodeExecutable(settings.opencodePath)
    const provider = this.resolveProvider(activeProvider, settings.activeModel)
    const modelConfig = framework.prepareModelConfig(provider, {
      storageRoot: this.storageRoot,
      executablePath,
      // Connector conventions + tools, so opencode uses host.mcp instead of raw HTTP (it has no skill
      // docs like Claude). Enabled bundled connectors only.
      instructions: renderConnectorInstructions(this.enabledConnectorIds(settings.connectors))
    })
    await this.writeAgentConfigFiles(modelConfig.configFiles)

    // opencode picks the model from its own provider config; drive the app's active model over the ACP
    // session model configOption (applied best-effort per session by the runtime).
    return {
      framework,
      executablePath,
      env: modelConfig.env ?? {},
      args: modelConfig.args,
      sessionModel: provider.model
    }
  }

  // Locates the opencode binary: an explicitly stored path wins, else a best-effort PATH lookup.
  private async resolveOpencodeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath) return storedPath

    const detected = await detectOpencode()

    if (!detected) {
      throw new Error(
        'opencode executable not found. Install opencode or set its path in settings.'
      )
    }

    return detected.resolvedPath
  }

  // Writes a framework's generated config files (e.g. opencode.json) to disk ahead of spawn.
  private async writeAgentConfigFiles(
    files: { path: string; content: string }[] | undefined
  ): Promise<void> {
    for (const file of files ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content, 'utf8')
    }
  }

  // The chat API a provider speaks: official providers come from the registry, custom gateways from
  // their stored/drafted apiType, everything else defaults to Anthropic /v1/messages.
  private resolveProviderApiType(provider: StoredProvider): ProviderApiType {
    if (provider.type === 'official' && provider.vendorId) {
      return resolveVendorApiType(provider.vendorId)
    }

    return provider.apiType ?? 'anthropic'
  }

  // Maps a stored provider to its masked renderer view, flagging custom keys that no longer decrypt.
  private toProviderView(provider: StoredProvider): ProviderView {
    const hasKey = Boolean(provider.keyRef)
    // custom and official both require a decryptable key; claude-default carries none.
    const needsKey =
      provider.type !== 'claude-default' && hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      apiType: this.resolveProviderApiType(provider),
      baseUrl: provider.baseUrl,
      model: provider.model,
      vendorId: provider.vendorId,
      region: provider.region,
      models: this.availableModels(provider),
      maskedKey: provider.keyMask,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
      lastValidationFailure: provider.lastValidationFailure
    }
  }

  // Credentials usable: claude-default always; custom/official need a key that still decrypts.
  private isProviderKeyUsable(provider: StoredProvider): boolean {
    if (provider.type === 'claude-default') return true

    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  // Models selectable for a provider: the vendor catalog for official providers, else the single
  // configured model (custom always has one; claude-default may carry an override).
  private availableModels(provider: StoredProvider): string[] {
    if (provider.type === 'official' && provider.vendorId) {
      // Live-fetched models (via "refresh from vendor") take precedence over the bundled catalog.
      if (provider.fetchedModels && provider.fetchedModels.length > 0) return provider.fetchedModels

      return getOfficialVendor(provider.vendorId)?.models ?? []
    }

    return provider.model ? [provider.model] : []
  }

  // Picks the model to activate: the requested one when the provider offers it, else the first
  // available (falling back to a provider's own stored model).
  private resolveActiveModel(
    provider: StoredProvider | undefined,
    requested?: string
  ): string | undefined {
    if (!provider) return undefined

    const available = this.availableModels(provider)

    if (requested && available.includes(requested)) return requested
    // Prefer the provider's chosen default (custom's only model, or an official vendor's picked one).
    if (provider.model && available.includes(provider.model)) return provider.model

    return available[0] ?? provider.model
  }

  // Decrypts a stored provider into the spawn/validation shape (plaintext key held only transiently).
  // Official vendors reuse the custom HTTP/bearer path: base URL comes from the registry and the model
  // defaults to the vendor's first catalog entry unless a specific one is passed as the override.
  private resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    const key = provider.keyRef ? tryDecryptKey(provider.keyRef) : undefined

    if (provider.type === 'official' && provider.vendorId) {
      return {
        type: 'custom',
        baseUrl: resolveVendorBaseUrl(provider.vendorId, provider.region),
        model: modelOverride ?? defaultVendorModel(provider.vendorId),
        key,
        apiType: this.resolveProviderApiType(provider)
      }
    }

    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: modelOverride ?? provider.model,
      key,
      apiType: this.resolveProviderApiType(provider)
    }
  }

  // Resolves an unsaved draft into the validation shape, mapping an official draft to the custom path
  // with the vendor's registry base URL + default model.
  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
      return {
        type: 'custom',
        baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
        model: draft.model ?? defaultVendorModel(draft.vendorId),
        key: draft.key
      }
    }

    return {
      type: draft.type,
      baseUrl: draft.baseUrl,
      model: draft.model,
      key: draft.key
    }
  }

  // Resolves what validateProvider should probe: a stored provider (by id) or an inline draft.
  private resolveValidationTarget(
    request: ValidateProviderRequest,
    settings: StoredSettings
  ): { provider: ResolvedProvider; storedId?: string } | undefined {
    if (request.providerId) {
      const stored = settings.providers.find((provider) => provider.id === request.providerId)

      return stored ? { provider: this.resolveProvider(stored), storedId: stored.id } : undefined
    }

    if (request.draft) {
      return { provider: this.resolveDraft(request.draft) }
    }

    return undefined
  }

  // One-shot `claude -p "ok"` probe for claude-default validation, using the isolated/default env. A
  // hard timeout guarantees the wizard never hangs on a claude that never returns; a timeout is
  // reported distinctly so the UI can say "timed out" rather than "auth failed".
  private async runClaudeProbe(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): Promise<ClaudeProbeResult> {
    const executablePath = settings.claude?.resolvedPath

    if (!executablePath) {
      return { ok: false, message: 'Claude executable is not configured.' }
    }

    const appConfigDir = getAppClaudeConfigDir(this.storageRoot)
    await provisionAppClaudeConfigDir(appConfigDir, {
      skills: await this.skillCatalog(),
      disabledSkillIds: settings.disabledSkillIds
    })

    const envOverrides = await applyLocalClaudeAuth(
      buildProviderEnv(provider, {
        storageRoot: this.storageRoot,
        claudeExecutablePath: executablePath
      }),
      { userClaudeDir: this.userClaudeDir, appConfigDir }
    )
    const env = {
      ...process.env,
      ...envOverrides
    }

    // The native-auth fallback requires the variable to be absent, including from the parent process.
    if (!('CLAUDE_CONFIG_DIR' in envOverrides)) delete env.CLAUDE_CONFIG_DIR

    try {
      await this.executeClaudeProbe(executablePath, env)

      return { ok: true }
    } catch (error) {
      return isTimeoutError(error)
        ? { ok: false, timedOut: true, message: 'Local claude did not respond in time.' }
        : {
            ok: false,
            message:
              'Local Claude could not authenticate. Run `claude` in a terminal and log in, then try again.'
          }
    }
  }

  private createProviderId(): string {
    this.providerSequence += 1

    return `p_${Date.now()}_${this.providerSequence}`
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK)

      return true
    } catch {
      return false
    }
  }
}

// Production service rooted at the shared storage root with real detection dependencies.
const createDefaultSettingsService = (): SettingsService => new SettingsService()

export { SettingsService, createDefaultSettingsService }
