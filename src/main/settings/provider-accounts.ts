import { isDeepStrictEqual } from 'node:util'

import type {
  ChatApiEndpoint,
  ProviderDraft,
  ProviderView,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  claudeIsolatedProviderIdentity,
  claudeSharedProviderIdentity,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProvider,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  isProviderUsableByFramework,
  providerEndpoints,
  resolveCodexSubscriptionType,
  requiresChatCompletionsBridge
} from '../../shared/settings'
import {
  defaultVendorModel,
  getOfficialVendorModelIds,
  isOfficialVendorId,
  isVendorModelMultimodal,
  isVendorModelResponsesSupported,
  resolveCustomModelContextWindow,
  resolveModelContextWindow,
  resolveVendorApiEndpoints,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../shared/provider-reasoning-effort'
import type { ReasoningEffortProfile } from '../../shared/reasoning-effort'
import { isModelBridgeSupported } from '../../shared/provider-registry'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import {
  codexSubscriptionStorageDir,
  isOfficialOpenAiResponsesBase
} from '../agent-framework/codex'
import { netFetchStandard } from '../skills/net-fetch'
import {
  clearAppOwnedCodexAuthentication,
  clearImportedCodexProviderRoute,
  CodexAuthController,
  ensureCodexAuthHome,
  importCodexAuthentication,
  openCodexAuthSession,
  type CodexAuthControllerPort,
  type CodexAuthStatus
} from './codex-auth'
import {
  ClaudeIsolatedAuthController,
  type ClaudeIsolatedAuthControllerPort,
  type ClaudeIsolatedAuthStatus
} from './claude-isolated-auth'
import {
  ClaudeSharedAuthController,
  type ClaudeSharedAuthControllerPort,
  type ClaudeSharedAuthStatus
} from './claude-shared-auth'
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
import { classifyStatus, validateProvider as validateProviderTarget } from './validate'
import { listProviderModels } from './list-models'
import { getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import type { SettingsRepository } from './repository'
import type { SystemProxyEnvironment } from './system-proxy'
import type { StoredProvider, StoredSettings } from './types'

const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
const CLAUDE_SHARED_AUTH_STATUS_TTL_MS = 5_000
const CLAUDE_SHARED_DISCONNECTED_MESSAGE =
  'Claude is disconnected from Open Science. Sign in again to use your shared Claude profile.'

type ProviderAccountsModuleOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  userCodexDir: string
  allocateSettingsIdSequence: () => number
  resolveCodexExecutable: (
    adapterPath: string | undefined,
    nativePath: string | undefined
  ) => Promise<string>
  resolveCodexProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>
  runClaudeSubscriptionProbe: (
    provider: ResolvedProvider,
    settings: StoredSettings
  ) => Promise<ValidateProviderResult>
  codexAuth?: CodexAuthControllerPort
  claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
  claudeSharedAuth?: ClaudeSharedAuthControllerPort
}

export type RuntimeProviderModelSelection =
  | { kind: 'configured'; requestedModel?: string }
  | { kind: 'required'; model: string }
  | { kind: 'provider-default' }

export type ProviderRuntimeTarget = {
  providerId: string
  providerType: StoredProvider['type']
  disconnectedAt?: number
  effectiveModel?: string
  apiEndpoints: ChatApiEndpoint[]
  provider: ResolvedProvider
  reasoningEffortProfile: ReasoningEffortProfile
  frameworkCompatible: boolean
  modelBridgeSupported: boolean
  needsChatResponsesBridge: boolean
  needsNativeResponsesCompatibility: boolean
}

// Native Responses vendors other than OpenAI require the same namespace compatibility proxy during
// validation and runtime. Export one predicate so both paths prove the same protocol contract.
const requiresNativeResponsesCompatibility = (
  provider: ResolvedProvider,
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
): boolean =>
  framework.id === 'codex' &&
  framework.supportedApiTypes.includes('responses') &&
  providerEndpoints(provider).includes('responses') &&
  !isCodexSubscriptionProvider(provider.type) &&
  provider.vendorId !== 'openai' &&
  !isOfficialOpenAiResponsesBase(provider.openaiBaseUrl ?? provider.baseUrl)

// Owns durable provider records and every provider-specific validation/authentication lifecycle.
// Executable installation, runtime spawn configuration, live ACP reconnect, and transports remain
// outside this module.
class ProviderAccountsModule {
  private readonly repository: SettingsRepository
  private readonly codexAuth: CodexAuthControllerPort
  private readonly claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  private readonly claudeSharedAuth: ClaudeSharedAuthControllerPort
  private claudeSharedAuthStatusCache: { authenticated: boolean; checkedAt: number } | undefined
  private claudeSharedAuthStatusGeneration = 0
  private claudeSharedAuthStatusPromise:
    { generation: number; promise: Promise<boolean> } | undefined
  private readonly providerValidationGenerations = new Map<string, number>()

  constructor(private readonly options: ProviderAccountsModuleOptions) {
    this.repository = options.repository
    this.codexAuth =
      options.codexAuth ??
      new CodexAuthController({
        openSession: async (mode) => {
          const settings = await this.repository.getSettings()
          return openCodexAuthSession({
            adapterPath: await options.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            ),
            nativePath: settings.codex?.nativePath,
            mode,
            storageRoot: options.storageRoot,
            proxyEnv: await options.resolveCodexProxyEnvironment()
          })
        }
      })
    this.claudeIsolatedAuth =
      options.claudeIsolatedAuth ??
      new ClaudeIsolatedAuthController({
        store: {
          loadToken: () => this.loadClaudeIsolatedToken(),
          saveToken: (token) => this.saveClaudeIsolatedToken(token),
          clearToken: () => this.clearClaudeIsolatedToken(),
          isEncryptionAvailable: () => isEncryptionAvailable()
        },
        claudePath: async () => {
          const settings = await this.repository.getSettings()
          return settings.claude?.resolvedPath ?? 'claude'
        },
        configDir: getAppClaudeConfigDir(options.storageRoot)
      })
    this.claudeSharedAuth =
      options.claudeSharedAuth ??
      new ClaudeSharedAuthController({
        claudePath: async () => {
          const settings = await this.repository.getSettings()
          return settings.claude?.resolvedPath ?? 'claude'
        },
        configDir: options.userClaudeDir
      })
  }

  private async loadClaudeIsolatedToken(): Promise<string | undefined> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )

    return provider?.keyRef ? tryDecryptKey(provider.keyRef) : undefined
  }

  private async saveClaudeIsolatedToken(token: string): Promise<void> {
    const applied = await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef: encryptKey(token),
      keyMask: maskKey(token)
    })

    if (!applied) throw new Error('The Claude provider was removed before sign-in completed.')
  }

  private async clearClaudeIsolatedToken(): Promise<void> {
    await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef: undefined,
      keyMask: undefined
    })
  }

  // Invoked from SettingsService's existing whole-settings migration path so provider-before-
  // Connector ordering and encryption-availability timing remain unchanged.
  async migrateLegacyKeyRefs(providers: readonly StoredProvider[]): Promise<boolean> {
    let changed = false
    for (const provider of providers) {
      if (!provider.keyRef?.startsWith('plain:')) continue
      const key = tryDecryptKey(provider.keyRef)
      if (!key) continue
      await this.repository.upsertProvider({ ...provider, keyRef: encryptKey(key) })
      changed = true
    }
    return changed
  }

  async upsertProvider(request: UpsertProviderRequest): Promise<void> {
    const settings = await this.repository.getSettings()
    const subscriptionIdentity = isCodexSubscriptionProvider(request.type)
      ? codexSubscriptionProviderIdentity()
      : request.type === 'claude-isolated'
        ? claudeIsolatedProviderIdentity()
        : request.type === 'claude-shared'
          ? claudeSharedProviderIdentity()
          : undefined
    const requestedId = subscriptionIdentity?.id ?? request.id
    const existing = requestedId
      ? settings.providers.find((provider) => provider.id === requestedId)
      : undefined

    const reimportCodexAuthentication =
      request.type === 'codex-shared' && request.reimportCodexAuthentication === true
    if (
      request.type === 'codex-shared' &&
      (existing?.codexAuthMode !== 'imported' || reimportCodexAuthentication)
    ) {
      await this.codexAuth.cancelLogin()
      await importCodexAuthentication(
        this.options.userCodexDir,
        codexSubscriptionStorageDir(this.options.storageRoot)
      )
      if (reimportCodexAuthentication && requestedId) {
        this.advanceProviderValidationGeneration(requestedId)
      }
    } else if (request.type === 'codex-isolated' && existing?.codexAuthMode !== 'isolated') {
      if (existing) await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.options.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }
    if (isCodexSubscriptionProvider(request.type)) {
      await ensureCodexAuthHome(
        request.type === 'codex-shared' ? 'shared' : 'isolated',
        this.options.storageRoot
      )
    }

    const provider: StoredProvider = {
      id: subscriptionIdentity?.id ?? existing?.id ?? this.createProviderId(),
      type: request.type === 'codex-shared' ? 'codex-isolated' : request.type,
      name:
        subscriptionIdentity?.name ??
        (request.name?.trim() || existing?.name || 'Untitled provider')
    }

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

    let credentialsChanged = false
    if (isCodexSubscriptionProvider(request.type)) {
      provider.apiEndpoints = ['responses']
      provider.codexAuthMode = request.type === 'codex-shared' ? 'imported' : 'isolated'
      credentialsChanged =
        existing !== undefined &&
        (existing.codexAuthMode !== provider.codexAuthMode || reimportCodexAuthentication)
    } else if (request.type === 'claude-isolated') {
      provider.apiEndpoints = ['anthropic']
      if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }
      if (existing?.expiresAt !== undefined) provider.expiresAt = existing.expiresAt
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model
      if (model) provider.model = model
    } else if (request.type === 'claude-shared') {
      provider.apiEndpoints = ['anthropic']
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model
      if (model) provider.model = model
      if (existing?.disconnectedAt !== undefined) provider.disconnectedAt = existing.disconnectedAt
    } else if (request.type === 'official') {
      const vendorId = isOfficialVendorId(request.vendorId) ? request.vendorId : existing?.vendorId
      if (!vendorId) throw new Error('A vendor is required for an official provider.')
      const region = request.region ?? existing?.region
      provider.vendorId = vendorId
      if (region) provider.region = region
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
      const contextWindow =
        request.contextWindow === null
          ? undefined
          : (request.contextWindow ?? existing?.contextWindow)
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!carryKey()) throw new Error('API key is required for a custom provider.')
      if (
        contextWindow !== undefined &&
        (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
      ) {
        throw new Error('Context window must be a positive whole number of tokens.')
      }
      provider.baseUrl = baseUrl
      provider.model = model
      if (contextWindow !== undefined) provider.contextWindow = contextWindow
      provider.supportsImageInput =
        request.supportsImageInput ?? existing?.supportsImageInput ?? false
      provider.reasoningEffortPreset =
        request.reasoningEffortPreset ?? existing?.reasoningEffortPreset ?? 'standard-5'
      provider.reasoningEffortTransport =
        request.reasoningEffortTransport ?? existing?.reasoningEffortTransport ?? 'reasoning-effort'
      provider.apiEndpoints = request.apiEndpoints ?? existing?.apiEndpoints ?? ['anthropic']
      credentialsChanged =
        Boolean(request.key) ||
        provider.baseUrl !== existing?.baseUrl ||
        provider.model !== existing?.model ||
        provider.apiEndpoints.join(',') !== (existing?.apiEndpoints ?? []).join(',')
    }

    if (existing?.lastValidatedAt !== undefined && !credentialsChanged) {
      provider.lastValidatedAt = existing.lastValidatedAt
    }
    const preserveValidationFailure =
      !credentialsChanged ||
      (provider.type === 'claude-shared' && provider.disconnectedAt !== undefined)
    if (existing?.lastValidationFailure !== undefined && preserveValidationFailure) {
      provider.lastValidationFailure = existing.lastValidationFailure
    }

    if (isClaudeSubscriptionProvider(provider.type)) {
      const outgoingId =
        provider.type === 'claude-shared' ? CLAUDE_ISOLATED_PROVIDER_ID : CLAUDE_SHARED_PROVIDER_ID
      const collapsedCardWasActive =
        settings.activeProviderId === provider.id || settings.activeProviderId === outgoingId
      await this.repository.upsertProvider(provider)
      if (collapsedCardWasActive) {
        await this.repository.setActiveProvider(provider.id, this.resolveActiveModel(provider))
      }
      return
    }

    await this.repository.upsertProvider(provider)
  }

  async deleteProvider(id: string): Promise<void> {
    if (isCodexSubscriptionProviderId(id)) {
      await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.options.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }
    if (isClaudeSubscriptionProviderId(id)) {
      this.claudeIsolatedAuth.cancelLogin()
      this.claudeSharedAuth.cancelLogin()
    }
    await this.repository.deleteProvider(id)
  }

  cancelCodexLogin(): void {
    void this.codexAuth.cancelLogin()
  }

  cancelClaudeLogin(): void {
    this.claudeSharedAuth.cancelLogin()
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    const result = this.codexAuthValidationResult(await this.codexAuth.loginIsolated())
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return { ...result, applied: false }
    }

    await this.repository.upsertProvider(
      result.ok
        ? {
            ...provider,
            lastValidatedAt: Date.now(),
            lastValidationFailure: undefined
          }
        : {
            ...provider,
            lastValidatedAt: undefined,
            lastValidationFailure: {
              at: Date.now(),
              category: result.category,
              status: result.status,
              message: result.message
            }
          }
    )

    return { ...result, applied: true }
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return {
        ok: false,
        category: 'unknown',
        message: 'No isolated Open Science Codex login is configured.'
      }
    }

    await this.codexAuth.cancelLogin()
    try {
      await ensureCodexAuthHome('isolated', this.options.storageRoot)
      await clearAppOwnedCodexAuthentication(codexSubscriptionStorageDir(this.options.storageRoot))
    } catch {
      return {
        ok: false,
        category: 'unknown',
        message: 'The Open Science Codex login could not be removed.'
      }
    }

    await this.repository.upsertProvider({
      ...provider,
      lastValidatedAt: undefined,
      lastValidationFailure: undefined
    })

    return { ok: true, category: 'ok' }
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.finalizeClaudeIsolatedLogin(
      this.claudeIsolatedAuthValidationResult(await this.claudeIsolatedAuth.loginIsolated(token))
    )
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    const authStatus = await this.claudeIsolatedAuth.loginIsolatedBrowser()
    if (authStatus.cancelled) {
      return {
        ok: false,
        category: 'unknown',
        message: authStatus.message,
        applied: false,
        cancelled: true
      }
    }

    return this.finalizeClaudeIsolatedLogin(this.claudeIsolatedAuthValidationResult(authStatus))
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    this.claudeIsolatedAuth.cancelLogin()
  }

  private async finalizeClaudeIsolatedLogin(
    initialResult: ValidateProviderResult
  ): Promise<ValidateProviderResult> {
    let result = initialResult
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (!provider) return { ...result, applied: false }

    if (result.ok) {
      result = await this.options.runClaudeSubscriptionProbe(
        this.resolveProvider(
          provider,
          settings.activeProviderId === provider.id ? settings.activeModel : undefined
        ),
        settings
      )
      const applied = await this.repository.updateClaudeIsolatedValidationIfKeyMatches(
        provider.keyRef,
        result.ok
          ? {
              expiresAt: Date.now() + SETUP_TOKEN_LIFETIME_MS,
              lastValidatedAt: Date.now(),
              lastValidationFailure: undefined
            }
          : {
              expiresAt: undefined,
              lastValidatedAt: undefined,
              lastValidationFailure: {
                at: Date.now(),
                category: result.category,
                status: result.status,
                message: result.message
              }
            }
      )
      return { ...result, applied }
    }

    const applied = await this.repository.updateClaudeIsolatedValidationIfKeyMatches(
      provider.keyRef,
      {
        expiresAt: undefined,
        lastValidatedAt: undefined,
        lastValidationFailure: {
          at: Date.now(),
          category: result.category,
          status: result.status,
          message: result.message
        }
      }
    )
    return { ...result, applied }
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.logoutIsolated()
    if (status.message) {
      return {
        ok: false,
        category: status.message.toLowerCase().includes('timed out') ? 'timeout' : 'unknown',
        message: status.message
      }
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (provider && status.authenticated === false) {
      await this.repository.upsertProvider({
        ...provider,
        expiresAt: undefined,
        lastValidatedAt: undefined,
        lastValidationFailure: undefined
      })
    }

    return { ok: true, category: 'ok' }
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    const loginTarget = await this.repository.getSettings()
    const targetProvider = loginTarget.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    this.invalidateClaudeSharedAuthStatus()
    const authStatus = await this.claudeSharedAuth.loginShared()
    this.invalidateClaudeSharedAuthStatus()
    let result = this.claudeSharedAuthValidationResult(authStatus)

    if (authStatus.cancelled) return { ...result, applied: false, cancelled: true }
    if (targetProvider?.type !== 'claude-shared') return { ...result, applied: false }

    const settings = await this.repository.getSettings()
    const currentProvider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (
      settings.claudeSubscriptionProviderId !== loginTarget.claudeSubscriptionProviderId ||
      !isDeepStrictEqual(currentProvider, targetProvider)
    ) {
      return { ...result, applied: false }
    }

    const resolvedTarget = this.resolveProvider(
      targetProvider,
      settings.activeProviderId === targetProvider.id ? settings.activeModel : undefined
    )
    if (result.ok) {
      result = await this.options.runClaudeSubscriptionProbe(resolvedTarget, settings)
    }
    const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
      targetProvider,
      loginTarget.claudeSubscriptionProviderId,
      resolvedTarget.model,
      result.ok
        ? {
            disconnectedAt: undefined,
            lastValidatedAt: Date.now(),
            lastValidationFailure: undefined
          }
        : {
            disconnectedAt: authStatus.authenticated ? undefined : targetProvider.disconnectedAt,
            lastValidatedAt: undefined,
            lastValidationFailure: {
              at: Date.now(),
              category: result.category,
              status: result.status,
              message: result.message
            }
          }
    )

    return { ...result, applied }
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    this.invalidateClaudeSharedAuthStatus()
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (provider) {
      const disconnectedAt = Date.now()
      await this.repository.upsertProvider({
        ...provider,
        disconnectedAt,
        lastValidatedAt: undefined,
        lastValidationFailure: {
          at: disconnectedAt,
          category: 'auth',
          message: CLAUDE_SHARED_DISCONNECTED_MESSAGE
        }
      })
    }

    return { ok: true, category: 'ok' }
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (provider?.type !== 'claude-shared') {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.validateClaudeSharedProvider(
      this.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings,
      provider
    )
  }

  private async validateClaudeSharedProvider(
    provider: ResolvedProvider,
    settings: StoredSettings,
    storedProvider?: StoredProvider
  ): Promise<ValidateProviderResult> {
    if (storedProvider?.disconnectedAt !== undefined) {
      return { ok: false, category: 'auth', message: CLAUDE_SHARED_DISCONNECTED_MESSAGE }
    }

    const status = await this.claudeSharedAuth.getStatus()
    this.claudeSharedAuthStatusCache = {
      authenticated: status.authenticated,
      checkedAt: Date.now()
    }
    if (!status.authenticated) {
      return this.claudeSharedAuthValidationResult(
        status,
        'Not signed in. Sign in via browser OAuth in the Settings card to connect your Claude subscription.'
      )
    }

    return this.options.runClaudeSubscriptionProbe(provider, settings)
  }

  private claudeSharedAuthValidationResult(
    status: ClaudeSharedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    return { ok: false, category: 'unknown', message: status.message ?? notSignedInMessage }
  }

  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.getStatus()
    if (!status.authenticated) {
      return this.claudeIsolatedAuthValidationResult(
        status,
        'Not signed in. Run `claude setup-token` and paste the token to connect your Claude subscription.'
      )
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (!provider) {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.options.runClaudeSubscriptionProbe(
      this.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings
    )
  }

  private claudeIsolatedAuthValidationResult(
    status: ClaudeIsolatedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    return { ok: false, category: 'unknown', message: status.message ?? notSignedInMessage }
  }

  async setActiveProvider(id: string, model?: string): Promise<void> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find((candidate) => candidate.id === id)
    await this.repository.setActiveProvider(id, this.resolveActiveModel(provider, model))
  }

  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const resolved = this.resolveValidationTarget(request, settings)
    if (!resolved) {
      return { ok: false, category: 'unknown', message: 'No provider to validate.' }
    }

    const storedValidationTarget = resolved.storedId
      ? settings.providers.find((provider) => provider.id === resolved.storedId)
      : undefined
    const validationGeneration = resolved.storedId
      ? this.advanceProviderValidationGeneration(resolved.storedId)
      : undefined
    const framework = getAgentFramework(settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    const incompatibility =
      isCodexSubscriptionProvider(resolved.provider.type) ||
      resolved.provider.type === 'claude-isolated'
        ? undefined
        : this.frameworkIncompatibilityResult(resolved.provider, framework)

    const result =
      incompatibility ??
      (isCodexSubscriptionProvider(resolved.provider.type)
        ? this.codexAuthValidationResult(
            await this.codexAuth.getStatus(
              resolveCodexSubscriptionType(resolved.provider) === 'codex-shared'
                ? 'shared'
                : 'isolated'
            ),
            'Not signed in. Use Sign in to connect your ChatGPT account.'
          )
        : resolved.provider.type === 'claude-shared'
          ? await this.validateClaudeSharedProvider(
              resolved.provider,
              settings,
              resolved.storedId
                ? settings.providers.find((provider) => provider.id === resolved.storedId)
                : undefined
            )
          : resolved.provider.type === 'claude-isolated'
            ? await this.getClaudeIsolatedStatus()
            : await validateProviderTarget(resolved.provider, {
                fetchImpl: netFetchStandard,
                requireBridgeToolCall: requiresChatCompletionsBridge(resolved.provider, framework),
                requireNativeResponsesCompatibility: requiresNativeResponsesCompatibility(
                  resolved.provider,
                  framework
                ),
                frameworkEndpoints:
                  framework.id === 'codex' ? undefined : framework.supportedApiTypes
              }))

    if (!resolved.storedId) return result
    if (this.providerValidationGenerations.get(resolved.storedId) !== validationGeneration) {
      return { ...result, applied: false }
    }

    const latestSettings = await this.repository.getSettings()
    const stored = latestSettings.providers.find((provider) => provider.id === resolved.storedId)
    if (!stored) return { ...result, applied: false }
    const latestResolved = this.resolveProvider(
      stored,
      latestSettings.activeProviderId === stored.id ? latestSettings.activeModel : undefined
    )
    if (!this.sameValidationTarget(resolved.provider, latestResolved)) {
      return { ...result, applied: false }
    }

    const validationPatch = result.ok
      ? {
          lastValidatedAt: Date.now(),
          lastValidationFailure: undefined
        }
      : {
          lastValidatedAt: undefined,
          lastValidationFailure: {
            at: Date.now(),
            category: result.category,
            status: result.status,
            message: result.message
          }
        }

    if (stored.type === 'claude-shared') {
      if (storedValidationTarget?.type !== 'claude-shared') {
        return { ...result, applied: false }
      }
      const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
        storedValidationTarget,
        settings.claudeSubscriptionProviderId,
        resolved.provider.model,
        validationPatch
      )
      return { ...result, applied }
    }

    await this.repository.upsertProvider({ ...stored, ...validationPatch })
    return { ...result, applied: true }
  }

  private codexAuthValidationResult(
    status: CodexAuthStatus,
    isolatedFallback = 'Codex sign-in did not complete.'
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    return {
      ok: false,
      category: status.message?.toLowerCase().includes('timed out')
        ? 'timeout'
        : status.supported
          ? 'auth'
          : 'unknown',
      message:
        status.message ??
        (status.mode === 'shared'
          ? 'No existing Codex login was found. Run `codex login` or use the isolated Open Science login.'
          : isolatedFallback)
    }
  }

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

  resolveProviderApiEndpoints(provider: StoredProvider, activeModel?: string): ChatApiEndpoint[] {
    if (provider.type === 'official' && provider.vendorId) {
      const vendorEndpoints = resolveVendorApiEndpoints(provider.vendorId)
      const modelToCheck = activeModel ?? defaultVendorModel(provider.vendorId)
      if (
        !vendorEndpoints.includes('responses') &&
        isVendorModelResponsesSupported(provider.vendorId, modelToCheck)
      ) {
        return [...vendorEndpoints, 'responses']
      }
      return vendorEndpoints
    }

    return provider.apiEndpoints && provider.apiEndpoints.length > 0
      ? [...provider.apiEndpoints]
      : ['anthropic']
  }

  toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    const hasKey = Boolean(provider.keyRef)
    const needsKey = hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      type: provider.type,
      codexAuthMode: provider.codexAuthMode,
      name: provider.name,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, activeModel),
      baseUrl: provider.baseUrl,
      model: provider.model,
      contextWindow: provider.contextWindow,
      supportsImageInput: this.providerSupportsImageInput(provider, activeModel),
      reasoningEffortPreset:
        provider.type === 'custom' ? provider.reasoningEffortPreset : undefined,
      reasoningEffortTransport:
        provider.type === 'custom' ? provider.reasoningEffortTransport : undefined,
      vendorId: provider.vendorId,
      region: provider.region,
      models: this.availableModels(provider),
      maskedKey: provider.keyMask,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
      lastValidationFailure: provider.lastValidationFailure,
      ...(provider.expiresAt !== undefined ? { expiresAt: provider.expiresAt } : {})
    }
  }

  private providerSupportsImageInput(provider: StoredProvider, activeModel?: string): boolean {
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (isClaudeSubscriptionProvider(provider.type)) return true
    if (provider.type === 'custom') return provider.supportsImageInput === true
    if (provider.type === 'official' && provider.vendorId) {
      return isVendorModelMultimodal(
        provider.vendorId,
        activeModel ?? defaultVendorModel(provider.vendorId)
      )
    }
    return false
  }

  private invalidateClaudeSharedAuthStatus(): void {
    this.claudeSharedAuthStatusCache = undefined
    this.claudeSharedAuthStatusGeneration += 1
  }

  private async getClaudeSharedAuthStatus(): Promise<boolean> {
    const cached = this.claudeSharedAuthStatusCache
    if (cached && Date.now() - cached.checkedAt < CLAUDE_SHARED_AUTH_STATUS_TTL_MS) {
      return cached.authenticated
    }
    const generation = this.claudeSharedAuthStatusGeneration
    const pending = this.claudeSharedAuthStatusPromise
    if (pending?.generation === generation) return pending.promise

    const promise = this.claudeSharedAuth
      .getStatus()
      .then((status) => {
        if (this.claudeSharedAuthStatusGeneration === generation) {
          this.claudeSharedAuthStatusCache = {
            authenticated: status.authenticated,
            checkedAt: Date.now()
          }
        }
        return status.authenticated
      })
      .finally(() => {
        if (this.claudeSharedAuthStatusPromise?.promise === promise) {
          this.claudeSharedAuthStatusPromise = undefined
        }
      })

    this.claudeSharedAuthStatusPromise = { generation, promise }
    return promise
  }

  async isProviderKeyUsable(provider: StoredProvider): Promise<boolean> {
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (provider.type === 'claude-shared') {
      if (provider.disconnectedAt !== undefined) return false
      return this.getClaudeSharedAuthStatus()
    }

    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  private availableModels(provider: StoredProvider): string[] {
    if (isCodexSubscriptionProvider(provider.type)) {
      return getOfficialVendorModelIds('openai')
    }
    if (provider.type === 'official' && provider.vendorId) {
      if (provider.fetchedModels && provider.fetchedModels.length > 0) {
        return provider.fetchedModels
      }
      return getOfficialVendorModelIds(provider.vendorId)
    }
    return provider.model ? [provider.model] : []
  }

  resolveActiveModel(provider: StoredProvider | undefined, requested?: string): string | undefined {
    return resolveProviderEffectiveModel(
      provider ? { ...provider, models: this.availableModels(provider) } : undefined,
      requested
    )
  }

  // Produces the complete ephemeral provider input for one backend generation without mutating the
  // active selection, refreshing catalogs, or entering an authentication lifecycle. A configured
  // selection retains the historical fallback rules; an explicit required model must match exactly.
  resolveRuntimeTarget(
    storedProvider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
  ): ProviderRuntimeTarget {
    const availableModels = this.availableModels(storedProvider)
    if (
      selection.kind === 'required' &&
      availableModels.length > 0 &&
      !availableModels.includes(selection.model)
    ) {
      throw new Error(
        `The requested model "${selection.model}" is not available for provider "${storedProvider.name}".`
      )
    }

    const effectiveModel =
      selection.kind === 'required'
        ? this.resolveActiveModel(storedProvider, selection.model)
        : this.resolveActiveModel(
            storedProvider,
            selection.kind === 'configured' ? selection.requestedModel : undefined
          )

    if (selection.kind === 'required' && effectiveModel !== selection.model) {
      throw new Error(
        `The requested model "${selection.model}" is not available for provider "${storedProvider.name}".`
      )
    }

    const apiEndpoints = this.resolveProviderApiEndpoints(storedProvider, effectiveModel)
    const provider = this.resolveProvider(storedProvider, effectiveModel)

    return {
      providerId: storedProvider.id,
      providerType: storedProvider.type,
      ...(storedProvider.disconnectedAt === undefined
        ? {}
        : { disconnectedAt: storedProvider.disconnectedAt }),
      effectiveModel,
      apiEndpoints,
      provider,
      reasoningEffortProfile: resolveProviderReasoningEffortProfile(storedProvider, effectiveModel),
      frameworkCompatible: isProviderUsableByFramework(
        { apiEndpoints, type: storedProvider.type },
        framework
      ),
      modelBridgeSupported: isModelBridgeSupported(storedProvider, effectiveModel),
      needsChatResponsesBridge: requiresChatCompletionsBridge(provider, framework),
      needsNativeResponsesCompatibility: requiresNativeResponsesCompatibility(provider, framework)
    }
  }

  resolveRuntimeModelCatalog(
    storedProvider: StoredProvider,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
  ): ProviderRuntimeTarget[] {
    return this.availableModels(storedProvider).map((model) =>
      this.resolveRuntimeTarget(storedProvider, { kind: 'required', model }, framework)
    )
  }

  resolveRuntimeReasoningEffortProfile(
    storedProvider: StoredProvider,
    requestedModel?: string
  ): ReasoningEffortProfile {
    return resolveProviderReasoningEffortProfile(
      storedProvider,
      this.resolveActiveModel(storedProvider, requestedModel)
    )
  }

  resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    const key = provider.keyRef ? tryDecryptKey(provider.keyRef) : undefined
    if (provider.type === 'official' && provider.vendorId) {
      const model = modelOverride ?? defaultVendorModel(provider.vendorId)
      const contextWindow = resolveModelContextWindow(provider.vendorId, model)
      return {
        type: 'custom',
        vendorId: provider.vendorId,
        baseUrl: resolveVendorBaseUrl(provider.vendorId, provider.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(provider.vendorId, provider.region),
        model,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        key,
        apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
        supportsImageInput: this.providerSupportsImageInput(provider, modelOverride)
      }
    }

    const model = modelOverride ?? provider.model
    const contextWindow =
      provider.type === 'custom'
        ? resolveCustomModelContextWindow(provider.contextWindow)
        : isClaudeSubscriptionProvider(provider.type)
          ? resolveModelContextWindow('anthropic', model)
          : undefined
    return {
      type: provider.type,
      ...(provider.codexAuthMode === undefined ? {} : { codexAuthMode: provider.codexAuthMode }),
      baseUrl: provider.baseUrl,
      model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      key,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
      supportsImageInput: this.providerSupportsImageInput(provider, modelOverride),
      ...(provider.type === 'custom'
        ? { reasoningEffortTransport: provider.reasoningEffortTransport }
        : {})
    }
  }

  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
      const draftModel = draft.model ?? defaultVendorModel(draft.vendorId)
      const vendorEndpoints = resolveVendorApiEndpoints(draft.vendorId)
      const draftEndpoints: ChatApiEndpoint[] =
        !vendorEndpoints.includes('responses') &&
        isVendorModelResponsesSupported(draft.vendorId, draftModel)
          ? [...vendorEndpoints, 'responses']
          : vendorEndpoints
      return {
        type: 'custom',
        vendorId: draft.vendorId,
        baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(draft.vendorId, draft.region),
        model: draftModel,
        key: draft.key,
        apiEndpoints: draftEndpoints
      }
    }

    return {
      type: draft.type,
      baseUrl: draft.baseUrl,
      model: draft.model,
      ...(draft.type === 'custom'
        ? { contextWindow: resolveCustomModelContextWindow(draft.contextWindow ?? undefined) }
        : {}),
      key: draft.key,
      apiEndpoints: draft.apiEndpoints ?? ['anthropic'],
      ...(draft.type === 'custom'
        ? { reasoningEffortTransport: draft.reasoningEffortTransport }
        : {})
    }
  }

  private frameworkIncompatibilityResult(
    provider: ResolvedProvider,
    framework: ReturnType<typeof getAgentFramework>
  ): ValidateProviderResult | undefined {
    if (
      isProviderUsableByFramework(
        { apiEndpoints: provider.apiEndpoints, type: provider.type },
        framework
      )
    ) {
      return undefined
    }

    const routes: Record<ChatApiEndpoint, string> = {
      anthropic: '/v1/messages',
      openai: '/v1/chat/completions',
      responses: '/v1/responses'
    }
    const message =
      provider.type === 'claude-isolated'
        ? 'Carries an Anthropic OAuth token (setup-token) in app-owned storage, which only Claude Code can carry. Switch to Claude Code or pick another provider.'
        : `Not compatible with ${framework.displayName}: it needs ${framework.supportedApiTypes
            .map((endpoint) => routes[endpoint])
            .join(' or ')}, but this provider speaks ${providerEndpoints(provider)
            .map((endpoint) => routes[endpoint])
            .join(' or ')}. Change the API format or switch the agent framework.`

    return { ok: false, category: 'incompatible', message }
  }

  private resolveValidationTarget(
    request: ValidateProviderRequest,
    settings: StoredSettings
  ): { provider: ResolvedProvider; storedId?: string } | undefined {
    if (request.providerId) {
      const stored = settings.providers.find((provider) => provider.id === request.providerId)
      return stored
        ? {
            provider: this.resolveProvider(
              stored,
              settings.activeProviderId === stored.id ? settings.activeModel : undefined
            ),
            storedId: stored.id
          }
        : undefined
    }
    if (request.draft) return { provider: this.resolveDraft(request.draft) }
    return undefined
  }

  private sameValidationTarget(left: ResolvedProvider, right: ResolvedProvider): boolean {
    return (
      left.type === right.type &&
      left.codexAuthMode === right.codexAuthMode &&
      left.baseUrl === right.baseUrl &&
      left.openaiBaseUrl === right.openaiBaseUrl &&
      left.model === right.model &&
      left.key === right.key &&
      (left.apiEndpoints ?? []).join(',') === (right.apiEndpoints ?? []).join(',')
    )
  }

  private advanceProviderValidationGeneration(providerId: string): number {
    const generation = (this.providerValidationGenerations.get(providerId) ?? 0) + 1
    this.providerValidationGenerations.set(providerId, generation)
    return generation
  }

  private createProviderId(): string {
    return `p_${Date.now()}_${this.options.allocateSettingsIdSequence()}`
  }
}

export {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAccountsModule,
  requiresNativeResponsesCompatibility
}
export type { ProviderAccountsModuleOptions }
