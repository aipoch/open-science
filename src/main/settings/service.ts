import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallLogEvent,
  ClaudeInstallResult,
  InstallClaudeRequest,
  Preflight,
  ProviderView,
  SettingsSnapshot,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import { resolveStorageRoot } from '../storage-root'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import { detectNpmAvailable, runInstall } from './claude-install'
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
import { computePreflight } from './preflight'
import { buildProviderEnv, type ResolvedProvider } from './provider-env'
import { SettingsRepository } from './repository'
import type { StoredProvider, StoredSettings } from './types'
import { validateProvider, type ClaudeProbeResult } from './validate'

const execFileAsync = promisify(execFile)

// Hard ceiling for the claude-default probe so a stuck local claude can never hang the wizard.
const CLAUDE_PROBE_TIMEOUT_MS = 20_000

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
  // Settings scopes the ACP session should load. Custom (isolated) providers restrict this to
  // ["user"] so the user's global ~/.claude project/local settings can't override the injected
  // endpoint; claude-default leaves it undefined to reuse the user's full settings.
  settingSources?: readonly string[]
}

export type SettingsServiceOptions = {
  repository?: SettingsRepository
  storageRoot?: string
  detectDeps?: ClaudeDetectDeps
}

// Orchestrates the settings units (repository + crypto + detect/install + validate) behind one
// object shared by the settings IPC handlers and the ACP runtime. Secrets are decrypted here only
// transiently; nothing that leaves this object (views, spawn config aside) carries plaintext.
class SettingsService {
  private readonly repository: SettingsRepository
  private readonly storageRoot: string
  private readonly detectDeps: ClaudeDetectDeps
  private providerSequence = 0

  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
    this.detectDeps = options.detectDeps ?? createDefaultDetectDeps()
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()

    return {
      claude: settings.claude ?? {},
      activeProviderId: settings.activeProviderId,
      providers: settings.providers.map((provider) => this.toProviderView(provider))
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

    // Model applies to both types (required for custom, optional override for claude-default).
    const model = request.model?.trim() || existing?.model

    if (request.type === 'custom') {
      const baseUrl = request.baseUrl?.trim() || existing?.baseUrl
      // A key is present if one is provided now or a ciphertext was stored earlier (edit case).
      const hasKey = Boolean(request.key) || Boolean(existing?.keyRef)

      // Required-field guard: never persist an incomplete custom provider, even if the UI is bypassed.
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!hasKey) throw new Error('API key is required for a custom provider.')

      provider.baseUrl = baseUrl

      // A provided key is (re-)encrypted; an omitted key keeps the previously stored ciphertext.
      if (request.key) {
        provider.keyRef = encryptKey(request.key)
        provider.keyMask = maskKey(request.key)
      } else if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }
    }

    if (model) provider.model = model

    // Editing credentials invalidates a prior validation; a re-test is required before it re-gates.
    const keyChanged = request.type === 'custom' && Boolean(request.key)

    if (existing?.lastValidatedAt !== undefined && !keyChanged) {
      provider.lastValidatedAt = existing.lastValidatedAt
    }

    await this.repository.upsertProvider(provider)

    return this.getSettingsView()
  }

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    await this.repository.deleteProvider(id)

    return this.getSettingsView()
  }

  async setActiveProvider(id: string): Promise<SettingsSnapshot> {
    await this.repository.setActiveProvider(id)

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

    if (result.ok && resolved.storedId) {
      await this.repository.upsertProvider({
        ...settings.providers.find((provider) => provider.id === resolved.storedId)!,
        lastValidatedAt: Date.now()
      })
    }

    return result
  }

  // Reports whether the OS keychain is usable so the UI can warn before a save is attempted.
  isEncryptionAvailable(): boolean {
    return isEncryptionAvailable()
  }

  // Reports whether npm is on PATH so the installer UI can default to/enable the npm-mirror source.
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

    const envOverrides = buildProviderEnv(this.resolveProvider(activeProvider), {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath
    })

    // Custom providers are fully isolated: restrict the agent to the "user" settings scope (the
    // isolated CLAUDE_CONFIG_DIR) so the user's global ~/.claude project/local settings — which may
    // carry a proxy ANTHROPIC_BASE_URL env block — can't override the injected endpoint. claude-default
    // reuses the user's full settings, so it leaves this unset.
    const settingSources = activeProvider.type === 'custom' ? (['user'] as const) : undefined

    return { envOverrides, executablePath, settingSources }
  }

  // Maps a stored provider to its masked renderer view, flagging custom keys that no longer decrypt.
  private toProviderView(provider: StoredProvider): ProviderView {
    const hasKey = Boolean(provider.keyRef)
    const needsKey =
      provider.type === 'custom' && hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      maskedKey: provider.keyMask,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt
    }
  }

  // Credentials usable: claude-default always; custom needs a key that still decrypts.
  private isProviderKeyUsable(provider: StoredProvider): boolean {
    if (provider.type === 'claude-default') return true

    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  // Decrypts a stored provider into the spawn/validation shape (plaintext key held only transiently).
  private resolveProvider(provider: StoredProvider): ResolvedProvider {
    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: provider.model,
      key: provider.keyRef ? tryDecryptKey(provider.keyRef) : undefined
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
      return {
        provider: {
          type: request.draft.type,
          baseUrl: request.draft.baseUrl,
          model: request.draft.model,
          key: request.draft.key
        }
      }
    }

    return undefined
  }

  // One-shot `claude -p "ok"` probe for claude-default validation, using the isolated/default env.
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

    const env = {
      ...process.env,
      ...buildProviderEnv(provider, {
        storageRoot: this.storageRoot,
        claudeExecutablePath: executablePath
      })
    }

    try {
      await execFileAsync(executablePath, ['-p', 'ok'], {
        env,
        timeout: CLAUDE_PROBE_TIMEOUT_MS
      })

      return { ok: true }
    } catch (error) {
      return isTimeoutError(error)
        ? { ok: false, timedOut: true, message: 'Local claude did not respond in time.' }
        : { ok: false, message: 'Local claude could not complete a request.' }
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
