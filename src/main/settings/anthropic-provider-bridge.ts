import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { createLogger, errorLogFields, type Logger } from '../logger'
import { normalizeAnthropicBaseUrl } from './base-url'
import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'
import {
  DeterministicProviderErrorReplay,
  isDeterministicProviderErrorStatus,
  providerErrorClientStatus,
  providerRequestHeadersFingerprint,
  providerRequestFingerprint,
  readBoundedProviderErrorBody
} from './provider-error-replay'
import { fetchProviderRequest } from './provider-fetch'

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
type ProviderErrorSnapshot = Readonly<{
  body: Buffer
  headers: Record<string, string>
  status: number
}>

const defaultDiagnostics = createLogger('provider-loopback')

const upstreamOrigin = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).origin
  } catch {
    return undefined
  }
}

export type AnthropicProviderBridgeTarget = Readonly<{
  id: string
  baseUrl: string
  key?: string
  model: string
  backgroundModel?: string
  useApiKeyHeader?: boolean
}>

export type AnthropicProviderBridgeConnection = Readonly<{
  baseUrl: string
  token: string
}>

const requestHeaders = (
  request: ProviderLoopbackHttpRequest,
  key?: string,
  useApiKeyHeader = false
): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === 'authorization' ||
      normalized === 'x-api-key' ||
      normalized.startsWith('sec-fetch-') ||
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
  if (key) {
    if (useApiKeyHeader) headers.set('x-api-key', key)
    else headers.set('authorization', `Bearer ${key}`)
  }
  headers.set('content-type', 'application/json')
  return headers
}

const responseHeaders = (source: Headers): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
  }
  return headers
}

export class AnthropicProviderBridge {
  private readonly targets: ReadonlyMap<string, AnthropicProviderBridgeTarget>
  private readonly host: ProviderLoopbackHttpHost<AnthropicProviderBridgeConnection>
  private target: AnthropicProviderBridgeTarget
  private readonly fetchImpl: typeof fetch
  private readonly diagnostics: Pick<Logger, 'error'>
  private readonly deterministicErrors =
    new DeterministicProviderErrorReplay<ProviderErrorSnapshot>()

  constructor(
    targets: readonly AnthropicProviderBridgeTarget[],
    initialTargetId: string,
    fetchImpl: typeof fetch = fetch,
    diagnostics: Pick<Logger, 'error'> = defaultDiagnostics
  ) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    this.fetchImpl = fetchImpl
    this.diagnostics = diagnostics
    if (!initial) throw new Error('The initial Anthropic bridge target is not registered.')
    this.target = initial
    this.host = new ProviderLoopbackHttpHost({
      diagnosticName: 'anthropic',
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
    if (this.target.id !== target.id) this.deterministicErrors.clear()
    this.target = target
    return true
  }

  clearErrorReplay(): void {
    this.deterministicErrors.clear()
  }

  async start(): Promise<AnthropicProviderBridgeConnection> {
    return this.host.start()
  }

  async close(): Promise<void> {
    this.deterministicErrors.clear()
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
    const requestedModel = typeof parsed.model === 'string' ? parsed.model : undefined
    const model =
      target.backgroundModel !== undefined && requestedModel === target.backgroundModel
        ? requestedModel
        : target.model
    const body = JSON.stringify({ ...parsed, model })
    const headersToForward = requestHeaders(request, target.key, target.useApiKeyHeader)
    const replayKey = providerRequestFingerprint(
      target.id,
      `${requestUrl.pathname}${requestUrl.search}`,
      providerRequestHeadersFingerprint(headersToForward),
      body
    )
    const replay = this.deterministicErrors.get(replayKey)
    if (replay) {
      response.writeHead(replay.status, replay.headers)
      response.end(replay.body)
      return
    }
    const baseUrl = normalizeAnthropicBaseUrl(target.baseUrl)
    if (!baseUrl) throw new Error('The Anthropic provider target has no valid base URL.')
    let upstream: Response
    try {
      upstream = await fetchProviderRequest(
        this.fetchImpl,
        `${baseUrl}${requestUrl.pathname}${requestUrl.search}`,
        {
          method: 'POST',
          headers: headersToForward,
          body,
          signal: request.signal
        }
      )
    } catch (error) {
      const origin = upstreamOrigin(baseUrl)
      this.diagnostics.error('anthropic provider request failed', {
        targetId: target.id,
        path: requestUrl.pathname,
        ...(origin ? { upstreamOrigin: origin } : {}),
        ...errorLogFields(error)
      })
      throw error
    }
    const headers = responseHeaders(upstream.headers)
    if (isDeterministicProviderErrorStatus(upstream.status)) {
      const upstreamBody = await readBoundedProviderErrorBody(upstream, {
        signal: request.signal
      })
      delete headers['content-encoding']
      if (!upstreamBody.complete) headers['content-type'] = 'application/json'
      const bodyToReplay = upstreamBody.complete
        ? upstreamBody.body
        : Buffer.from(
            JSON.stringify({
              error: {
                type: 'invalid_request_error',
                message: `Provider request failed with status ${upstream.status}`
              }
            })
          )
      const snapshot = {
        body: bodyToReplay,
        headers: {
          ...headers,
          'content-length': String(bodyToReplay.byteLength),
          'x-open-science-upstream-status': String(upstream.status)
        },
        status: providerErrorClientStatus(upstream.status)
      }
      this.deterministicErrors.remember(replayKey, upstream.status, snapshot)
      response.writeHead(snapshot.status, snapshot.headers)
      response.end(snapshot.body)
      return
    }
    response.statusCode = upstream.status
    response.statusMessage = upstream.statusText
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    if (!upstream.body) {
      response.end()
      return
    }
    await pipeline(Readable.from(upstream.body as AsyncIterable<Uint8Array>), response)
  }
}
