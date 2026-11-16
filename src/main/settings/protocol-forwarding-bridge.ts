import { createLogger } from '@aipoch/diagnostics/node'
import { redactSensitiveText } from '@aipoch/diagnostics'
import {
  observeProviderFailure,
  type ProviderFailureObserver
} from './provider-failure-observation'
import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
import {
  fetchProviderRequest,
  PROVIDER_TRANSPORT_ERROR,
  readSseRecords,
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
} from '@aipoch/providers/transport'

const WIRE_PATH = {
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses'
} as const
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

export type ProtocolForwardingBridgeTarget = Readonly<{
  id: string
  onProviderFailure?: ProviderFailureObserver
  wire: keyof typeof WIRE_PATH
  endpoint: string
  key?: string
  model: string
  /** Host-only OAuth resolution. These requests never replay errors or expose upstream diagnostics. */
  resolveConnection?: (
    signal: AbortSignal
  ) => Promise<
    Readonly<{ endpoint: string; key: string; headers?: Readonly<Record<string, string>> }>
  >
  adaptRequest?: (request: Record<string, unknown>) => Record<string, unknown>
  adaptStream?: (records: AsyncIterable<string>) => AsyncIterable<string>
}>

export type ProtocolForwardingBridgeConnection = Readonly<{
  baseUrl: string
  token: string
}>

const requestHeaders = (request: ProviderLoopbackHttpRequest, key?: string): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      // Fetch decodes upstream responses, so it must negotiate its own supported encodings.
      normalized === 'accept-encoding' ||
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
  if (key) headers.set('authorization', `Bearer ${key}`)
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

const log = createLogger('provider-response')
class ProviderTransportError extends Error {
  constructor() {
    super('Could not connect to the model provider')
  }
}
const sourceHeader = 'x-open-science-error-source'
const responseSourceHeader = 'x-open-science-response-source'
const requestIdOf = (headers: Headers, key?: string): string | undefined => {
  for (const name of ['x-request-id', 'request-id', 'x-minimax-request-id']) {
    const value = headers.get(name)
    if (value && (!key || !value.includes(key)) && /^[a-zA-Z0-9._:-]{1,128}$/.test(value))
      return value
  }
  return undefined
}
const networkCode = (error: unknown): string | undefined => {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const candidate = object(object(error).cause).code ?? object(error).code
  return typeof candidate === 'string' &&
    /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+|ERR_CERT_[A-Z_]+|CERT_[A-Z_]+)$/.test(
      candidate
    )
    ? candidate.slice(0, 80)
    : undefined
}
// Retain only error fields, never successful text/tool payloads or arbitrary response properties.
const errorDetail = (body: string, key?: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(body)
    const error = parsed?.error ?? parsed
    const clean = (value: unknown): string | undefined =>
      typeof value === 'string'
        ? redactSensitiveText(
            (key ? value.split(key).join('[redacted]') : value).slice(0, 4096)
          ).slice(0, 1024)
        : undefined
    return {
      code:
        typeof error?.code === 'number' && Number.isFinite(error.code)
          ? error.code
          : clean(error?.code),
      type: clean(error?.type),
      message: clean(error?.message)
    }
  } catch {
    return { format: body.trim().startsWith('<') ? 'html' : 'unstructured' }
  }
}

export class ProtocolForwardingBridge {
  private readonly targets: ReadonlyMap<string, ProtocolForwardingBridgeTarget>
  private readonly wire: ProtocolForwardingBridgeTarget['wire']
  private readonly host: ProviderLoopbackHttpHost<ProtocolForwardingBridgeConnection>
  private target: ProtocolForwardingBridgeTarget
  private readonly fetchImpl: typeof fetch
  private readonly deterministicErrors =
    new DeterministicProviderErrorReplay<ProviderErrorSnapshot>()

