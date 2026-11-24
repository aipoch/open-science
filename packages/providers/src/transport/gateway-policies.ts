import type { ProviderRequestPolicy } from './request'

const messagesEndpoints = (baseUrl: string): readonly string[] => {
  const messages = `${baseUrl}/v1/messages`
  const countTokens = `${messages}/count_tokens`
  // Claude clients can append beta=true to both paths.
  return [messages, `${messages}?beta=true`, countTokens, `${countTokens}?beta=true`]
}

/** Bind Cloudflare authentication to the selected gateway and request format. */
export function cloudflareGatewayRequestPolicy(
  baseUrl: string,
  gatewayId: string,
  mode: 'rest' | 'anthropic'
): ProviderRequestPolicy {
  const common = {
    credentialPrefix: 'Bearer ',
    stripHeaderPrefix: 'cf-aig-',
    routeIdentity: gatewayId,
    invalidEndpointMessage: 'Invalid Cloudflare AI Gateway endpoint.'
  } as const
  if (mode === 'rest') {
    return {
      ...common,
      allowedUrls: [`${baseUrl}/chat/completions`],
      credentialHeader: 'authorization',
      headers: { 'cf-aig-gateway-id': gatewayId }
    }
  }
  return {
    ...common,
    allowedUrls: messagesEndpoints(baseUrl),
    credentialHeader: 'cf-aig-authorization',
    defaultHeaders: { 'anthropic-version': '2023-06-01' }
  }
}

/** Scope the Foundry resource key to the selected protocol and its permitted endpoints. */
export function foundryRequestPolicy(
  baseUrl: string,
  protocol: 'chat-completions' | 'messages'
): ProviderRequestPolicy {
  const isMessages = protocol === 'messages'
  return {
    allowedUrls: isMessages ? messagesEndpoints(baseUrl) : [`${baseUrl}/chat/completions`],
    credentialHeader: isMessages ? 'x-api-key' : 'api-key',
    invalidEndpointMessage: 'Invalid Microsoft Foundry endpoint.'
  }
}
