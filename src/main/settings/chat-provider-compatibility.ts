import type { ServerResponse } from 'node:http'

import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'
import { chatToResponses, responsesToChat } from './xai-protocol'

type Json = Record<string, unknown>
type CompatibilityWire = 'anthropic' | 'responses'

export type ChatProviderCompatibilityTarget = Readonly<{
  endpoint: string
  key?: string
  model: string
  wire: CompatibilityWire
  adaptRequest?: (request: Json) => Json
}>

export type ChatProviderCompatibilityConnection = Readonly<{
  baseUrl: string
  token: string
}>

const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => (object(part) && typeof part.text === 'string' ? [part.text] : []))
    .join('')
}

const anthropicContent = (content: unknown): unknown => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  const converted: unknown[] = []
  for (const part of content) {
    if (!object(part)) continue
    if (part.type === 'text') {
      converted.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type !== 'image_url' || !object(part.image_url)) continue
    const url = typeof part.image_url.url === 'string' ? part.image_url.url : ''
    const data = /^data:([^;,]+);base64,(.+)$/u.exec(url)
    if (data) {
      converted.push({
        type: 'image',
        source: { type: 'base64', media_type: data[1], data: data[2] }
      })
    } else if (url) converted.push({ type: 'image', source: { type: 'url', url } })
  }
  return converted
}

const chatToAnthropic = (body: Json, model: string): Json => {
  const system: string[] = []
  const messages: Json[] = []
  for (const value of Array.isArray(body.messages) ? body.messages : []) {
    if (!object(value) || typeof value.role !== 'string') continue
    if (value.role === 'system' || value.role === 'developer') {
      const content = text(value.content)
      if (content) system.push(content)
      continue
    }
    if (value.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: value.tool_call_id,
            content: text(value.content)
          }
        ]
      })
      continue
    }
    const content: unknown[] = []
    const converted = anthropicContent(value.content)
    if (typeof converted === 'string' && converted) content.push({ type: 'text', text: converted })
    else if (Array.isArray(converted)) content.push(...converted)
    if (Array.isArray(value.tool_calls)) {
      for (const call of value.tool_calls) {
        if (!object(call) || !object(call.function) || typeof call.function.name !== 'string')
          continue
        let input: unknown = {}
        try {
          input =
            typeof call.function.arguments === 'string'
              ? JSON.parse(call.function.arguments)
              : (call.function.arguments ?? {})
        } catch {
          input = {}
        }
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
    }
    if (content.length > 0) messages.push({ role: value.role, content })
  }
  const tools =
    body.tool_choice !== 'none' && Array.isArray(body.tools)
      ? body.tools.flatMap((tool) =>
          object(tool) && object(tool.function) && typeof tool.function.name === 'string'
            ? [
                {
                  name: tool.function.name,
                  description: tool.function.description,
                  input_schema: tool.function.parameters ?? { type: 'object', properties: {} }
                }
              ]
            : []
        )
      : undefined
  const toolChoice = body.tool_choice
  const anthropicToolChoice =
    toolChoice === 'required'
      ? { type: 'any' }
      : toolChoice === 'auto'
        ? { type: 'auto' }
        : object(toolChoice) &&
            object(toolChoice.function) &&
            typeof toolChoice.function.name === 'string'
          ? { type: 'tool', name: toolChoice.function.name }
          : undefined
  return {
    model,
    stream: false,
    max_tokens:
      typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : 4096,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  }
}

const anthropicToChat = (message: Json, model: string): Json => {
  const content = Array.isArray(message.content) ? message.content.filter(object) : []
  const toolCalls = content
    .filter((part) => part.type === 'tool_use' && typeof part.name === 'string')
    .map((part, index) => ({
      id: part.id ?? `call_${index}`,
      type: 'function',
      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
    }))
  const visibleText = content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  const reasoning = content
    .filter((part) => part.type === 'thinking' && typeof part.thinking === 'string')
    .map((part) => part.thinking)
    .join('')
  const usage = object(message.usage) ? message.usage : {}
  const promptTokens = Number(usage.input_tokens ?? 0)
  const completionTokens = Number(usage.output_tokens ?? 0)
  return {
    id: message.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: visibleText || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(typeof usage.cache_read_input_tokens === 'number'
        ? { prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens } }
        : {})
    }
  }
}

const writeChatStream = (response: ServerResponse, completion: Json): void => {
  const choice =
    Array.isArray(completion.choices) && object(completion.choices[0]) ? completion.choices[0] : {}
  const message = object(choice.message) ? choice.message : {}
  const chunk = (delta: Json, finishReason: unknown = null, usage?: unknown): void => {
    response.write(
      `data: ${JSON.stringify({
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {})
      })}\n\n`
    )
  }
  chunk({
    role: 'assistant',
    content: message.content,
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
  })
  chunk({}, choice.finish_reason, completion.usage)
  response.end('data: [DONE]\n\n')
}

export class ChatProviderCompatibilityBridge {
  private readonly host: ProviderLoopbackHttpHost<ChatProviderCompatibilityConnection>

  constructor(
    private readonly target: ChatProviderCompatibilityTarget,
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

  start(): Promise<ChatProviderCompatibilityConnection> {
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
        ? chatToResponses(body, this.target.model)
        : chatToAnthropic(body, this.target.model)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.target.key) headers.authorization = `Bearer ${this.target.key}`
    if (this.target.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01'
    const upstream = await this.fetchImpl(this.target.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      redirect: 'manual',
      signal: request.signal
    })
    const payload = (await upstream.json()) as Json
    if (!upstream.ok) {
      json(response, upstream.status, payload)
      return
    }
    const completion =
      this.target.wire === 'responses'
        ? responsesToChat(payload, requestModel)
        : anthropicToChat(payload, requestModel)
    if (!wantsStream) {
      json(response, 200, completion)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    writeChatStream(response, completion)
  }
}

export type { CompatibilityWire }
