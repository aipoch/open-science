import {
  providerEndpoints,
  type ChatApiEndpoint,
  type ProviderApiType,
  type ProviderType
} from '../../../../shared/settings'

// Human-readable route for an endpoint, so a reason reads as a route rather than a vendor name.
const ENDPOINT_ROUTE: Record<ChatApiEndpoint, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions'
}

const routeList = (endpoints: readonly ChatApiEndpoint[]): string =>
  endpoints.map((endpoint) => ENDPOINT_ROUTE[endpoint]).join(' or ')

// Why a provider can't drive the current framework, shown on hover next to "· unavailable". Two axes:
// a local Claude sign-in only Claude Code can run, or a chat-endpoint mismatch.
export const incompatibilityReason = (
  provider: { apiType: ProviderApiType; type: ProviderType; name: string },
  frameworkName: string,
  frameworkEndpoints: readonly ChatApiEndpoint[]
): string => {
  if (provider.type === 'claude-default') {
    return `${provider.name} uses your local Claude sign-in, which only Claude Code can run. Switch to Claude Code or pick another model.`
  }
  return `${frameworkName} needs ${routeList(frameworkEndpoints)}, but ${provider.name} speaks ${routeList(providerEndpoints(provider.apiType))}.`
}
