import type { ChatApiEndpoint, ProviderView } from '../../shared/settings'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isXaiSubscriptionProvider,
  isProviderUsableByFramework,
  providerEndpoints,
  requiresChatCompletionsBridge
} from '../../shared/settings'
import {
  defaultVendorModel,
  getOfficialVendorModelIds,
  isModelBridgeSupported,
  isVendorModelMultimodal,
  resolveCustomModelContextWindow,
  resolveModelContextWindow,
  resolveVendorBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../shared/provider-reasoning-effort'
import type { ReasoningEffortProfile } from '../../shared/reasoning-effort'
import type { AgentFrameworkId } from '../agent-framework'
import { isOfficialOpenAiResponsesBase } from '../agent-framework/codex'
import { hardenKeyMask, tryDecryptKey } from './crypto'
import type { ResolvedProvider } from './provider-env'
import type { StoredProvider } from './types'

type RuntimeProviderModelSelection =
  | { kind: 'configured'; requestedModel?: string }
  | { kind: 'required'; model: string }
  | { kind: 'provider-default' }

type ProviderRuntimeTarget = {
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

// Owns secret-aware provider projection inside main. It derives views, catalogs, effective models,
// and ephemeral runtime targets without mutating durable selection or entering account lifecycles.
class ProviderRuntimeProjectionOwner {
  resolveProviderApiEndpoints(provider: StoredProvider, activeModel?: string): ChatApiEndpoint[] {
    if (isXaiSubscriptionProvider(provider.type)) return ['anthropic', 'openai', 'responses']
    if (provider.type === 'official' && provider.vendorId) {
      return resolveVendorModelApiEndpoints(
        provider.vendorId,
        activeModel ?? defaultVendorModel(provider.vendorId)
      )
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
      models: this.availableModels(provider),
      maskedKey: hardenKeyMask(provider.keyMask),
      accountEmail: provider.accountEmail,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
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
        openaiBaseUrl: resolveVendorOpenAiBaseUrl('xai'),
        model,
        contextWindow: resolveModelContextWindow('xai', model),
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        supportsImageInput: isVendorModelMultimodal('xai', model)
      }
    }
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

  private providerSupportsImageInput(provider: StoredProvider, activeModel?: string): boolean {
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (isClaudeSubscriptionProvider(provider.type)) return true
    if (isXaiSubscriptionProvider(provider.type)) return true
    if (provider.type === 'custom') return provider.supportsImageInput === true
    if (provider.type === 'official' && provider.vendorId) {
      return isVendorModelMultimodal(
        provider.vendorId,
        activeModel ?? defaultVendorModel(provider.vendorId)
      )
    }
    return false
  }

  private availableModels(provider: StoredProvider): string[] {
    if (isCodexSubscriptionProvider(provider.type)) {
      return getOfficialVendorModelIds('openai')
    }
    if (isXaiSubscriptionProvider(provider.type)) {
      return provider.fetchedModels?.length
        ? provider.fetchedModels
        : getOfficialVendorModelIds('xai')
    }
    if (provider.type === 'official' && provider.vendorId) {
      if (provider.fetchedModels && provider.fetchedModels.length > 0) {
        return provider.fetchedModels
      }
      return getOfficialVendorModelIds(provider.vendorId)
    }
    return provider.model ? [provider.model] : []
  }
}

export { ProviderRuntimeProjectionOwner, requiresNativeResponsesCompatibility }
export type { ProviderRuntimeTarget, RuntimeProviderModelSelection }
