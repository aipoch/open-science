import { resolveManualProviderConnection, type OfficialVendorId } from '@aipoch/providers'
import {
  cloudflareGatewayBase,
  cloudflareGatewayProtocol,
  parseCloudflareGateway
} from '@aipoch/providers/protocol'
import { cloudflareGatewayRequestPolicy, foundryRequestPolicy } from '@aipoch/providers/transport'
import type { ResolvedProvider } from './provider-env'

/** Resolve a Cloudflare gateway into a runtime target. */
export function resolveCloudflareGateway(
  config: unknown,
  model?: string,
  key?: string
): ResolvedProvider {
  const gateway = parseCloudflareGateway(config)
  if (!gateway) throw new Error('Cloudflare Account ID and Gateway ID are required.')
  if (!model?.trim()) throw new Error('Model is required.')
  const baseUrl = cloudflareGatewayBase(gateway)
  return {
    type: 'custom',
    vendorId: 'cloudflare-ai-gateway',
    baseUrl,
    ...(gateway.mode === 'rest' ? { chatCompletionsBaseUrl: baseUrl } : {}),
    model: model.trim(),
    apiEndpoints: [cloudflareGatewayProtocol(gateway.mode)],
    key,
    requestPolicy: cloudflareGatewayRequestPolicy(baseUrl, gateway.gatewayId, gateway.mode)
  }
}

/** Use the same endpoint and protocol rules for draft probes and saved models. */
export function resolveManualProviderTarget(
  vendorId: OfficialVendorId,
  connection: unknown,
  model?: string,
  key?: string
): ResolvedProvider {
  const resolved = resolveManualProviderConnection(vendorId, connection)
  if (!resolved) throw new Error('Enter a valid provider endpoint.')
  if (!model?.trim()) throw new Error('Model is required.')
  const {
    baseUrl,
    connection: { protocol }
  } = resolved
  return {
    type: 'custom',
    vendorId,
    baseUrl,
    ...(protocol === 'chat-completions' && { chatCompletionsBaseUrl: baseUrl }),
    ...(vendorId === 'microsoft-foundry' &&
      protocol !== 'responses' && {
        requestPolicy: foundryRequestPolicy(baseUrl, protocol)
      }),
    ...(protocol === 'responses' && { responsesBaseUrl: baseUrl }),
    model: model.trim(),
    apiEndpoints: [protocol],
    key: key?.trim()
  }
}
