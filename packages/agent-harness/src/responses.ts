import { mediaCapabilities, nativeMedia, requestBody, type InputCapabilities } from './media'
import { ChatCompletionsError, dataEvents } from './chat-completions'
import { frozen, json } from './session-state'
import type {
  AgentModel,
  ContentBlock,
  Json,
  ModelRequest,
  ModelUsage,
  ToolCall
} from './session-types'

export type ResponsesModelOptions = {
  endpoint: string
  model: string
  id?: string
  apiKey(signal: AbortSignal): string | Promise<string>
  fetch?: typeof globalThis.fetch
  parameters?: Readonly<Record<string, Json>>
  maxResponseBytes?: number
  /** Serialized request limit; defaults to 32 MiB. Not a media-token budget. */
  maxRequestBytes?: number
  /** Host-declared input support. Video enables the MiniMax-compatible extension. */
  inputCapabilities?: InputCapabilities
}
/** Fixed parser state only; excludes response prose, arguments, credentials and headers. */
export type ResponsesDiagnostics = Readonly<{
  phase:
    | 'input'
    | 'response'
    | 'stream'
    | 'event-json'
    | 'event'
    | 'provider'
    | 'missing-completion'
    | 'tool-arguments'
  httpStatus?: number
  source?: 'provider-http' | 'provider-stream' | 'provider-transport' | 'application'
  requestId?: string
  eventCount: number
  receivedDone: boolean
  receivedCompletion: boolean
}>
export class ResponsesError extends Error {
  constructor(
    public readonly code:
      | 'provider'
      | 'http'
      | 'network'
      | 'protocol'
      | 'limit'
      | 'insufficient_quota'
      | 'rate_limit_exceeded'
      | 'model_not_found'
      | 'authentication_error',
    public readonly status?: number,
    public readonly diagnostics?: ResponsesDiagnostics
  ) {
    super(status === undefined ? `Responses ${code} error` : `Responses HTTP ${status}`)
    this.name = 'ResponsesError'
    if (diagnostics) this.diagnostics = Object.freeze({ ...diagnostics })
  }
}
const fail = (): never => {
  throw new ResponsesError('protocol')
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail()
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail()
const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
function inputOf(
  request: ModelRequest,
  adapterId: string,
  capabilities: AgentModel['capabilities']
): unknown[] {
  const calls = new Map<string, string>()
  const result: unknown[] = []
  for (const message of request.messages) {
    const content = message.content.map((block) => {
      if (block.type === 'text') return { type: 'input_text', text: block.text }
      if (message.role === 'assistant' || message.role === 'summary') return fail()
      return nativeMedia(block, 'responses', adapterId, capabilities)
    })
    if (message.role === 'tool') {
      const id = calls.get(message.invocationId!)
      if (!id) return fail()
      result.push({
        type: 'function_call_output',
        call_id: id,
        output: message.content.every((block) => block.type === 'text')
          ? textOf(message.content)
          : content
      })
    } else {
      if (message.role === 'assistant' && message.providerState?.adapterId === adapterId) {
        const state = object(message.providerState.value)
        if (Array.isArray(state.reasoning_items)) result.push(...state.reasoning_items)
      }
      if (content.length)
        result.push({
          role: message.role === 'summary' ? 'user' : message.role,
          content
        })
      for (const call of message.calls ?? []) {
        calls.set(`${message.id}/${call.id}`, call.id)
        result.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        })
      }
    }
  }
  return result
}
export function createResponsesModel(input: ResponsesModelOptions): AgentModel {
  const endpoint = new URL(input.endpoint)
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid Responses endpoint')
  if (
    endpoint.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  )
    throw new Error('Non-loopback Responses endpoints require HTTPS')
  if (!input.model.trim()) throw new Error('Missing model identity')
  const id = input.id ?? `responses:${endpoint.href}:${input.model}`
  const parameters = frozen(input.parameters ?? {})
  json(parameters)
  for (const key of [
    'model',
    'tools',
    'tool_choice',
    'stream',
    'input',
    'instructions',
    'max_output_tokens',
    'previous_response_id',
    'conversation',
    'background'
  ])
    if (key in parameters) throw new Error('Reserved responses parameter')
  const transport = input.fetch ?? globalThis.fetch
  const limit = input.maxResponseBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid response limit')
  const requestLimit = input.maxRequestBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1)
    throw new Error('Invalid request limit')
  const capabilities = mediaCapabilities('responses', input.inputCapabilities)
  return {
    id,
    capabilities,
    async *stream(request, signal) {
      let phase: ResponsesDiagnostics['phase'] = 'input'
      let httpStatus: number | undefined
      let source: ResponsesDiagnostics['source']
      let requestId: string | undefined
      let eventCount = 0,
        receivedDone = false,
        receivedCompletion = false
      try {
        signal.throwIfAborted()
        const items = inputOf(request, id, capabilities)
        const body = requestBody(
          {
            ...parameters,
            model: input.model,
            instructions: request.instructions,
            input: items,
            store: false,
            include: [
              ...new Set([
                ...(Array.isArray(parameters.include) ? parameters.include : []),
                'reasoning.encrypted_content'
              ])
            ],
            stream: true,
            ...(request.useProviderOutputDefault
              ? {}
              : { max_output_tokens: request.maxOutputTokens }),
            ...(request.tools.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                  }))
                }
              : {})
          },
          requestLimit
        )
        const key = await input.apiKey(signal)
        signal.throwIfAborted()
        if (!key || /[\r\n]/.test(key)) throw new Error('Invalid model credential')
        phase = 'response'
        let response: Response
        try {
          response = await transport(endpoint.href, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${key}`
            },
            body
          })
        } catch {
          signal.throwIfAborted()
          throw new ResponsesError('network')
        }
        httpStatus = response.status
        const origin = response.headers.get('x-open-science-error-source')
        if (
          origin === 'provider-http' ||
          origin === 'provider-transport' ||
          origin === 'application'
        )
          source = origin
        const upstreamRequestId = response.headers.get('x-open-science-request-id')
        if (upstreamRequestId && /^[a-zA-Z0-9._:-]{1,128}$/.test(upstreamRequestId))
          requestId = upstreamRequestId
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          const upstream = response.headers.get('x-open-science-upstream-status')
          const status =
            source === 'provider-http' && upstream && /^[45]\d{2}$/.test(upstream)
              ? Number(upstream)
              : response.status
          throw new ResponsesError('http', status)
        }
        let text = '',
          reasoning = '',
          finish: boolean | undefined,
          finishReason: 'complete' | 'tools' | 'length' = 'complete',
          usage: ModelUsage | undefined,
          responseId: string | undefined
        const calls = new Map<string, { id: string; name: string; arguments: string }>()
        const reasoningItems: Json[] = []
        const callAliases = new Map<string, string>()
        phase = 'stream'
        for await (const raw of dataEvents(response, limit, signal)) {
          if (raw === '[DONE]') {
            receivedDone = true
            continue
          }
          eventCount++
          phase = 'event-json'
          const event = object(JSON.parse(raw)),
            type = event.type
          phase = 'event'
          if (type === 'response.created') {
            responseId =
              typeof object(event.response).id === 'string'
                ? (object(event.response).id as string)
                : undefined
            continue
          }
          if (type === 'response.output_text.delta') {
            const delta = event.delta
            if (typeof delta !== 'string') return fail()
            text += delta
            yield { type: 'text-delta', text: delta }
            continue
          }
          if (type === 'response.reasoning_summary_text.delta') {
            const delta = event.delta
            if (typeof delta !== 'string') return fail()
            reasoning += delta
            yield { type: 'reasoning-delta', text: delta }
            continue
          }
          if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const item = object(event.item)
            if (type === 'response.output_item.done' && item.type === 'reasoning') {
              json(item)
              reasoningItems.push(item as Json)
            }
            if (item.type === 'function_call') {
              const callId = typeof item.call_id === 'string' ? item.call_id : ''
              const itemId = typeof item.id === 'string' ? item.id : ''
              const id = callId || itemId
              const name = typeof item.name === 'string' ? item.name : ''
              if (!id || !name) return fail()
              if (itemId) callAliases.set(itemId, id)
              if (callId) callAliases.set(callId, id)
              const prior = calls.get(id) ?? { id, name, arguments: '' }
              if (typeof item.arguments === 'string') prior.arguments = item.arguments
              calls.set(id, prior)
            }
            continue
          }
          if (type === 'response.function_call_arguments.delta') {
            const delta = event.delta
            if (typeof delta !== 'string') return fail()
            const rawId =
              typeof event.item_id === 'string'
                ? event.item_id
                : typeof event.call_id === 'string'
                  ? event.call_id
                  : ''
            const id = callAliases.get(rawId) ?? rawId
            const prior = calls.get(id) ?? { id, name: '', arguments: '' }
            prior.arguments += delta
            calls.set(id, prior)
            yield {
              type: 'tool-delta',
              index: calls.size - 1,
              arguments: delta,
              id: prior.id,
              ...(prior.name ? { name: prior.name } : {})
            }
            continue
          }
          if (type === 'response.completed' || type === 'response.incomplete') {
            const response = object(event.response)
            const status =
              type === 'response.completed'
                ? 'completed'
                : object(response.incomplete_details).reason
            if (status === 'content_filter') throw new ResponsesError('limit')
            receivedCompletion = true
            finish = true
            finishReason =
              status === 'max_output_tokens' ? 'length' : calls.size ? 'tools' : 'complete'
            const value = response.usage
            if (value) {
              const u = object(value)
              const details = u.input_tokens_details
              const cached =
                details && typeof details === 'object' && !Array.isArray(details)
                  ? (details as Record<string, unknown>).cached_tokens
                  : undefined
              usage = {
                inputTokens: count(u.input_tokens),
                outputTokens: count(u.output_tokens),
                ...(cached === undefined ? {} : { cacheReadTokens: count(cached) })
              }
            }
            continue
          }
          if (type === 'response.failed' || type === 'error') {
            phase = 'provider'
            const detail = object(
              type === 'response.failed' ? object(event.response).error : (event.error ?? event)
            )
            source = 'provider-stream'
            // Only known codes cross the adapter boundary; provider prose can contain private data.
            const codes = [detail.code, detail.type]
            if (
              codes.some((code) =>
                [
                  'insufficient_quota',
                  'quota_exceeded',
                  'usage_limit_reached',
                  'subscription_sharing_usage_limit_exceeded',
                  'billing_error'
                ].includes(String(code))
              )
            )
              throw new ResponsesError('insufficient_quota')
            if (
              codes.some((code) =>
                ['rate_limit_exceeded', 'rate_limit_error'].includes(String(code))
              )
            )
              throw new ResponsesError('rate_limit_exceeded', 429)
            if (
              codes.some((code) => ['model_not_found', 'model_unavailable'].includes(String(code)))
            )
              throw new ResponsesError('model_not_found', 404)
            if (
              codes.some((code) =>
                [
                  'authentication_error',
                  'invalid_api_key',
                  'unauthorized',
                  'token_expired'
                ].includes(String(code))
              )
            )
              throw new ResponsesError('authentication_error', 401)
            throw new ResponsesError('provider')
          }
        }
        phase = 'missing-completion'
        if (!finish) return fail()
        phase = 'tool-arguments'
        const finalCalls: ToolCall[] = []
        if (finishReason === 'tools') {
          for (const call of calls.values()) {
            if (!call.name) return fail()
            const args = JSON.parse(call.arguments)
            json(args)
            finalCalls.push({ id: call.id, name: call.name, arguments: args })
          }
        }
        yield {
          type: 'finish',
          reason: finishReason,
          content: text ? [{ type: 'text', text }] : [],
          ...(finalCalls.length ? { calls: finalCalls } : {}),
          ...(usage ? { usage } : {}),
          ...(reasoning || responseId || reasoningItems.length
            ? {
                providerState: {
                  ...(reasoning ? { reasoning_content: reasoning } : {}),
                  ...(responseId ? { response_id: responseId } : {}),
                  ...(reasoningItems.length ? { reasoning_items: reasoningItems } : {})
                }
              }
            : {})
        }
      } catch (error) {
        signal.throwIfAborted()
        // The shared SSE reader uses ChatCompletionsError; retain the actual adapter identity.
        const readerError = error instanceof ChatCompletionsError
        if (error instanceof ResponsesError || error instanceof SyntaxError || readerError) {
          throw new ResponsesError(
            error instanceof ResponsesError
              ? error.code
              : readerError && error.code === 'limit'
                ? 'limit'
                : 'protocol',
            error instanceof ResponsesError ? error.status : undefined,
            {
              phase: readerError ? 'stream' : phase,
              ...(source ? { source } : {}),
              ...(requestId ? { requestId } : {}),
              ...(httpStatus === undefined ? {} : { httpStatus }),
              eventCount,
              receivedDone,
              receivedCompletion
            }
          )
        }
        throw error
      }
    }
  }
}
