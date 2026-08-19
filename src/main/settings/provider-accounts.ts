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
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  providerEndpoints,
  requiresChatCompletionsBridge
} from '../../shared/settings'
import {
  defaultVendorModel,
  isOfficialVendorId,
  isVendorModelResponsesSupported,
  resolveCustomModelContextWindow,
  resolveVendorApiEndpoints,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
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
import { classifyStatus, validateProvider as validateProviderTarget } from './validate'
import { listProviderModels } from './list-models'
import type { ResolvedProvider } from './provider-env'
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

// Owns durable provider records and every provider-specific validation/authentication lifecycle;
// executable installation, runtime spawn, live ACP reconnect, and transports remain outside.
class ProviderAccountsModule {
  private readonly repository: SettingsRepository
  private readonly runtimeProjection = new ProviderRuntimeProjectionOwner()
  private readonly auth: ProviderAuthLifecycleOwner
  private readonly providerValidationGenerations = new Map<string, number>()

  constructor(private readonly options: ProviderAccountsModuleOptions) {
    this.repository = options.repository
    this.auth = new ProviderAuthLifecycleOwner({
      ...options,
      resolveProvider: (provider, model) => this.runtimeProjection.resolveProvider(provider, model)
    })
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
          : undefined
    const requestedId = subscriptionIdentity?.id ?? request.id
    const existing = requestedId
      ? settings.providers.find((provider) => provider.id === requestedId)
      : undefined

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

    if (existing?.lastValidatedAt !== undefined && !credentialsChanged)
      provider.lastValidatedAt = existing.lastValidatedAt
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

  deleteProvider(id: string): Promise<void> {
    return this.auth.serializeAccountMutation(async () => {
      await this.auth.cleanupProviderBeforeDelete(id)
      await this.repository.deleteProvider(id)
    })
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
    return this.auth.logoutIsolatedCodex()
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

    const authResult = incompatibility
      ? undefined
      : await this.auth.validateProviderAuth(resolved.provider, settings, storedValidationTarget)
    const result =
      incompatibility ??
      authResult ??
      (await validateProviderTarget(resolved.provider, {
        fetchImpl: netFetchStandard,
        requireBridgeToolCall: requiresChatCompletionsBridge(resolved.provider, framework),
        requireNativeResponsesCompatibility: requiresNativeResponsesCompatibility(
          resolved.provider,
          framework
        ),
        frameworkEndpoints: framework.id === 'codex' ? undefined : framework.supportedApiTypes
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

    const result = await listProviderModels(
      {
        url: modelsUrl,
        key: this.resolveProvider(stored).key
      },
      { fetchImpl: netFetchStandard }
    )
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
    return this.runtimeProjection.resolveProviderApiEndpoints(provider, activeModel)
  }

  toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    return this.runtimeProjection.toProviderView(provider, activeModel)
  }

  async isProviderKeyUsable(provider: StoredProvider): Promise<boolean> {
    return this.auth.isProviderKeyUsable(provider)
  }

  resolveActiveModel(provider: StoredProvider | undefined, requested?: string): string | undefined {
    return this.runtimeProjection.resolveActiveModel(provider, requested)
  }

  // Produces an ephemeral backend input without mutating selection or entering authentication;
  // configured fallback rules remain, while an explicit required model must match exactly.
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
export type { ProviderAccountsModuleOptions, ProviderRuntimeTarget, RuntimeProviderModelSelection }
