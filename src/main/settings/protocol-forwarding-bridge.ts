import {
  observeProviderFailure,
  type ProviderFailureObserver
} from './provider-failure-observation'
import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  copyProviderResponseHeaders,
  PROVIDER_HOP_BY_HOP_HEADERS,
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  withProviderConnectionMarker,
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
  readSseRecords,
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
} from '@aipoch/providers/transport'

const WIRE_PATH = {
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses'
} as const
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
    signal: AbortSignal,
    forceRefresh?: boolean
  ) => Promise<
    Readonly<{ endpoint: string; key: string; headers?: Readonly<Record<string, string>> }>
  >
  /** Retry once with a refreshed host credential after an upstream 401 (Lab only). */
  refreshOnUnauthorized?: boolean
  /** Upstream statuses to expose as terminal local 400s so ACP runtimes do not retry them. */
  terminalUpstreamStatuses?: readonly number[]
  /** Maps a host-only upstream failure to the token-free code/message shown to the caller. */
  mapUpstreamError?: (
    status: number,
    parsed: unknown
  ) => Readonly<{ code: string; message: string }> | undefined
  /** Maps a host-only connection/credential failure to a stable local response. */
  mapConnectionError?: (
    error: unknown
  ) => Readonly<{ status: number; code: string; message: string }> | undefined
  /** Stable message used when a host-only request fails before an upstream response exists. */
  privateCredentialsErrorMessage?: string
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
      PROVIDER_HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === 'content-encoding' ||
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
        json(response, requestError ? 400 : 502, {
          error: {
            type: requestError ? 'invalid_request_error' : 'api_error',
            message:
              error instanceof Error
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
      const mapped = privateCredentials ? this.target.mapConnectionError?.(error) : undefined
      if (mapped) {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        json(response, mapped.status, {
          error: { type: 'authentication_error', code: mapped.code, message: mapped.message }
        })
        return
      }
      if (privateCredentials)
        throw new Error(
          this.target.privateCredentialsErrorMessage ?? 'Codex provider request failed.'
        )
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
    const resolveEndpoint = (value: string | undefined): URL => {
      const resolved = new URL(value ?? target.endpoint)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        throw new Error('The protocol forwarding provider target has no valid endpoint URL.')
      }
      return resolved
    }
    const endpoint = resolveEndpoint(connection?.endpoint)
    const body = JSON.stringify({ ...adapted, model: target.model })
    // Account routing and bearer credentials come exclusively from main. Client headers cannot
    // override the selected account, attach cookies, or route an OAuth request to another host.
    const forwardingHeaders = (
      resolved:
        | Readonly<{
            endpoint: string
            key: string
            headers?: Readonly<Record<string, string>>
          }>
        | undefined
    ): Headers =>
      resolved
        ? new Headers({
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'user-agent': 'open-science-agent/0.1.0',
            ...resolved.headers,
            authorization: `Bearer ${resolved.key}`
          })
        : requestHeaders(request, target.key)
    const headersToForward = forwardingHeaders(connection)
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
    const fetchUpstream = withProviderConnectionMarker(transport, response)
    const send = (url: URL, headers: Headers): Promise<Response> =>
      fetchProviderRequest(fetchUpstream, url, {
        method: 'POST',
        headers,
        body,
        signal: request.signal
      })
    let upstream = await send(endpoint, headersToForward)
    // A host-owned credential can expire mid-generation. Refresh exactly once; a second 401 is a
    // real authentication failure and must not loop.
    if (
      connection &&
      target.refreshOnUnauthorized === true &&
      upstream.status === 401 &&
      target.resolveConnection
    ) {
      await upstream.body?.cancel()
      const refreshed = await target.resolveConnection(request.signal, true)
      request.signal.throwIfAborted()
      upstream = await send(resolveEndpoint(refreshed.endpoint), forwardingHeaders(refreshed))
    }
    if (connection && !upstream.ok) {
      const upstreamBody = await readBoundedProviderErrorBody(upstream, { signal: request.signal })
      let code = 'provider_error'
      let message = target.privateCredentialsErrorMessage ?? 'Codex provider request failed.'
      if (upstreamBody.complete) {
        let parsed: unknown
        try {
          parsed = JSON.parse(upstreamBody.body.toString('utf8'))
        } catch {
          parsed = undefined
        }
        const mapped = target.mapUpstreamError?.(upstream.status, parsed)
        if (mapped) {
          code = mapped.code
          message = mapped.message
        } else {
          const error = parsed as { error?: { code?: unknown } } | undefined
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
          if (typeof error?.error?.code === 'string' && allowed.includes(error.error.code)) {
            code = error.error.code
          }
        }
      }
      const terminal = target.terminalUpstreamStatuses?.includes(upstream.status) === true
      const clientStatus = terminal ? 400 : upstream.status >= 400 ? upstream.status : 502
      response.setHeader('x-open-science-upstream-status', String(upstream.status))
      json(response, clientStatus, { error: { code, message } })
      return
    }
    const headers = connection
      ? { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' }
      : copyProviderResponseHeaders(upstream.headers)
    if (isDeterministicProviderErrorStatus(upstream.status)) {
      const upstreamBody = await readBoundedProviderErrorBody(upstream, {
        signal: request.signal
      })
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
    await pipeline(Readable.from(stream), response)
  }
}
