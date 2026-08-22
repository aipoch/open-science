import type { ServerResponse } from 'node:http'
import { netFetchStandard } from '../skills/net-fetch'

import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'
import {
  anthropicToResponses,
  chatToResponses,
  countAnthropicInputTokens,
  responsesToAnthropic,
  responsesToChat
} from './xai-protocol'

type Wire = 'anthropic' | 'openai'
export type XaiOAuthBridgeTarget = Readonly<{ id: string; model: string }>
export type XaiOAuthBridgeConnection = Readonly<{ baseUrl: string; token: string }>

export class XaiOAuthProviderBridge {
  private readonly targets: ReadonlyMap<string, XaiOAuthBridgeTarget>
  private target: XaiOAuthBridgeTarget
  private readonly host: ProviderLoopbackHttpHost<XaiOAuthBridgeConnection>

  constructor(
    targets: readonly XaiOAuthBridgeTarget[],
    initialTargetId: string,
    private readonly wire: Wire,
    private readonly getAccessToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    if (!initial) throw new Error('The initial xAI OAuth bridge target is not registered.')
    this.target = initial
    this.host = new ProviderLoopbackHttpHost({
      credentialMode: 'bearer-or-api-key',
      createConnection: (origin, token) => ({ baseUrl: origin, token }),
      onUnauthorized: (response) => json(response, 401, { error: { message: 'Unauthorized' } }),
      onError: (error, response) =>
        json(response, error instanceof ProviderLoopbackRequestError ? 400 : 502, {
          error: { message: error instanceof Error ? error.message : 'xAI request failed.' }
        }),
      handle: (request, response) => this.handle(request, response)
    })
  }

  start(): Promise<XaiOAuthBridgeConnection> {
    return this.host.start()
  }

  close(): Promise<void> {
    return this.host.close()
  }

  setTarget(id: string): boolean {
    const target = this.targets.get(id)
    if (!target) return false
    this.target = target
    return true
  }

  clearErrorReplay(): void {
    void this.target
  }

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST')
      return json(response, 405, { error: { message: 'Method not allowed' } })
    const expected = this.wire === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
    if (this.wire === 'anthropic' && request.path === '/v1/messages/count_tokens') {
      return json(response, 200, {
        input_tokens: countAnthropicInputTokens(await request.readJsonObject())
      })
    }
    if (request.path !== expected) return json(response, 404, { error: { message: 'Not found' } })
    const body = await request.readJsonObject()
    const wantsStream = body.stream === true
    const upstreamBody =
      this.wire === 'anthropic'
        ? anthropicToResponses(body, this.target.model)
        : chatToResponses(body, this.target.model)
    let upstream = await this.request(upstreamBody, request, false)
    if (upstream.status === 401) upstream = await this.request(upstreamBody, request, true)
    const payload = (await upstream.json()) as Record<string, unknown>
    if (!upstream.ok) return json(response, upstream.status, payload)
    const translated =
      this.wire === 'anthropic'
        ? responsesToAnthropic(payload, this.target.model)
        : responsesToChat(payload, this.target.model)
    if (!wantsStream) return json(response, 200, translated)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (this.wire === 'anthropic') this.writeAnthropicStream(response, translated)
    else this.writeChatStream(response, translated)
  }

  private async request(
    body: Record<string, unknown>,
    request: ProviderLoopbackHttpRequest,
    forceRefresh: boolean
  ): Promise<Response> {
    const token = await this.getAccessToken(forceRefresh)
    return this.fetchImpl('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: request.signal
    })
  }

  private writeAnthropicStream(response: ServerResponse, message: Record<string, unknown>): void {
    const content = Array.isArray(message.content) ? message.content : []
    const event = (type: string, data: unknown): void => {
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    event('message_start', { type: 'message_start', message: { ...message, content: [] } })
    content.forEach((block, index) => {
      if (!block || typeof block !== 'object') return
      const typedBlock = block as Record<string, unknown>
      if (typedBlock.type === 'tool_use') {
        event('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: typedBlock.id,
            name: typedBlock.name,
            input: {}
          }
        })
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(typedBlock.input ?? {}) }
        })
      } else {
        event('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        })
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: String(typedBlock.text ?? '') }
        })
      }
      event('content_block_stop', { type: 'content_block_stop', index })
    })
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason },
      usage: message.usage
    })
    event('message_stop', { type: 'message_stop' })
    response.end()
  }

  private writeChatStream(response: ServerResponse, completion: Record<string, unknown>): void {
    const choices = Array.isArray(completion.choices) ? completion.choices : []
    const first = choices[0] as Record<string, unknown> | undefined
    const message =
      first && typeof first.message === 'object' ? (first.message as Record<string, unknown>) : {}
    const chunk = (delta: unknown, finishReason: unknown = null): void => {
      response.write(
        `data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
      )
    }
    chunk({ role: 'assistant', content: message.content, tool_calls: message.tool_calls })
    chunk({}, first?.finish_reason)
    response.end('data: [DONE]\n\n')
  }
}

export const createXaiOAuthProviderBridge = (
  targets: readonly XaiOAuthBridgeTarget[],
  initialTargetId: string,
  wire: Wire,
  getAccessToken: ((forceRefresh?: boolean) => Promise<string>) | undefined,
  fetchImpl: typeof fetch = netFetchStandard
): XaiOAuthProviderBridge => {
  if (!getAccessToken) throw new Error('xAI OAuth is unavailable.')
  return new XaiOAuthProviderBridge(targets, initialTargetId, wire, getAccessToken, fetchImpl)
}
