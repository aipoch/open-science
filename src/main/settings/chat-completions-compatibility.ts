import {
  observeProviderFailure,
  type ProviderFailureObserver
} from './provider-failure-observation'
import type { ServerResponse } from 'node:http'

import {
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  readBoundedResponseText,
  fetchProviderRequest
} from '@aipoch/providers/transport'
import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'

import {
  chatCompletionsToResponses,
  responsesToChatCompletions,
  chatCompletionsToMessages,
  messagesToChatCompletions,
  encodeChatCompletionsStream
} from '@aipoch/providers/protocol'

type Json = Record<string, unknown>
type CompatibilityWire = 'messages' | 'responses'

export type ChatCompletionsCompatibilityTarget = Readonly<{
  onProviderFailure?: ProviderFailureObserver
  endpoint: string
  key?: string
  model: string
  wire: CompatibilityWire
  adaptRequest?: (request: Json) => Json
}>

export type ChatCompletionsCompatibilityConnection = Readonly<{
  baseUrl: string
  token: string
}>

export class ChatCompletionsCompatibilityBridge {
  private readonly host: ProviderLoopbackHttpHost<ChatCompletionsCompatibilityConnection>

  constructor(
    private readonly target: ChatCompletionsCompatibilityTarget,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.host = new ProviderLoopbackHttpHost({
      diagnosticName: `chat-${target.wire}`,
      credentialMode: 'bearer-or-api-key',
      createConnection: (origin, token) => ({ baseUrl: origin, token }),
      onUnauthorized: (response) =>
        json(response, 401, { error: { type: 'authentication_error', message: 'Unauthorized' } }),
      onError: (error, response) =>
        json(response, error instanceof ProviderLoopbackRequestError ? 400 : 502, {
          error: {
            type:
              error instanceof ProviderLoopbackRequestError ? 'invalid_request_error' : 'api_error',
            message:
              error instanceof Error ? error.message : 'Provider compatibility request failed.'
          }
        }),
      handle: (request, response) => this.handle(request, response)
    })
  }

  start(): Promise<ChatCompletionsCompatibilityConnection> {
    return this.host.start()
  }

  close(): Promise<void> {
    return this.host.close()
  }

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.url.pathname !== '/v1/chat/completions') {
      json(response, request.method === 'POST' ? 404 : 405, {
        error: { type: 'invalid_request_error', message: 'Not found' }
      })
      return
    }
    const original = await request.readJsonObject()
    const body = this.target.adaptRequest?.(original) ?? original
    const requestModel =
      typeof body.model === 'string' && body.model ? body.model : this.target.model
    const wantsStream = body.stream === true
    const upstreamBody =
      this.target.wire === 'responses'
        ? chatCompletionsToResponses(body, this.target.model)
        : chatCompletionsToMessages(body, this.target.model)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.target.key) headers.authorization = `Bearer ${this.target.key}`
    if (this.target.wire === 'messages') headers['anthropic-version'] = '2023-06-01'
    const startedAt = Date.now()
    const upstream = await fetchProviderRequest(this.fetchImpl, this.target.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: request.signal
    })
    const failureTarget = {
      model: typeof upstreamBody.model === 'string' ? upstreamBody.model : undefined,
      endpoint: this.target.wire,
      startedAt
    }
    if (upstream.status === 401 || upstream.status === 403) {
      await observeProviderFailure(this.target.onProviderFailure, failureTarget, upstream.status)
    }
    const payload = JSON.parse(
      await readBoundedResponseText(
        upstream,
        DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
        'Provider compatibility response'
      )
    ) as Json
    if (!upstream.ok) {
      if (upstream.status !== 401 && upstream.status !== 403) {
        await observeProviderFailure(
          this.target.onProviderFailure,
          failureTarget,
          upstream.status,
          JSON.stringify(payload)
        )
      }
      json(response, upstream.status, payload)
      return
    }
    const completion =
      this.target.wire === 'responses'
        ? responsesToChatCompletions(payload, requestModel)
        : messagesToChatCompletions(payload, requestModel)
    if (!wantsStream) {
      json(response, 200, completion)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.end(encodeChatCompletionsStream(completion))
  }
}

export type { CompatibilityWire }
