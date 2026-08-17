import type { TFunction } from 'i18next'

import {
  providerEndpoints,
  type ChatApiEndpoint,
  type ProviderType
} from '../../../../shared/settings'

// Human-readable route for an endpoint, so a reason reads as a route rather than a vendor name. The
// routes are literal API paths, identical in every locale; only the joining word is translated.
const ENDPOINT_ROUTE: Record<ChatApiEndpoint, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
  responses: '/v1/responses'
}

const routeList = (endpoints: readonly ChatApiEndpoint[], t: TFunction): string =>
  endpoints.map((endpoint) => ENDPOINT_ROUTE[endpoint]).join(t(' or '))

// Why a provider can't drive the current framework, shown on hover next to "· unavailable". One axis:
// a chat-endpoint mismatch. Keys live in `common` because both the settings alert and the composer
// picker render this. Framework and provider names are proper nouns and interpolate verbatim.
export const incompatibilityReason = (
  provider: { apiEndpoints?: readonly ChatApiEndpoint[]; type: ProviderType; name: string },
  frameworkName: string,
  frameworkEndpoints: readonly ChatApiEndpoint[],
  t: TFunction
): string => {
  const endpoints = providerEndpoints(provider)
  if (
    frameworkName === 'Codex' &&
    frameworkEndpoints.includes('responses') &&
    endpoints.includes('openai')
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
