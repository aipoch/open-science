import type {
  ChatApiEndpoint,
  ProviderDraft,
  ProviderDeletionScenarioModelHandling,
  ProviderView,
  ProviderValidationTarget,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult,
  XaiOAuthDeviceAuthorization
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  claudeIsolatedProviderIdentity,
  claudeSharedProviderIdentity,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  isXaiSubscriptionProvider,
  providerEndpoints,
  preferredEndpoint,
  requiresChatCompletionsBridge,
  xaiSubscriptionProviderIdentity
} from '../../shared/settings'
import { defaultVendorModel, isOfficialVendorId } from '../../shared/provider-registry'
import { getCustomProviderBaseUrlError } from '../../shared/provider-base-url'
import type { ReasoningEffortProfile } from '../../shared/reasoning-effort'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import { netFetchStandard } from '../skills/net-fetch'
import { type CodexAuthControllerPort } from './codex-auth'
import { type ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import { type ClaudeSharedAuthControllerPort } from './claude-shared-auth'
import { encryptKey, maskKey, tryDecryptKey } from './crypto'
import { validateProvider as validateProviderTarget } from './validate'
import type { ResolvedProvider } from './provider-env'
import { resolveCustomTokenLimits } from './provider-token-limits'
import { resolveProviderDraft } from './provider-draft-projection'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAuthLifecycleOwner
} from './provider-auth-lifecycle'
import {
  ProviderRuntimeProjectionOwner,
  requiresNativeResponsesCompatibility,
  type ProviderRuntimeTarget,
  type RuntimeProviderModelSelection
} from './provider-runtime-projection'
import type { SettingsRepository } from './repository'
import type { SystemProxyEnvironment } from './system-proxy'
import type { StoredProvider, StoredSettings } from './types'
import type { XaiOAuthControllerPort } from './xai-oauth'
import { XaiProviderAccountOwner } from './xai-provider-account-owner'
import { ProviderModelCatalogOwner } from './provider-model-catalog-owner'
import { assertProviderCapacity, assertProviderDraftLimits } from './provider-resource-limits'
import { assertProviderModelLimit } from './provider-resource-limits'
import {
  buildProviderValidationPatch,
  targetForValidationResult
} from './provider-validation-state'
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
  xaiOAuth?: XaiOAuthControllerPort
}
// Owns durable provider records and every provider-specific validation/authentication lifecycle;
// executable installation, runtime spawn, live ACP reconnect, and transports remain outside.
class ProviderAccountsModule {
  private readonly repository: SettingsRepository
  private readonly runtimeProjection = new ProviderRuntimeProjectionOwner()
  private readonly auth: ProviderAuthLifecycleOwner
  private readonly xai: XaiProviderAccountOwner
  private readonly modelCatalog: ProviderModelCatalogOwner
  private readonly providerValidationGenerations = new Map<string, number>()

  constructor(private readonly options: ProviderAccountsModuleOptions) {
    this.repository = options.repository
    this.auth = new ProviderAuthLifecycleOwner({
      ...options,
      resolveProvider: (provider, model) => this.runtimeProjection.resolveProvider(provider, model)
    })
    this.xai = new XaiProviderAccountOwner(
      this.repository,
      (operation) => this.auth.serializeAccountMutation(operation),
      options.xaiOAuth
    )
    this.modelCatalog = new ProviderModelCatalogOwner(
      this.repository,
      (provider) => this.resolveProvider(provider),
      () => this.xai.getAccessToken()
    )
  }

  async dispose(): Promise<void> {
    await Promise.all([this.auth.dispose(), Promise.resolve().then(() => this.xai.cancelLogin())])
  }

