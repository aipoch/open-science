import type { ModelProtocol } from './types'

export type CloudflareGateway = Readonly<{
  accountId: string
  gatewayId: string
  mode: 'rest' | 'anthropic'
}>

export const validCloudflareAccountId = (id: string): boolean => /^[a-f0-9]{32}$/i.test(id.trim())

export const validCloudflareGatewayId = (id: string): boolean => {
  const segment = id.trim()
  return /^[a-z0-9_.~-]{1,64}$/i.test(segment) && segment !== '.' && segment !== '..'
}

/** Normalize the gateway configuration and require each ID to fit in one URL path segment. */
export function parseCloudflareGateway(value: unknown): CloudflareGateway | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { accountId, gatewayId, mode } = value as Partial<CloudflareGateway>
  if (
    typeof accountId !== 'string' ||
    !validCloudflareAccountId(accountId) ||
    typeof gatewayId !== 'string' ||
    !validCloudflareGatewayId(gatewayId) ||
    (mode !== 'rest' && mode !== 'anthropic')
  )
    return undefined
  return { accountId: accountId.trim().toLowerCase(), gatewayId: gatewayId.trim(), mode }
}

export const cloudflareGatewayProtocol = (
  mode: CloudflareGateway['mode']
): 'chat-completions' | 'messages' => (mode === 'rest' ? 'chat-completions' : 'messages')

/** Keep Workers AI IDs and native Anthropic model IDs on their corresponding endpoints. */
export const cloudflareGatewayAcceptsModel = (
  mode: CloudflareGateway['mode'],
  model: string
): boolean => (mode === 'anthropic' ? !model.includes('/') : !/^claude-/i.test(model))

export const cloudflareGatewayBase = ({ accountId, gatewayId, mode }: CloudflareGateway): string =>
  mode === 'rest'
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
    : `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`

/** Accept an Azure resource name or a public-cloud inference URL for the selected protocol. */
export function parseFoundryLocation(
  location: string,
  protocol: ModelProtocol
): string | undefined {
  const resourceName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  const serviceHost = 'services.ai.azure.com'
  if (resourceName.test(location)) return `${location}.${serviceHost}`

  const url = URL.parse(location.includes('://') ? location : `https://${location}`)
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.search && (protocol !== 'chat-completions' || url.search !== '?api-version=v1'))
  )
    return undefined

  const suffixes = protocol === 'messages' ? [serviceHost] : [serviceHost, 'openai.azure.com']
  const suffix = suffixes.find((domain) => url.hostname.endsWith(`.${domain}`))
  if (!suffix || !resourceName.test(url.hostname.slice(0, -(suffix.length + 1)))) return undefined
  const path = url.pathname.replace(/\/$/, '')
  const validPaths =
    protocol === 'messages'
      ? ['', '/anthropic', '/anthropic/v1/messages']
      : ['', '/openai/v1', '/openai/v1/chat/completions']
  return validPaths.includes(path) ? url.hostname : undefined
}

export const foundryGatewayBase = (hostname: string, protocol: ModelProtocol): string =>
  `https://${hostname}/${protocol === 'messages' ? 'anthropic' : 'openai/v1'}`
