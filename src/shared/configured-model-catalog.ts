import {
  isModelBridgeSupported,
  isVendorModelMultimodal,
  resolveVendorModelApiEndpoints
} from './provider-registry'
import type { OfficialVendorId } from './provider-registry'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  isXaiSubscriptionProvider,
  providerEndpoints,
  providerValidationFailed,
  selectClaudeSubscriptionProvider,
  type AgentFrameworkId,
  type ChatApiEndpoint,
  type ClaudeSubscriptionProviderId,
  type ProviderType,
  type ProviderView
} from './settings'

export type ConfiguredModelCatalogEntry = Readonly<{
  key: string
  providerId: string
  providerName: string
  providerType: ProviderType
  vendorId?: OfficialVendorId
  model: string
  label: string
  selectable: boolean
  supportsImageInput: boolean
  unavailableReason?: 'framework-incompatible' | 'model-bridge-unsupported'
}>

export type ConfiguredModelInventoryEntry = Readonly<
  Omit<ConfiguredModelCatalogEntry, 'selectable' | 'unavailableReason'>
>

export const configuredModelKey = (providerId: string, model: string): string =>
  JSON.stringify([providerId, model])

export const parseConfiguredModelKey = (
  key: string
): Readonly<{ providerId: string; model: string }> | undefined => {
  try {
    const value: unknown = JSON.parse(key)
    return Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === 'string')
      ? { providerId: value[0], model: value[1] }
      : undefined
  } catch {
    return undefined
  }
}

export const configuredModelApiEndpoints = (
  provider: Pick<ProviderView, 'type' | 'vendorId' | 'apiEndpoints'>,
  model: string
): readonly ChatApiEndpoint[] =>
  provider.type === 'official' && provider.vendorId
    ? resolveVendorModelApiEndpoints(provider.vendorId, model)
    : providerEndpoints(provider)

export const buildConfiguredModelInventory = (
  input: Readonly<{
    providers: readonly ProviderView[]
    activeProviderId?: string
    claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
    includeAllClaudeSubscriptions?: boolean
  }>
): readonly ConfiguredModelInventoryEntry[] => {
  const selectedClaudeProvider = selectClaudeSubscriptionProvider(
    input.providers,
    input.activeProviderId,
    input.claudeSubscriptionProviderId
  )

  const supportsImageInput = (provider: ProviderView, model: string): boolean => {
    if (isClaudeSubscriptionProvider(provider.type) || isCodexSubscriptionProvider(provider.type)) {
      return true
    }
    if (isXaiSubscriptionProvider(provider.type)) return isVendorModelMultimodal('xai', model)
    if (provider.type === 'custom') return provider.supportsImageInput === true
    return provider.vendorId ? isVendorModelMultimodal(provider.vendorId, model) : false
  }

  return input.providers
    .filter(
      (provider) =>
        (!isClaudeSubscriptionProvider(provider.type) ||
          input.includeAllClaudeSubscriptions === true ||
          provider.id === selectedClaudeProvider?.id) &&
        !providerValidationFailed(provider)
    )
    .flatMap((provider) =>
      (provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : ['']).map(
        (model) =>
          Object.freeze({
            key: configuredModelKey(provider.id, model),
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.type,
            ...(provider.vendorId ? { vendorId: provider.vendorId } : {}),
            model,
            label: model || provider.name,
            supportsImageInput: supportsImageInput(provider, model)
          })
      )
    )
}

export const buildConfiguredModelCatalog = (
  input: Readonly<{
    providers: readonly ProviderView[]
    activeProviderId?: string
    claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
    includeAllClaudeSubscriptions?: boolean
    frameworkId: AgentFrameworkId
    frameworkEndpoints: readonly ChatApiEndpoint[]
  }>
): readonly ConfiguredModelCatalogEntry[] => {
  return buildConfiguredModelInventory(input).map((entry) => {
    const provider = input.providers.find((candidate) => candidate.id === entry.providerId)!
    const model = entry.model
    const apiEndpoints = configuredModelApiEndpoints(provider, model)
    const frameworkCompatible = isProviderUsableByFramework(
      { apiEndpoints, type: provider.type },
      { id: input.frameworkId, supportedApiTypes: input.frameworkEndpoints }
    )
    const bridgeSupported = input.frameworkId !== 'codex' || isModelBridgeSupported(provider, model)
    return Object.freeze({
      ...entry,
      selectable: frameworkCompatible && bridgeSupported,
      ...(!frameworkCompatible
        ? { unavailableReason: 'framework-incompatible' as const }
        : !bridgeSupported
          ? { unavailableReason: 'model-bridge-unsupported' as const }
          : {})
    })
  })
}
