import {
  providerEndpoints,
  type ChatApiEndpoint,
  type ProviderType
} from '../../../../shared/settings'

// Human-readable route for an endpoint, so a reason reads as a route rather than a vendor name.
const ENDPOINT_ROUTE: Record<ChatApiEndpoint, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
  responses: '/v1/responses'
}

const routeList = (endpoints: readonly ChatApiEndpoint[]): string =>
  endpoints.map((endpoint) => ENDPOINT_ROUTE[endpoint]).join(' or ')

// Why a provider can't drive the current framework, shown on hover next to "· unavailable". One axis:
// a chat-endpoint mismatch.
export const incompatibilityReason = (
  provider: { apiEndpoints?: readonly ChatApiEndpoint[]; type: ProviderType; name: string },
  frameworkName: string,
  frameworkEndpoints: readonly ChatApiEndpoint[]
): string => {
  const endpoints = providerEndpoints(provider)
  if (
    frameworkName === 'Codex' &&
    frameworkEndpoints.includes('responses') &&
    endpoints.includes('openai')
  ) {
    return `${provider.name} speaks /v1/chat/completions. Codex requires /v1/responses; choose an OpenAI Responses provider or switch the agent framework.`
  }
  return `${frameworkName} needs ${routeList(frameworkEndpoints)}, but ${provider.name} speaks ${routeList(endpoints)}.`
}
