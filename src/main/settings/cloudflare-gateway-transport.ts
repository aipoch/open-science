import {
  cloudflareGatewayBase,
  cloudflareGatewayProtocol,
  parseCloudflareGateway,
  type CloudflareGateway
} from '../../shared/cloudflare-gateway'
import type { ResolvedProvider } from './provider-env'

export function resolveCloudflareGateway(
  config: unknown,
  model?: string,
  key?: string
): ResolvedProvider {
  const cloudflare = parseCloudflareGateway(config)
  if (!cloudflare) throw new Error('Cloudflare Account ID and Gateway ID are required.')
  if (!model?.trim()) throw new Error('Model is required.')
  const baseUrl = cloudflareGatewayBase(cloudflare)
  return {
    type: 'custom',
    vendorId: 'cloudflare-ai-gateway',
    cloudflare,
    baseUrl,
    ...(cloudflare.mode === 'rest' ? { chatCompletionsBaseUrl: baseUrl } : {}),
    model: model.trim(),
    apiEndpoints: [cloudflareGatewayProtocol(cloudflare.mode)],
    key
  }
}

/** 仅向与已选账号和模式匹配的 Cloudflare 出站请求写入凭据。 */
export function cloudflareGatewayFetch(
  fetchImpl: typeof fetch,
  target: { cloudflare?: CloudflareGateway; key?: string }
): typeof fetch {
  const { cloudflare, key } = target
  if (!cloudflare) return fetchImpl
  const base = new URL(cloudflareGatewayBase(cloudflare))
  const messages = `${base.pathname}/v1/messages`
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    // Claude 的 beta 客户端会在 Messages 和 count_tokens 路径后加查询参数。
    const expectedRequest =
      cloudflare.mode === 'rest'
        ? url.pathname === `${base.pathname}/chat/completions` && !url.search
        : (url.pathname === messages || url.pathname === `${messages}/count_tokens`) &&
          (!url.search || url.search === '?beta=true')
    if (url.origin !== base.origin || url.username || url.password || url.hash || !expectedRequest)
      throw new Error('Invalid Cloudflare AI Gateway endpoint.')
    if (!key) throw new Error('API key is required.')

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    // 本地客户端可以生成通用认证头，实际网关和凭据一律由主进程确定。
    for (const name of [...headers.keys()]) {
      if (name.startsWith('cf-aig-') || name === 'authorization' || name === 'x-api-key') {
        headers.delete(name)
      }
    }
    if (cloudflare.mode === 'rest') {
      headers.set('authorization', `Bearer ${key}`)
      headers.set('cf-aig-gateway-id', cloudflare.gatewayId)
    } else {
      headers.set('cf-aig-authorization', `Bearer ${key}`)
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
    }
    return fetchImpl(input, { ...init, headers, redirect: 'error', credentials: 'omit' })
  }
}
