import type { TFunction } from 'i18next'

import {
  configuredModelApiEndpoints,
  type ConfiguredModelCatalogEntry
} from '../../../../shared/configured-model-catalog'
import type { ModelProtocol } from '@aipoch/providers'
import type { ProviderType, ProviderView } from '../../../../shared/settings'
import { ENDPOINT_PATHS, providerEndpoints } from '../../../../shared/settings-runtime'

// Human-readable route for an endpoint, so a reason reads as a route rather than a vendor name. The
// routes are literal API paths, identical in every locale; only the joining word is translated.
const routeList = (endpoints: readonly ModelProtocol[], t: TFunction): string =>
  endpoints.map((endpoint) => ENDPOINT_PATHS[endpoint]).join(t(' or '))

export const modelUnavailableReason = (
  option: Pick<ConfiguredModelCatalogEntry, 'label' | 'metadata' | 'unavailableReason'>,
  provider: Pick<ProviderView, 'type' | 'apiEndpoints'>,
  frameworkName: string,
  frameworkEndpoints: readonly ModelProtocol[],
  t: TFunction
): string | undefined => {
  if (!option.unavailableReason) return undefined
  if (option.unavailableReason === 'model-bridge-unsupported') {
    return t(
      'This model is not supported over the Codex Chat Completions bridge. Pick another model for a Codex session.'
    )
  }

  return t('{{model}} uses {{modelRoutes}}, but {{framework}} supports {{frameworkRoutes}}.', {
    model: option.label,
    modelRoutes: routeList(configuredModelApiEndpoints(provider, option.metadata), t),
    framework: frameworkName,
    frameworkRoutes: routeList(frameworkEndpoints, t)
  })
}

// Why a provider can't drive the current framework, shown on hover next to "· unavailable". One axis:
// a chat-endpoint mismatch. Framework and provider names are proper nouns and interpolate verbatim.
export const incompatibilityReason = (
  provider: { apiEndpoints?: readonly ModelProtocol[]; type: ProviderType; name: string },
  frameworkName: string,
  frameworkEndpoints: readonly ModelProtocol[],
  t: TFunction
): string => {
  const endpoints = providerEndpoints(provider)
  if (
    frameworkName === 'Codex' &&
    frameworkEndpoints.includes('responses') &&
    endpoints.includes('chat-completions')
  ) {
    return t(
      '{{provider}} speaks /v1/chat/completions. Codex requires /v1/responses; choose an OpenAI Responses provider or switch the agent framework.',
      { provider: provider.name }
    )
  }
  return t('{{framework}} needs {{frameworkRoutes}}, but {{provider}} speaks {{providerRoutes}}.', {
    framework: frameworkName,
    frameworkRoutes: routeList(frameworkEndpoints, t),
    provider: provider.name,
    providerRoutes: routeList(endpoints, t)
  })
}
