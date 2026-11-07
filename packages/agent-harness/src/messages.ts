import { mediaCapabilities, nativeMedia, requestBody, type InputCapabilities } from './media'
import { dataEvents } from './chat-completions'
import { frozen, json } from './session-state'
import type {
  AgentModel,
  ContentBlock,
  Json,
  ModelRequest,
  ModelUsage,
  ToolCall
} from './session-types'

export type MessagesModelOptions = {
  endpoint: string
  model: string
  id?: string
  apiKey(signal: AbortSignal): string | Promise<string>
  fetch?: typeof globalThis.fetch
  anthropicVersion?: string
  parameters?: Readonly<Record<string, Json>>
  maxResponseBytes?: number
  /** Serialized request limit; defaults to 32 MiB. Not a media-token budget. */
  maxRequestBytes?: number
  /** Host-declared input support. Video enables the MiniMax-compatible extension. */
  inputCapabilities?: InputCapabilities
}
export class MessagesError extends Error {
  constructor(
    public readonly code: 'http' | 'network' | 'protocol' | 'limit',
    public readonly status?: number
  ) {
    super(status === undefined ? `Messages ${code} error` : `Messages HTTP ${status}`)
    this.name = 'MessagesError'
  }
}
const fail = (): never => {
  throw new MessagesError('protocol')
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail()
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail()
function contentOf(
  blocks: ContentBlock[],
  adapterId: string,
  capabilities: AgentModel['capabilities']
): unknown[] {
  return blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : nativeMedia(block, 'messages', adapterId, capabilities)
  )
}
function messagesOf(
  request: ModelRequest,
  adapterId: string,
  capabilities: AgentModel['capabilities']
): unknown[] {
  const calls = new Map<string, string>()
  const result: { role: string; content: unknown[] }[] = []
  for (const message of request.messages) {
    if (message.role === 'tool') {
      const id = calls.get(message.invocationId!)
      if (!id) return fail()
      const block = {
        type: 'tool_result',
        tool_use_id: id,
        content: contentOf(message.content, adapterId, capabilities),
        ...(message.isError ? { is_error: true } : {})
      }
      // Parallel tool results belong in the same user message immediately after tool use.
      if (result.at(-1)?.role === 'user') result.at(-1)!.content.push(block)
      else result.push({ role: 'user', content: [block] })
      continue
    }
    if (
      (message.role === 'assistant' || message.role === 'summary') &&
      message.content.some((b) => b.type !== 'text')
    )
      return fail()
    const content = contentOf(message.content, adapterId, capabilities)
    if (message.role === 'assistant') {
      if (message.providerState?.adapterId === adapterId) {
        const state = object(message.providerState.value)
        if (Array.isArray(state.thinking_blocks)) content.unshift(...state.thinking_blocks)
      }
      for (const call of message.calls ?? []) {
        calls.set(`${message.id}/${call.id}`, call.id)
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
      }
    }
    result.push({ role: message.role === 'summary' ? 'user' : message.role, content })
  }
  return result
}
export function createMessagesModel(input: MessagesModelOptions): AgentModel {
  const endpoint = new URL(input.endpoint)
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid Messages endpoint')
  if (
    endpoint.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  )
    throw new Error('Non-loopback Messages endpoints require HTTPS')
  if (!input.model.trim()) throw new Error('Missing model identity')
  const id = input.id ?? `messages:${endpoint.href}:${input.model}`,
    transport = input.fetch ?? globalThis.fetch,
    parameters = frozen(input.parameters ?? {})
  json(parameters)
  for (const key of ['model', 'tools', 'tool_choice', 'stream', 'messages', 'system', 'max_tokens'])
    if (key in parameters) throw new Error('Reserved messages parameter')
  const limit = input.maxResponseBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid response limit')
  const requestLimit = input.maxRequestBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1)
    throw new Error('Invalid request limit')
  const capabilities = mediaCapabilities('messages', input.inputCapabilities)
  return {
    id,
    capabilities,
    async *stream(request, signal) {
      signal.throwIfAborted()
      const messages = messagesOf(request, id, capabilities)
      const body = requestBody(
        {
          ...parameters,
          model: input.model,
          system: request.instructions,
          messages,
          stream: true,
          max_tokens: request.maxOutputTokens,
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters
                }))
              }
            : {})
        },
        requestLimit
      )
      const key = await input.apiKey(signal)
      signal.throwIfAborted()
      if (!key || /[\r\n]/.test(key)) throw new Error('Invalid model credential')
      let response: Response
      try {
        response = await transport(endpoint.href, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': input.anthropicVersion ?? '2023-06-01',
            accept: 'text/event-stream'
          },
          body
        })
      } catch {
        signal.throwIfAborted()
        throw new MessagesError('network')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new MessagesError('http', response.status)
      }
      let content = '',
        thinking: { type: 'thinking'; thinking: string; signature: string } | undefined,
        stop: 'end_turn' | 'tool_use' | 'max_tokens' | undefined,
        usage: ModelUsage | undefined,
        active: { id: string; name: string; arguments: string; input: unknown } | undefined
      const pendingCalls: Array<{
        id: string
        name: string
        arguments: string
        input: unknown
      }> = []
      const calls: ToolCall[] = []
      const thinkingBlocks: Json[] = []
      const usageFields: Record<string, number> = {}
      const updateUsage = (value: unknown): void => {
        const u = object(value)
        for (const key of [
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens'
        ])
          if (u[key] !== undefined) usageFields[key] = count(u[key])
        if (usageFields.input_tokens === undefined || usageFields.output_tokens === undefined)
          return
        const read = usageFields.cache_read_input_tokens
        const written = usageFields.cache_creation_input_tokens
        usage = {
          inputTokens: count(usageFields.input_tokens + (read ?? 0) + (written ?? 0)),
          outputTokens: usageFields.output_tokens,
          ...(read === undefined ? {} : { cacheReadTokens: read }),
          ...(written === undefined ? {} : { cacheWriteTokens: written })
        }
      }

      for await (const raw of dataEvents(response, limit, signal)) {
        if (raw === '[DONE]') continue
        const event = object(JSON.parse(raw)),
          type = event.type
        if (type === 'message_start') {
          const m = object(event.message)
          if (m.usage) updateUsage(m.usage)
          continue
        }
        if (type === 'content_block_start') {
          const block = object(event.content_block)
          if (block.type === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : '',
              name = typeof block.name === 'string' ? block.name : ''
            if (!id || !name) return fail()
            active = {
              id,
              name,
              arguments: '',
              input: block.input ?? {}
            }
          } else if (block.type === 'thinking') {
            thinking = {
              type: 'thinking',
              thinking: String(block.thinking ?? ''),
              signature: String(block.signature ?? '')
            }
          } else if (block.type === 'redacted_thinking') {
            if (typeof block.data !== 'string') return fail()
            thinkingBlocks.push({ type: 'redacted_thinking', data: block.data })
          }
          continue
        }
        if (type === 'content_block_delta') {
          const delta = object(event.delta)
          if (delta.type === 'text_delta') {
            if (typeof delta.text !== 'string') return fail()
            content += delta.text
            yield { type: 'text-delta', text: delta.text }
          } else if (delta.type === 'thinking_delta') {
            if (!thinking || typeof delta.thinking !== 'string') return fail()
            thinking.thinking += delta.thinking
            yield { type: 'reasoning-delta', text: delta.thinking }
          } else if (delta.type === 'signature_delta') {
            if (!thinking || typeof delta.signature !== 'string') return fail()
            thinking.signature += delta.signature
          } else if (delta.type === 'input_json_delta') {
            if (!active || typeof delta.partial_json !== 'string') return fail()
            active.arguments += delta.partial_json
            yield {
              type: 'tool-delta',
              index: calls.length,
              arguments: delta.partial_json,
              id: active.id,
              name: active.name
            }
          }
          continue
        }
        if (type === 'content_block_stop') {
          if (thinking) {
            if (!thinking.signature) return fail()
            thinkingBlocks.push(thinking)
            thinking = undefined
          }
          if (active) {
            pendingCalls.push(active)
            active = undefined
          }
          continue
        }
        if (type === 'message_delta') {
          const delta = object(event.delta)
          if (typeof delta.stop_reason === 'string') stop = delta.stop_reason as typeof stop
          if (event.usage) updateUsage(event.usage)
          continue
        }
        if (type === 'message_stop') break
        if (type === 'error') return fail()
      }
      if (!stop || active || thinking) return fail()
      if (stop !== 'end_turn' && stop !== 'tool_use' && stop !== 'max_tokens') return fail()
      if (stop !== 'max_tokens') {
        for (const call of pendingCalls) {
          const args = call.arguments ? JSON.parse(call.arguments) : call.input
          json(args)
          calls.push({ id: call.id, name: call.name, arguments: args })
        }
      }
      yield {
        type: 'finish',
        reason: stop === 'tool_use' ? 'tools' : stop === 'max_tokens' ? 'length' : 'complete',
        content: content ? [{ type: 'text', text: content }] : [],
        ...(calls.length ? { calls } : {}),
        ...(usage ? { usage } : {}),
        ...(thinkingBlocks.length ? { providerState: { thinking_blocks: thinkingBlocks } } : {})
      }
    }
  }
}