  // Keeps provider-before-Connector ordering in SettingsService's whole-settings migration path.
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
    return this.auth.serializeAccountMutation(() => this.upsertProviderNow(request))
  }
  private async upsertProviderNow(request: UpsertProviderRequest): Promise<void> {
    assertProviderDraftLimits(request)
    const settings = await this.repository.getSettings()
    if (
      request.requireExisting &&
      (!request.id || !settings.providers.some((provider) => provider.id === request.id))
    ) {
      throw new Error('Provider no longer exists.')
    }
    const subscriptionIdentity = isCodexSubscriptionProvider(request.type)
      ? codexSubscriptionProviderIdentity()
      : request.type === 'claude-isolated'
        ? claudeIsolatedProviderIdentity()
        : request.type === 'claude-shared'
          ? claudeSharedProviderIdentity()
          : request.type === 'xai-subscription'
            ? xaiSubscriptionProviderIdentity()
            : undefined
    const requestedId = subscriptionIdentity?.id ?? request.id
    const existing = requestedId
      ? settings.providers.find((provider) => provider.id === requestedId)
      : undefined
    assertProviderCapacity(settings.providers.length, existing !== undefined)
    const reimportCodexAuthentication =
      request.type === 'codex-shared' && request.reimportCodexAuthentication === true
    await this.auth.prepareCodexProviderUpsert(request, existing, () => {
      if (reimportCodexAuthentication && requestedId) {
        this.advanceProviderValidationGeneration(requestedId)
      }
    })

    const provider: StoredProvider = {
      id: subscriptionIdentity?.id ?? existing?.id ?? request.id ?? this.createProviderId(),
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
      provider.codexTransport = request.codexTransport ?? existing?.codexTransport ?? 'auto'
      if (
        provider.codexTransport === 'auto' &&
        (existing?.codexTransport ?? 'auto') === 'auto' &&
        existing?.codexAutoUseHttps !== undefined
      ) {
        provider.codexAutoUseHttps = existing.codexAutoUseHttps
      }
      credentialsChanged =
        existing !== undefined &&
        (existing.codexAuthMode !== provider.codexAuthMode || reimportCodexAuthentication)
    } else if (request.type === 'xai-subscription') {
      provider.apiEndpoints = ['anthropic', 'openai', 'responses']
      provider.model = request.model?.trim() || existing?.model || defaultVendorModel('xai')
      if (existing?.fetchedModels) provider.fetchedModels = existing.fetchedModels
      if (existing?.keyRef) provider.keyRef = existing.keyRef
      if (existing?.accountEmail) provider.accountEmail = existing.accountEmail
      credentialsChanged = provider.model !== existing?.model
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
      const tokenLimits = resolveCustomTokenLimits(request, existing)
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      const baseUrlError = getCustomProviderBaseUrlError(baseUrl)
      if (baseUrlError) throw new Error(baseUrlError)
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!carryKey()) throw new Error('API key is required for a custom provider.')
      provider.baseUrl = baseUrl
      provider.model = model
      Object.assign(provider, tokenLimits)
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

    if (existing?.lastValidatedAt !== undefined && !credentialsChanged)
      provider.lastValidatedAt = existing.lastValidatedAt
    if (existing?.lastValidatedTarget !== undefined && !credentialsChanged)
      provider.lastValidatedTarget = existing.lastValidatedTarget
    const preserveValidationFailure =
      !credentialsChanged ||
      (provider.type === 'claude-shared' && provider.disconnectedAt !== undefined)
    if (existing?.lastValidationFailure !== undefined && preserveValidationFailure)
      provider.lastValidationFailure = existing.lastValidationFailure

    const editId = request.requireExisting ? request.id : undefined
    if (isClaudeSubscriptionProvider(provider.type)) {
      const outgoingId =
        provider.type === 'claude-shared' ? CLAUDE_ISOLATED_PROVIDER_ID : CLAUDE_SHARED_PROVIDER_ID
      const collapsedCardWasActive =
        settings.activeProviderId === provider.id || settings.activeProviderId === outgoingId
      await this.repository.upsertProvider(provider, editId)
      if (collapsedCardWasActive) {
        await this.repository.setActiveProvider(provider.id, this.resolveActiveModel(provider))
      }
      return
    }

    await this.repository.upsertProvider(provider, editId)
  }

  async deleteProvider(
    id: string,
    scenarioModelHandling?: ProviderDeletionScenarioModelHandling
  ): Promise<void> {
    const settings = await this.repository.getSettings()
    if (settings.providers.some((provider) => provider.id === id && isXaiRecord(provider))) {
      await this.xai.logout()
    }

    await this.auth.serializeAccountMutation(async () => {
      await this.auth.cleanupProviderBeforeDelete(id)
      await this.repository.deleteProvider(id, scenarioModelHandling)
    })
  }

  beginXaiOAuthLogin(): Promise<XaiOAuthDeviceAuthorization> {
    return this.xai.beginLogin()
  }

  waitXaiOAuthLogin(): Promise<{ accountEmail?: string }> {
    return this.xai.waitForLogin()
  }

  cancelXaiOAuthLogin(): void {
    this.xai.cancelLogin()
  }

  async logoutXaiOAuth(): Promise<void> {
    this.advanceProviderValidationGeneration(XAI_SUBSCRIPTION_PROVIDER_ID)
    await this.xai.logout()
  }

  getXaiOAuthAccessToken(forceRefresh = false): Promise<string> {
    return this.xai.getAccessToken(forceRefresh)
  }

  cancelCodexLogin(): void {
    this.auth.cancelCodexLogin()
  }

  cancelClaudeLogin(): void {
    this.auth.cancelClaudeLogin()
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedCodex()
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.auth.serializeAccountMutation(() => this.auth.logoutIsolatedCodex())
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedClaude(token)
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedClaudeBrowser()
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    return this.auth.cancelClaudeIsolatedLogin()
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    return this.auth.logoutIsolatedClaude()
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    return this.auth.loginClaudeShared()
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    return this.auth.logoutClaudeShared()
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    return this.auth.getClaudeSharedStatus()
  }

  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    return this.auth.getClaudeIsolatedStatus()
  }
  async setActiveProvider(id: string, model?: string): Promise<void> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find((candidate) => candidate.id === id)
    await this.repository.setActiveProvider(id, this.resolveActiveModel(provider, model))
  }
  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    if (request.draft) {
      assertProviderDraftLimits(request.draft)
      if (request.draft.type === 'custom' && request.draft.baseUrl?.trim()) {
        const baseUrlError = getCustomProviderBaseUrlError(request.draft.baseUrl.trim())
        if (baseUrlError) throw new Error(baseUrlError)
      }
    }
    assertProviderModelLimit(request.model)
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

    let xaiAuthResult: ValidateProviderResult | undefined
    let validationProvider = resolved.provider
    if (storedValidationTarget && isXaiSubscriptionProvider(storedValidationTarget.type)) {
      try {
        validationProvider = {
          ...resolved.provider,
          key: await this.xai.getAccessToken(),
          apiEndpoints: ['responses']
        }
      } catch (error) {
        xaiAuthResult = {
          ok: false,
          category: 'auth',
          message: error instanceof Error ? error.message : 'xAI sign-in is unavailable.'
        }
      }
    }
    const authResult =
      incompatibility || xaiAuthResult
        ? undefined
        : await this.auth.validateProviderAuth(resolved.provider, settings, storedValidationTarget)
    const usesCompatibilityTransport = requiresChatCompletionsBridge(resolved.provider, framework)
    const validationFrameworkEndpoints = isXaiSubscriptionProvider(resolved.provider.type)
      ? (['responses'] as const)
      : framework.id === 'codebuddy' && usesCompatibilityTransport
        ? providerEndpoints(resolved.provider)
        : framework.id === 'codex'
          ? undefined
          : framework.supportedApiTypes
    const result =
      incompatibility ??
      xaiAuthResult ??
      authResult ??
      (await validateProviderTarget(validationProvider, {
        fetchImpl: netFetchStandard,
        requireBridgeToolCall: framework.id === 'codex' && usesCompatibilityTransport,
        requireNativeResponsesCompatibility:
          !isXaiSubscriptionProvider(resolved.provider.type) &&
          requiresNativeResponsesCompatibility(resolved.provider, framework),
        frameworkEndpoints: validationFrameworkEndpoints
      }))

    if (!resolved.storedId) return result
    if (this.providerValidationGenerations.get(resolved.storedId) !== validationGeneration) {
      return { ...result, applied: false }
    }

    const latestSettings = await this.repository.getSettings()
    const stored = latestSettings.providers.find((provider) => provider.id === resolved.storedId)
    if (!stored) return { ...result, applied: false }
    const model =
      request.model ??
      (latestSettings.activeProviderId === stored.id ? latestSettings.activeModel : undefined)
    const latestResolved = this.resolveProvider(stored, model)
    if (!this.sameValidationTarget(resolved.provider, latestResolved)) {
      return { ...result, applied: false }
    }

    const validationTarget: ProviderValidationTarget | undefined =
      isCodexSubscriptionProvider(resolved.provider.type) ||
      resolved.provider.type === 'claude-isolated'
        ? undefined
        : targetForValidationResult(result, {
            model: resolved.provider.model,
            endpoint: preferredEndpoint(
              resolved.provider.apiEndpoints ?? ['anthropic'],
              validationFrameworkEndpoints ?? ['anthropic', 'openai', 'responses']
            )
          })
    const validationPatch = buildProviderValidationPatch(stored, result, validationTarget)

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

  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    return this.modelCatalog.refresh(request)
  }

  resolveProviderApiEndpoints(provider: StoredProvider, activeModel?: string): ChatApiEndpoint[] {
    return this.runtimeProjection.resolveProviderApiEndpoints(provider, activeModel)
  }

  toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    return this.runtimeProjection.toProviderView(provider, activeModel)
  }

  async isProviderKeyUsable(provider: StoredProvider): Promise<boolean> {
    if (isXaiSubscriptionProvider(provider.type)) return this.xai.isUsable()
    return this.auth.isProviderKeyUsable(provider)
  }

  resolveActiveModel(provider: StoredProvider | undefined, requested?: string): string | undefined {
    return this.runtimeProjection.resolveActiveModel(provider, requested)
  }

  // Produces an ephemeral backend input without mutating selection or entering authentication;
  // a persisted or explicitly required model must still exist in the current catalog.
  resolveRuntimeTarget(
    storedProvider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
  ): ProviderRuntimeTarget {
    return this.runtimeProjection.resolveRuntimeTarget(storedProvider, selection, framework)
  }

  resolveRuntimeModelCatalog(
    storedProvider: StoredProvider,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
  ): ProviderRuntimeTarget[] {
    return this.runtimeProjection.resolveRuntimeModelCatalog(storedProvider, framework)
  }

  resolveRuntimeReasoningEffortProfile(
    storedProvider: StoredProvider,
    requestedModel?: string
  ): ReasoningEffortProfile {
    return this.runtimeProjection.resolveRuntimeReasoningEffortProfile(
      storedProvider,
      requestedModel
    )
  }

  resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    return this.runtimeProjection.resolveProvider(provider, modelOverride)
  }

  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    return resolveProviderDraft(draft)
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
      const model =
        request.model ??
        (settings.activeProviderId === stored?.id ? settings.activeModel : undefined)
      return stored
        ? {
            provider: this.resolveProvider(stored, model),
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
      left.codexTransport === right.codexTransport &&
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

const isXaiRecord = (provider: StoredProvider): boolean => isXaiSubscriptionProvider(provider.type)

export {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAccountsModule,
  requiresNativeResponsesCompatibility
}
export type { ProviderAccountsModuleOptions, ProviderRuntimeTarget, RuntimeProviderModelSelection }
