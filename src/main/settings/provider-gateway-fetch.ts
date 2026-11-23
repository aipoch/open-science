import type { CloudflareGateway } from '../../shared/cloudflare-gateway'
import { cloudflareGatewayFetch } from './cloudflare-gateway-transport'

/** Set the gateway auth headers and send Azure keys only to the configured inference endpoint. */
export function providerGatewayFetch(
  fetchImpl: typeof fetch,
  target: { cloudflare?: CloudflareGateway; azureChatBaseUrl?: string; key?: string }
): typeof fetch {
  if (!target.azureChatBaseUrl) return cloudflareGatewayFetch(fetchImpl, target)
  const endpoint = `${target.azureChatBaseUrl}/chat/completions`
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.href !== endpoint) throw new Error('Invalid Microsoft Foundry endpoint.')
    if (!target.key) throw new Error('API key is required.')
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    headers.delete('authorization')
    headers.delete('x-api-key')
    headers.set('api-key', target.key)
    return fetchImpl(input, { ...init, headers, redirect: 'error', credentials: 'omit' })
  }
}
