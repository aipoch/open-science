import type { CloudflareGateway } from '@aipoch/providers/protocol'

export {
  cloudflareGatewayBase,
  cloudflareGatewayProtocol,
  parseCloudflareGateway,
  validCloudflareAccountId,
  validCloudflareGatewayId,
  type CloudflareGateway
} from '@aipoch/providers/protocol'

export const DEFAULT_CLOUDFLARE_GATEWAY: CloudflareGateway = {
  accountId: '',
  gatewayId: 'default',
  mode: 'rest'
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
