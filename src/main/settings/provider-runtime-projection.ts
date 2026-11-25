import { codeBuddyBaseModels, codeBuddySiteForId } from '../../shared/codebuddy-subscription'
import {
  catalogModelApiEndpoints,
  resolveOfficialModelCatalog,
  isCatalogModelAvailable,
  usesBundledModelCatalog
} from '../../shared/provider-model-catalog'
import {
  type ModelProtocol,
  type CatalogModel,
  type OfficialVendorId,
  getOfficialVendor,
  isVendorModelMultimodal,
  resolveVendorBaseUrl,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorApiEndpoints
} from '@aipoch/providers'
import {
  defaultVendorModel,
  getOfficialVendorModelIds,
  resolveCustomModelContextWindow,
  resolveModelContextWindow
} from '../../shared/provider-model-policy'
import {
  getCustomProviderBaseUrlError,
  kiloModelSupportsAnonymousAccess
} from '../../shared/provider-url-policy'
import { labModelWireId, readLabModelCapabilities } from '../../shared/lab'
import { isModelBridgeSupported } from '../../shared/provider-bridge-policy'
import {
  reasoningProfileFromCapability,
  type ReasoningEffortProfile
} from '../../shared/reasoning-effort'

import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../shared/provider-reasoning-effort'

import { buildConfiguredModelUnavailableMessage } from '../../shared/failure/messages'
import type { ProviderView } from '../../shared/settings'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  isLabProvider,
  isXaiSubscriptionProvider,
  providerEndpoints,
  requiresChatCompletionsBridge
} from '../../shared/settings-runtime'
import type { AgentFrameworkId } from '../agent-framework'
import { isModelStreamingCompatible } from '../../shared/agent-framework-id'
import { isOfficialOpenAiResponsesBase } from '../agent-framework/codex'
import { hardenKeyMask, tryDecryptKey } from './crypto'
import type { ResolvedProvider } from './provider-env'

import type { StoredProvider } from './types'

type RuntimeProviderModelSelection =
  | { kind: 'configured'; requestedModel?: string }
  | { kind: 'required'; model: string }
  | { kind: 'provider-default' }

type ProviderRuntimeTarget = {
  configRevision?: number
  providerId: string
  providerName?: string
  providerType: StoredProvider['type']
  disconnectedAt?: number
  effectiveModel?: string
  apiEndpoints: ModelProtocol[]
  provider: ResolvedProvider
  reasoningEffortProfile: ReasoningEffortProfile
  frameworkCompatible: boolean
  modelBridgeSupported: boolean
  needsChatResponsesToChatCompletionsBridge: boolean
  needsNativeResponsesCompatibility: boolean
}

// Native Responses vendors other than OpenAI require the same namespace compatibility proxy during
// validation and runtime. Export one predicate so both paths prove the same protocol contract.
const requiresNativeResponsesCompatibility = (
  provider: ResolvedProvider,
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
): boolean =>
  framework.id === 'codex' &&
  framework.supportedApiTypes.includes('responses') &&
  providerEndpoints(provider).includes('responses') &&
  !isCodexSubscriptionProvider(provider.type) &&
  provider.vendorId !== 'openai' &&
  !isOfficialOpenAiResponsesBase(provider.chatCompletionsBaseUrl ?? provider.baseUrl)

// Owns secret-aware provider projection inside main. It derives views, catalogs, effective models,
// and ephemeral runtime targets without mutating durable selection or entering account lifecycles.
class ProviderRuntimeProjectionOwner {
  resolveProviderApiEndpoints(provider: StoredProvider, activeModel?: string): ModelProtocol[] {
    if (isCodexSubscriptionProvider(provider.type)) return ['responses']
    if (isXaiSubscriptionProvider(provider.type))
      return ['messages', 'chat-completions', 'responses']
    if (isLabProvider(provider.type)) {
      return providerEndpoints(
        provider,
        activeModel ?? provider.model ?? provider.fetchedModels?.[0]
      )
    }
    if (provider.type === 'official' && provider.vendorId) {
      const catalog = resolveOfficialModelCatalog(provider)
      const model = activeModel
        ? catalog.find((entry) => entry.id === activeModel)
        : catalog.find(isCatalogModelAvailable)
      if (model || provider.modelCatalog) return catalogModelApiEndpoints(model)
      return resolveVendorApiEndpoints(provider.vendorId)
    }

    return provider.apiEndpoints && provider.apiEndpoints.length > 0
      ? [...provider.apiEndpoints]
      : ['messages']
  }

  toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    const bundled = usesBundledModelCatalog(provider.vendorId)
    const hasKey = Boolean(provider.keyRef)
    const needsKey = hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      configRevision: provider.configRevision,
      type: provider.type,
      ...(provider.codeBuddyAuthMode && { codeBuddyAuthMode: provider.codeBuddyAuthMode }),
      codexAuthMode: provider.codexAuthMode,
      codexTransport: provider.codexTransport,
      name: provider.name,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, activeModel),
      baseUrl: provider.baseUrl,
      model: provider.model,
      contextWindow: provider.contextWindow,
      maxInputTokens: provider.maxInputTokens,
      maxOutputTokens: provider.maxOutputTokens,
      supportsImageInput: this.providerSupportsImageInput(provider, activeModel),
      reasoningEffortPreset:
        provider.type === 'custom' ? provider.reasoningEffortPreset : undefined,
      reasoningEffortTransport:
        provider.type === 'custom' ? provider.reasoningEffortTransport : undefined,
      vendorId: provider.vendorId,
      region: provider.region,
      models: this.availableModels(
        needsKey && provider.vendorId === 'kilo' ? { ...provider, keyRef: undefined } : provider
      ),
      modelCatalog: bundled ? undefined : provider.modelCatalog,
      modelCatalogStatus: bundled ? undefined : provider.modelCatalogStatus,
      catalogParameters: provider.catalogParameters,
      ...(provider.modelProtocols ? { modelProtocols: provider.modelProtocols } : {}),
      ...(provider.labServerUrl ? { labServerUrl: provider.labServerUrl } : {}),
      ...(provider.modelCapabilities ? { modelCapabilities: provider.modelCapabilities } : {}),
      ...(provider.modelReasoningEfforts
        ? { modelReasoningEfforts: provider.modelReasoningEfforts }
        : {}),
      ...(provider.modelStreaming ? { modelStreaming: provider.modelStreaming } : {}),
      maskedKey: hardenKeyMask(provider.keyMask),
      accountEmail: provider.accountEmail,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
      lastValidatedTarget: provider.lastValidatedTarget,
      // A legacy 'incompatible' verdict is a derivable (provider, framework) relationship, not
      // endpoint health; validation no longer records it, and providerValidationFailed ignores
      // stored copies — the single seam every reader of this field goes through.
      lastValidationFailure: provider.lastValidationFailure,
      ...(provider.expiresAt !== undefined ? { expiresAt: provider.expiresAt } : {})
    }
  }

  resolveActiveModel(provider: StoredProvider | undefined, requested?: string): string | undefined {
    return resolveProviderEffectiveModel(
      provider ? { ...provider, models: this.availableModels(provider) } : undefined,
      requested
    )
  }

  resolveRuntimeTarget(
    storedProvider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
  ): ProviderRuntimeTarget {
    // Native Codex owns an omitted default; the built-in Agent must pin its model before launch.
    const modelSelection =
      framework.id === 'open-science-agent' &&
      isCodexSubscriptionProvider(storedProvider.type) &&
      selection.kind !== 'required' &&
      (selection.kind !== 'configured' || !selection.requestedModel)
        ? {
            kind: 'configured' as const,
            requestedModel: storedProvider.model ?? defaultVendorModel('openai')
          }
        : selection
    const target = this.resolveProviderTarget(storedProvider, modelSelection)
    return this.withFramework(target, framework)
  }

  private withFramework(
    target: ProviderRuntimeTarget,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
  ): ProviderRuntimeTarget {
    if (!isModelStreamingCompatible(framework.id, target.provider.streaming)) {
      throw new Error(`The model "${target.effectiveModel}" does not support streaming.`)
    }
    return {
      ...target,
      frameworkCompatible: isProviderUsableByFramework(
        { apiEndpoints: target.apiEndpoints, type: target.providerType },
        framework
      ),
      needsChatResponsesToChatCompletionsBridge: requiresChatCompletionsBridge(
        target.provider,
        framework
      ),
      needsNativeResponsesCompatibility: requiresNativeResponsesCompatibility(
        target.provider,
        framework
      )
    }
  }

  resolveProviderTarget(
    storedProvider: StoredProvider,
    selection: RuntimeProviderModelSelection
  ): ProviderRuntimeTarget {
    const availableModels = this.availableModels(storedProvider)
    // Preserve pinned IDs for history; reject continuation rather than silently selecting another model.
    const pinned =
      selection.kind === 'required'
        ? selection.model
        : selection.kind === 'configured'
          ? (selection.requestedModel ?? storedProvider.model)
          : undefined
    if (
      (storedProvider.modelCatalog && pinned && !availableModels.includes(pinned)) ||
      (storedProvider.type === 'lab' && availableModels.length === 0)
    ) {
      throw new Error(
        buildConfiguredModelUnavailableMessage(pinned ?? storedProvider.name, storedProvider.name)
      )
    }
    if (
      selection.kind === 'configured' &&
      selection.requestedModel &&
      availableModels.length > 0 &&
      !availableModels.includes(selection.requestedModel)
    ) {
      throw new Error(
        buildConfiguredModelUnavailableMessage(selection.requestedModel, storedProvider.name)
      )
    }
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

    const provider = this.resolveProvider(storedProvider, effectiveModel)

    return this.providerTarget(
      storedProvider,
      effectiveModel,
      provider,
      resolveProviderReasoningEffortProfile(storedProvider, effectiveModel)
    )
  }

  private providerTarget(
    storedProvider: StoredProvider,
    effectiveModel: string | undefined,
    provider: ResolvedProvider,
    reasoningEffortProfile: ReasoningEffortProfile
  ): ProviderRuntimeTarget {
    return {
      providerId: storedProvider.id,
      providerName: storedProvider.name,
      configRevision: storedProvider.configRevision ?? 0,
      providerType: storedProvider.type,
      ...(storedProvider.disconnectedAt === undefined
        ? {}
        : { disconnectedAt: storedProvider.disconnectedAt }),
      effectiveModel,
      apiEndpoints: [...(provider.apiEndpoints ?? [])],
      provider,
      reasoningEffortProfile,
      frameworkCompatible: false,
      modelBridgeSupported: isModelBridgeSupported(storedProvider, effectiveModel),
      needsChatResponsesToChatCompletionsBridge: false,
      needsNativeResponsesCompatibility: false
    }
  }

  resolveRuntimeModelCatalog(
    storedProvider: StoredProvider,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
  ): ProviderRuntimeTarget[] {
    const { vendorId } = storedProvider
    if (storedProvider.type === 'official' && vendorId) {
      const key = storedProvider.keyRef ? tryDecryptKey(storedProvider.keyRef) : undefined
      return resolveOfficialModelCatalog({ ...storedProvider, hasKey: Boolean(key) })
        .filter(isCatalogModelAvailable)
        .map((descriptor) => {
          const provider = this.officialProvider(
            storedProvider,
            vendorId,
            descriptor.id,
            descriptor,
            key
          )
          const effort = descriptor.reasoningEffort
            ? reasoningProfileFromCapability(descriptor.reasoningEffort)
            : ({ supported: false } as const)
          return this.withFramework(
            this.providerTarget(storedProvider, descriptor.id, provider, effort),
            framework
          )
        })
    }
    return this.availableModels(storedProvider)
      .filter((model) =>
        isModelStreamingCompatible(framework.id, storedProvider.modelStreaming?.[model])
      )
      .map((model) =>
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
    if (provider.type === 'codebuddy-subscription') {
      const codeBuddySite = codeBuddySiteForId(provider.id)
      if (!codeBuddySite) throw new Error('Invalid CodeBuddy provider ID.')
      return {
        type: provider.type,
        codeBuddySite,
        ...(provider.codeBuddyAuthMode && { codeBuddyAuthMode: provider.codeBuddyAuthMode }),
        model: modelOverride ?? provider.model,
        apiEndpoints: ['chat-completions']
      }
    }
    if (provider.type === 'custom' && provider.baseUrl) {
      const error = getCustomProviderBaseUrlError(provider.baseUrl)
      if (error) throw new Error(error)
    }
    const key =
      provider.type === 'xai-subscription'
        ? undefined
        : provider.keyRef
          ? tryDecryptKey(provider.keyRef)
          : undefined
    if (isXaiSubscriptionProvider(provider.type)) {
      const model = modelOverride ?? provider.model ?? defaultVendorModel('xai')
      return {
        type: provider.type,
        vendorId: 'xai',
        baseUrl: resolveVendorBaseUrl('xai'),
        chatCompletionsBaseUrl: resolveVendorChatCompletionsBaseUrl('xai'),
        model,
        contextWindow: resolveModelContextWindow('xai', model),
        apiEndpoints: ['messages', 'chat-completions', 'responses'],
        supportsImageInput: isVendorModelMultimodal('xai', model)
      }
    }
    if (isLabProvider(provider.type)) {
      const model = modelOverride ?? provider.model ?? provider.fetchedModels?.[0]
      if (!provider.baseUrl) throw new Error('The Lab provider has no server address.')
      const capabilities = readLabModelCapabilities(provider.modelCapabilities?.[model ?? ''])
      return {
        type: 'lab',
        baseUrl: provider.baseUrl,
        ...(provider.labServerUrl ? { labServerUrl: provider.labServerUrl } : {}),
        ...(model ? { model: labModelWireId(model) } : {}),
        ...(capabilities?.contextWindow !== undefined
          ? { contextWindow: capabilities.contextWindow }
          : {}),
        ...(capabilities?.maxOutputTokens !== undefined
          ? { maxOutputTokens: capabilities.maxOutputTokens }
          : {}),
        apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
        supportsImageInput: capabilities?.inputModalities.includes('image') ?? false,
        ...(provider.modelStreaming?.[model ?? ''] === false ? { streaming: false } : {})
      }
    }
    if (provider.type === 'official' && provider.vendorId) {
      const model =
        modelOverride ??
        (provider.vendorId === 'kilo' && !key
          ? this.resolveActiveModel({ ...provider, keyRef: undefined })
          : (provider.model ?? this.availableModels(provider)[0]))
      const descriptor = resolveOfficialModelCatalog({ ...provider, hasKey: Boolean(key) }).find(
        (entry) => entry.id === model
      )
      return this.officialProvider(provider, provider.vendorId, model, descriptor, key)
    }

    const model = modelOverride ?? provider.model
    // Hand-entered Claude subscription overrides retain their engine-specific context syntax.
    const contextWindow =
      provider.type === 'custom'
        ? resolveCustomModelContextWindow(provider.contextWindow)
        : isClaudeSubscriptionProvider(provider.type)
          ? /\[1m\]$/i.test(model ?? '')
            ? 1_000_000
            : resolveModelContextWindow('anthropic', model)
          : isCodexSubscriptionProvider(provider.type)
            ? getOfficialVendor('openai')?.models.find((entry) => entry.id === model)?.contextWindow
            : undefined
    return {
      type: provider.type,
      ...(provider.codexAuthMode === undefined ? {} : { codexAuthMode: provider.codexAuthMode }),
      ...(provider.codexTransport === undefined ? {} : { codexTransport: provider.codexTransport }),
      ...(provider.codexAutoUseHttps === undefined
        ? {}
        : { codexAutoUseHttps: provider.codexAutoUseHttps }),
      baseUrl: provider.baseUrl,
      model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(provider.type === 'custom' && provider.maxInputTokens !== undefined
        ? { maxInputTokens: provider.maxInputTokens }
        : {}),
      ...(provider.type === 'custom' && provider.maxOutputTokens !== undefined
        ? { maxOutputTokens: provider.maxOutputTokens }
        : {}),
      key,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
      supportsImageInput: this.providerSupportsImageInput(provider, modelOverride),
      ...(provider.type === 'custom'
        ? { reasoningEffortTransport: provider.reasoningEffortTransport }
        : {})
    }
  }

  private officialProvider(
    provider: StoredProvider,
    vendorId: OfficialVendorId,
    model: string | undefined,
    descriptor: CatalogModel | undefined,
    key: string | undefined
  ): ResolvedProvider {
    const contextWindow = descriptor?.contextWindow
    const routes = descriptor?.routes
    const modelAllowsAnonymousAccess =
      vendorId === 'kilo'
        ? Boolean(
            descriptor &&
            isCatalogModelAvailable(descriptor) &&
            kiloModelSupportsAnonymousAccess(descriptor)
          )
        : undefined
    if (!key && modelAllowsAnonymousAccess === false) {
      if (model) throw new Error('API key is required for an official provider.')
      return { type: 'custom', vendorId, apiEndpoints: [], modelAllowsAnonymousAccess }
    }
    return {
      type: 'custom',
      vendorId: vendorId,
      baseUrl: routes?.messages ?? resolveVendorBaseUrl(vendorId, provider.region),
      chatCompletionsBaseUrl:
        routes?.['chat-completions'] ??
        resolveVendorChatCompletionsBaseUrl(vendorId, provider.region),
      responsesBaseUrl:
        routes?.responses ?? resolveVendorResponsesBaseUrl(vendorId, provider.region),
      maxInputTokens: descriptor?.maxInputTokens,
      maxOutputTokens: descriptor?.maxOutputTokens,
      model,
      ...(modelAllowsAnonymousAccess !== undefined && { modelAllowsAnonymousAccess }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      key,
      apiEndpoints:
        descriptor || provider.modelCatalog
          ? catalogModelApiEndpoints(descriptor)
          : resolveVendorApiEndpoints(vendorId),
      supportsImageInput: descriptor?.supportsImageInput === true
    }
  }

  private providerSupportsImageInput(provider: StoredProvider, activeModel?: string): boolean {
    if (isLabProvider(provider.type)) {
      // Lab has a heterogeneous catalog; without a selected model there is no single image
      // capability to advertise. Do not guess from the first catalog entry.
      return activeModel
        ? (readLabModelCapabilities(
            provider.modelCapabilities?.[activeModel]
          )?.inputModalities.includes('image') ?? false)
        : false
    }
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (isClaudeSubscriptionProvider(provider.type)) return true
    if (isXaiSubscriptionProvider(provider.type)) return true
    if (provider.type === 'custom') return provider.supportsImageInput === true
    if (provider.type === 'official' && provider.vendorId) {
      const catalog = resolveOfficialModelCatalog(provider)
      const model =
        activeModel === undefined
          ? catalog.find(isCatalogModelAvailable)
          : catalog.find((entry) => entry.id === activeModel)
      return model?.supportsImageInput === true
    }
    return false
  }

  private availableModels(provider: StoredProvider): string[] {
    if (provider.type === 'codebuddy-subscription') {
      if (provider.fetchedModels?.length) return provider.fetchedModels
      const site = codeBuddySiteForId(provider.id)
      const base = site ? codeBuddyBaseModels[site] : []
      // Older records may have only the account's current model.
      return provider.model ? [...new Set([provider.model, ...base])] : [...base]
    }
    if (isCodexSubscriptionProvider(provider.type)) {
      return getOfficialVendorModelIds('openai')
    }
    if (isXaiSubscriptionProvider(provider.type)) {
      return provider.fetchedModels?.length
        ? provider.fetchedModels
        : getOfficialVendorModelIds('xai')
    }
    if (isLabProvider(provider.type))
      return provider.fetchedModels ? [...provider.fetchedModels] : []
    if (provider.type === 'official' && provider.vendorId) {
      return resolveOfficialModelCatalog(provider)
        .filter(isCatalogModelAvailable)
        .map((entry) => entry.id)
    }
    return provider.model ? [provider.model] : []
  }
}

export { ProviderRuntimeProjectionOwner, requiresNativeResponsesCompatibility }
export type { ProviderRuntimeTarget, RuntimeProviderModelSelection }
