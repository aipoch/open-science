export type CloudflareGateway = Readonly<{
  accountId: string
  gatewayId: string
  mode: 'rest' | 'anthropic'
}>

export const DEFAULT_CLOUDFLARE_GATEWAY: CloudflareGateway = {
  accountId: '',
  gatewayId: 'default',
  mode: 'rest'
}

export const validCloudflareAccountId = (id: string): boolean => /^[a-f0-9]{32}$/i.test(id.trim())
export const validCloudflareGatewayId = (id: string): boolean => {
  const segment = id.trim()
  return /^[a-z0-9_.~-]{1,64}$/i.test(segment) && segment !== '.' && segment !== '..'
}

/** 读取并规范化网关配置，确保账号和网关 ID 只能占用一个路径段。 */
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

export function sameCloudflareGateway(
  left?: CloudflareGateway,
  right?: CloudflareGateway
): boolean {
  return (
    left?.mode === right?.mode &&
    left?.accountId.trim().toLowerCase() === right?.accountId.trim().toLowerCase() &&
    left?.gatewayId.trim() === right?.gatewayId.trim()
  )
}

export const cloudflareGatewayProtocol = (mode: CloudflareGateway['mode']) =>
  mode === 'rest' ? 'chat-completions' : 'messages'

export const cloudflareGatewayBase = ({ accountId, gatewayId, mode }: CloudflareGateway): string =>
  mode === 'rest'
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
    : `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`
