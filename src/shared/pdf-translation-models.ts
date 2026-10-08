import {
  buildConfiguredModelInventory,
  buildConfiguredModelCatalog,
  configuredModelApiEndpoints,
  type ConfiguredModelCatalogEntry,
  type ConfiguredModelInventoryEntry
} from './configured-model-catalog'
import { customProviderRequiresKey } from './provider-base-url'
import {
  isCodexSubscriptionProviderId,
  providerValidationFailed,
  type ProviderView
} from './settings'

export function pdfTranslationAgentModels(
  input: Parameters<typeof buildConfiguredModelCatalog>[0]
): readonly (ConfiguredModelCatalogEntry & {
  credentialsUnavailable: boolean
  subscriptionUnsupported: boolean
})[] {
  return buildConfiguredModelCatalog(input).map((entry) => {
    const provider = input.providers.find((value) => value.id === entry.providerId)!
    const credentialsUnavailable =
      provider.needsKey ||
      ((provider.type === 'custom' || provider.type === 'official') &&
        !provider.hasKey &&
        (provider.type === 'official' || customProviderRequiresKey(provider.baseUrl)))
    const subscriptionUnsupported =
      input.frameworkId === 'codex' && isCodexSubscriptionProviderId(entry.providerId)
    return {
      ...entry,
      selectable: entry.selectable && !credentialsUnavailable && !subscriptionUnsupported,
      credentialsUnavailable,
      subscriptionUnsupported
    }
  })
}

// These app-owned subscription/plan routes are admitted through Agent only.
// Speaking an API protocol does not make a subscription a general-purpose API account.
export function isPdfTranslationApiProvider(
  provider: Pick<ProviderView, 'type' | 'vendorId'>
): boolean {
  return (
    (provider.type === 'custom' || provider.type === 'official') &&
    ![
      'bailianplan',
      'glmcodingplan',
      'kimiforcode',
      'stepplan',
      'tencentcodingplan',
      'tencenttokenplan',
      'opencode-go'
    ].includes(provider.vendorId ?? '')
  )
}

export function pdfTranslationApiModels(
  providers: readonly ProviderView[]
): readonly ConfiguredModelInventoryEntry[] {
  const eligible = providers.filter(
    (provider) =>
      isPdfTranslationApiProvider(provider) &&
      !provider.needsKey &&
      (provider.hasKey ||
        (provider.type === 'custom' && !customProviderRequiresKey(provider.baseUrl))) &&
      (provider.type === 'official' || Boolean(provider.baseUrl?.trim()))
  )
  return buildConfiguredModelInventory({ providers: eligible }).filter((entry) => {
    const provider = eligible.find((value) => value.id === entry.providerId)!
    const endpoints = configuredModelApiEndpoints(provider, entry.model)
    const endpoint = endpoints.includes('openai')
      ? 'openai'
      : endpoints.includes('anthropic')
        ? 'anthropic'
        : 'responses'
    return (
      Boolean(entry.model.trim()) &&
      !providerValidationFailed(provider, { model: entry.model, endpoint })
    )
  })
}
