import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { normalizeAnthropicBaseUrl } from './base-url'
import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'

const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

export type AnthropicProviderBridgeTarget = Readonly<{
  id: string
  baseUrl: string
  key?: string
  model: string
}>

export type AnthropicProviderBridgeConnection = Readonly<{
  baseUrl: string
  token: string
}>

const requestHeaders = (request: ProviderLoopbackHttpRequest, key?: string): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === 'authorization' ||
      normalized === 'x-api-key' ||
      value === undefined
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  if (key) headers.set('authorization', `Bearer ${key}`)
  headers.set('content-type', 'application/json')
  return headers
}

const copyResponseHeaders = (source: Headers, response: ServerResponse): void => {
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) response.setHeader(name, value)
  }
}

export class AnthropicProviderBridge {
  private readonly targets: ReadonlyMap<string, AnthropicProviderBridgeTarget>
  private readonly host: ProviderLoopbackHttpHost<AnthropicProviderBridgeConnection>
  private target: AnthropicProviderBridgeTarget

  constructor(targets: readonly AnthropicProviderBridgeTarget[], initialTargetId: string) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    if (!initial) throw new Error('The initial Anthropic bridge target is not registered.')
    this.target = initial
    this.host = new ProviderLoopbackHttpHost({
      credentialMode: 'bearer-or-api-key',
      createConnection: (origin, token) => Object.freeze({ baseUrl: origin, token }),
      onUnauthorized: (response) =>
        json(response, 401, {
          error: { type: 'authentication_error', message: 'Unauthorized' }
        }),
      onError: (error, response) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        const requestError = error instanceof ProviderLoopbackRequestError
        json(response, requestError ? 400 : 502, {
          error: {
            type: requestError ? 'invalid_request_error' : 'api_error',
            message: error instanceof Error ? error.message : 'Anthropic provider request failed.'
          }
        })
      },
      handle: (request, response) => this.handle(request, response)
    })
  }

  setTarget(targetId: string): boolean {
    const target = this.targets.get(targetId)
    if (!target) return false
    this.target = target
    return true
  }

  async start(): Promise<AnthropicProviderBridgeConnection> {
    return this.host.start()
  }

  async close(): Promise<void> {
    await this.host.close()
  }

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST') {
      json(response, 405, {
        error: { type: 'invalid_request_error', message: 'Method not allowed' }
      })
      return
    }

    const requestUrl = request.url
    if (!ALLOWED_PATHS.has(requestUrl.pathname)) {
      json(response, 404, { error: { type: 'not_found_error', message: 'Not found' } })
      return
    }

    const parsed = await request.readJsonObject()

    const target = this.target
    const body = JSON.stringify({ ...parsed, model: target.model })
    const baseUrl = normalizeAnthropicBaseUrl(target.baseUrl)
    if (!baseUrl) throw new Error('The Anthropic provider target has no valid base URL.')
    const upstream = await fetch(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`, {
      method: 'POST',
      headers: requestHeaders(request, target.key),
      body,
      redirect: 'manual',
      signal: request.signal
    })
    response.statusCode = upstream.status
    response.statusMessage = upstream.statusText
    copyResponseHeaders(upstream.headers, response)
    if (!upstream.body) {
      response.end()
      return
    }
    await pipeline(Readable.from(upstream.body as AsyncIterable<Uint8Array>), response)
  }
}
