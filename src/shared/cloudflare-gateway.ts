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

export const CLOUDFLARE_GATEWAY_MODELS: Readonly<
  Record<CloudflareGateway['mode'], readonly string[]>
> = {
  rest: [
    '@cf/openai/gpt-oss-120b',
    '@cf/openai/gpt-oss-20b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  ],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
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