  constructor(
    targets: readonly ProtocolForwardingBridgeTarget[],
    initialTargetId: string,
    fetchImpl: typeof fetch = fetch,
    options: Readonly<{ token?: string }> = {}
  ) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    this.fetchImpl = fetchImpl
    if (!initial)
      throw new Error('The initial protocol forwarding bridge target is not registered.')
    this.target = initial
    this.wire = initial.wire
    this.host = new ProviderLoopbackHttpHost({
      diagnosticName: 'protocol-forwarding',
      credentialMode: 'bearer-or-api-key',
      ...(options.token ? { token: options.token } : {}),
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
        response.setHeader(
          sourceHeader,
          error instanceof ProviderTransportError ? 'provider-transport' : 'application'
        )
        json(response, requestError ? 400 : 502, {
          error: {
            type: requestError ? 'invalid_request_error' : 'api_error',
            message:
              error instanceof ProviderTransportError ||
              (error instanceof Error && error.message === PROVIDER_TRANSPORT_ERROR)
                ? error.message
                : 'protocol forwarding provider request failed.'
          }
        })
      },
      handle: (request, response) => this.handle(request, response)
    })
  }

  setTarget(targetId: string): boolean {
    const target = this.targets.get(targetId)
    if (!target || target.wire !== this.wire) return false
    if (this.target.id !== target.id) this.deterministicErrors.clear()
    this.target = target
    return true
  }

  clearErrorReplay(): void {
    this.deterministicErrors.clear()
  }

  async start(): Promise<ProtocolForwardingBridgeConnection> {
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
    const privateCredentials = Boolean(this.target.resolveConnection)
    try {
      await this.handleRequest(request, response)
    } catch (error) {
      // OAuth owners and network errors can contain account or credential details. ACP gets only
      // a stable failure; the auth owner is responsible for its own bounded diagnostics.
      if (privateCredentials) throw new Error('Codex provider request failed.')
      throw error
    }
  }

  private async handleRequest(
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
    if (requestUrl.pathname !== WIRE_PATH[this.wire]) {
      json(response, 404, { error: { type: 'not_found_error', message: 'Not found' } })
      return
    }

    const target = this.target
    const parsed = await request.readJsonObject()
    const adapted = target.adaptRequest?.(parsed) ?? parsed
    const connection = await target.resolveConnection?.(request.signal)
    request.signal.throwIfAborted()
    const endpoint = new URL(connection?.endpoint ?? target.endpoint)
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('The protocol forwarding provider target has no valid endpoint URL.')
    }
    const body = JSON.stringify({ ...adapted, model: target.model })
    // Account routing and bearer credentials come exclusively from main. Client headers cannot
    // override the selected account, attach cookies, or route an OAuth request to another host.
    const headersToForward = connection
      ? new Headers({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': 'open-science-agent/0.1.0',
          ...connection.headers,
          authorization: `Bearer ${connection.key}`
        })
      : requestHeaders(request, target.key)
    const replayKey = providerRequestFingerprint(
      target.id,
      requestUrl.pathname,
      providerRequestHeadersFingerprint(headersToForward),
      body
    )
    const replay = connection ? undefined : this.deterministicErrors.get(replayKey)
    if (replay) {
      response.writeHead(replay.status, replay.headers)
      response.end(replay.body)
      return
    }

    const startedAt = Date.now()
    // Chromium's net.fetch does not reliably surface manual POST redirects. Fail the request
    // at the first redirect and keep the browser cookie jar out of subscription traffic.
    const transport: typeof fetch = connection
      ? (url, init) => this.fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit' })
      : this.fetchImpl
    const observedTransport: typeof fetch = async (url, init) => {
      try {
        return await transport(url, init)
      } catch (error) {
        request.signal.throwIfAborted()
        // The exception came from the fetch boundary, not application request preparation.
        log.warn('provider transport failed', {
          source: 'provider-transport',
          model: target.model,
          endpoint: target.wire,
          origin: endpoint.origin,
          durationMs: Date.now() - startedAt,
          transportCode: networkCode(error),
          ...errorDetail(
            JSON.stringify({
              error: { message: error instanceof Error ? error.message : 'Network request failed' }
            }),
            connection?.key ?? target.key
          )
        })
        throw new ProviderTransportError()
      }
    }
    const upstream = await fetchProviderRequest(observedTransport, endpoint, {
      method: 'POST',
      headers: headersToForward,
      body,
      signal: request.signal
    })
    // Upstream headers cannot impersonate locally generated transport/application failures.
    const upstreamRequestId = requestIdOf(upstream.headers, connection?.key ?? target.key)
    const diagnosticContext = {
      source: 'provider-http',
      model: target.model,
      endpoint: target.wire,
      origin: endpoint.origin,
      status: upstream.status,
      requestId: upstreamRequestId,
      durationMs: Date.now() - startedAt
    }
    const recordError = (body: string, complete: boolean): void => {
      if (!connection)
        log.warn('provider HTTP failure', {
          ...diagnosticContext,
          bodyComplete: complete,
          ...errorDetail(body, target.key)
        })
    }
    response.setHeader(responseSourceHeader, 'provider')
    if (!upstream.ok) response.setHeader(sourceHeader, 'provider-http')
    if (upstreamRequestId) response.setHeader('x-open-science-request-id', upstreamRequestId)
    if (connection && !upstream.ok) {
      const upstreamBody = await readBoundedProviderErrorBody(upstream, { signal: request.signal })
      let code = 'provider_error'
      if (upstreamBody.complete) {
        try {
          const error = JSON.parse(upstreamBody.body.toString('utf8')).error
          const allowed = [
            'subscription_sharing_usage_limit_exceeded',
            'subscription_sharing_usage_unavailable',
            'invalid_api_key',
            'authentication_error',
            'model_not_found',
            'rate_limit_exceeded',
            'insufficient_quota',
            'context_length_exceeded'
          ]
          if (allowed.includes(error?.code)) code = error.code
        } catch {
          // Raw OAuth errors must not cross the loopback boundary, including malformed bodies.
        }
      }
      response.setHeader('x-open-science-upstream-status', String(upstream.status))
      json(response, upstream.status >= 400 ? upstream.status : 502, {
        error: { code, message: 'Codex provider request failed.' }
      })
      return
    }
    const headers = connection
      ? { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' }
      : responseHeaders(upstream.headers)
    for (const name of [
      sourceHeader,
      responseSourceHeader,
      'x-open-science-request-id',
      'x-open-science-upstream-status'
    ])
      delete headers[name]
    if (isDeterministicProviderErrorStatus(upstream.status)) {
      const upstreamBody = await readBoundedProviderErrorBody(upstream, {
        signal: request.signal
      })
      recordError(upstreamBody.body.toString('utf8'), upstreamBody.complete)
      await observeProviderFailure(
        target.onProviderFailure,
        {
          model: target.model,
          endpoint: target.wire === 'responses' ? 'responses' : 'chat-completions',
          startedAt
        },
        upstream.status,
        upstreamBody.complete ? upstreamBody.body.toString('utf8') : undefined
      )
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
    if (!upstream.ok) {
      const errorBody = await readBoundedProviderErrorBody(upstream, {
        signal: request.signal,
        maxBytes: 16 * 1024,
        timeoutMs: 1000
      })
      recordError(errorBody.body.toString('utf8'), errorBody.complete)
      const body = errorBody.complete
        ? errorBody.body
        : Buffer.from(
            JSON.stringify({
              error: {
                message: 'Provider error response could not be read within the diagnostic limit.'
              }
            })
          )
      delete headers['content-length']
      response.writeHead(upstream.status, headers)
      response.end(body)
      return
    }
    response.statusCode = upstream.status
    response.statusMessage = upstream.statusText
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    if (!upstream.body) {
      response.end()
      return
    }
    const stream =
      target.adaptStream &&
      parsed.stream === true &&
      upstream.ok &&
      upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
        'text/event-stream'
        ? target.adaptStream(
            readSseRecords(upstream, DEFAULT_MAX_PROVIDER_RESPONSE_BYTES, request.signal)
          )
        : (upstream.body as AsyncIterable<Uint8Array>)
    const inspect = async function* (): AsyncGenerator<Uint8Array | string> {
      const decoder = new TextDecoder()
      let buffered = '',
        dropping = false
      for await (const chunk of stream) {
        if (!connection && target.wire === 'responses') {
          buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
          const records = buffered.split(/\r?\n\r?\n/)
          buffered = records.pop() ?? ''
          for (const record of records) {
            if (dropping) {
              dropping = false
              continue
            }
            if (record.length > 16384) continue
            try {
              const data = record
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n')
              const event = JSON.parse(data)
              if (event?.type === 'error' || event?.type === 'response.failed') {
                const error =
                  event.type === 'response.failed' ? event.response?.error : (event.error ?? event)
                log.warn('provider stream failure', {
                  ...diagnosticContext,
                  source: 'provider-stream',
                  ...errorDetail(JSON.stringify({ error }), target.key)
                })
              }
            } catch {
              /* Observation never changes forwarding or exposes successful payloads. */
            }
          }
          if (buffered.length > 16384) {
            buffered = ''
            dropping = true
          }
        }
        yield chunk
      }
    }
    await pipeline(Readable.from(inspect()), response)
  }
}
