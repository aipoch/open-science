import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallLogEvent,
  ClaudeInstallResult,
  CreateSkillRequest,
  DeleteSkillRequest,
  InstallClaudeRequest,
  Preflight,
  ProviderDraft,
  ProviderView,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetSkillEnabledRequest,
  SettingsSnapshot,
  SkillDetailView,
  SkillView,
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
  resolveVendorBaseUrl,
  resolveVendorModelsUrl
} from '../../shared/provider-registry'
import { resolveStorageRoot } from '../storage-root'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import { provisionAppClaudeConfigDir } from './claude-config-provision'
import { detectNpmAvailable, runInstall } from './claude-install'
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
import { applyLocalClaudeAuth, defaultUserClaudeDir } from './local-claude-auth'
import { computePreflight } from './preflight'
import { listProviderModels } from './list-models'
import { buildProviderEnv, getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import { SettingsRepository } from './repository'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { readSkillFile } from '../skills/skill-files'
import type { StoredProvider, StoredSettings } from './types'
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
  private providerSequence = 0

  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
    this.detectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.userClaudeDir = options.userClaudeDir ?? defaultUserClaudeDir()
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.userSkills = options.userSkills ?? new UserSkillRepository(this.storageRoot)
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()

    return {
      claude: settings.claude ?? {},
      activeProviderId: settings.activeProviderId,
      activeModel: settings.activeModel,
      providers: settings.providers.map((provider) => this.toProviderView(provider)),
      onboardingCompletedAt: settings.onboardingCompletedAt
    }
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

    return { ...this.toSkillView(skill, disabled), body }
  }

  // Toggles a skill and returns the refreshed list. The agent picks up the change on its next reconnect
  // (driven by the IPC layer's onSkillsChanged), which re-provisions the config dir.
  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    await this.repository.setSkillEnabled(request.id, request.enabled)

    return this.listSkills()
  }

  // Creates a personal skill from the in-app editor, returning the refreshed list.
  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.createPersonal(request)

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
    const outcome = await this.userSkills.importFromZip(Buffer.from(request.dataBase64, 'base64'))

    return { status: outcome.status, id: outcome.id, skills: await this.listSkills() }
  }

  // Parses an uploaded bundle for a confirm-before-import preview, without writing anything.
  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreview> {
    return this.userSkills.previewZip(Buffer.from(request.dataBase64, 'base64'))
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

  // Detects claude and persists the resolved path/version for later spawns.
  async detectClaude(): Promise<ClaudeDetectResult> {
    const result = await detectClaude(this.detectDeps)

    if (result.found && result.path) {
      await this.repository.setClaudeInfo({ resolvedPath: result.path, version: result.version })
    }

    return result
  }

  // Runs the one-click installer, then re-detects claude so a success immediately unblocks the gate.
  async installClaude(
    request: InstallClaudeRequest,
    onLog: (event: ClaudeInstallLogEvent) => void
  ): Promise<ClaudeInstallResult> {
    this.providerSequence += 1
    const installId = `install-${Date.now()}-${this.providerSequence}`
    const result = await runInstall({ source: request.source, installId, onLog })

    if (result.ok) {
      await this.detectClaude()
    }

    return result
  }

  // Records that first-run onboarding finished so later launches skip the wizard.
  async markOnboardingComplete(): Promise<SettingsSnapshot> {
    await this.repository.markOnboardingComplete(Date.now())

    return this.getSettingsView()
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
    // takes effect on the next spawn.
    const appConfigDir = getAppClaudeConfigDir(this.storageRoot)
    await provisionAppClaudeConfigDir(appConfigDir, {
      skills: await this.skillCatalog(),
      disabledSkillIds: settings.disabledSkillIds
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
        key
      }
    }

    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: modelOverride ?? provider.model,
      key
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
