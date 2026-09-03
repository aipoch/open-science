import { randomBytes } from 'node:crypto'

import { createLogger } from '../logger'
import { consumeBoundedResponseBody, DEFAULT_MAX_PROVIDER_RESPONSE_BYTES } from './bounded-response'
import type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'

// Upstream protocol payloads are open-ended and validated at this response seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

const log = createLogger('acp-bridge')

export type ResponsesStreamWriter = {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(): void
}

export class ResponsesProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string
  ) {
    super(message)
    this.name = 'ResponsesProtocolError'
  }
}

const UPSTREAM_IMAGE_TYPES = new Set(['image', 'image_url', 'input_image', 'output_image'])

const unsupportedUpstreamImageOutput = (): ResponsesProtocolError =>
  new ResponsesProtocolError(
    'Upstream image output is not supported by this gateway',
    502,
    'unsupported_upstream_output'
  )

export const upstreamErrorMessage = (body: string, status: number): string => {
  const trimmed = body.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as JsonObject
      const error = parsed.error
      if (typeof error === 'string') return error
      if (error && typeof error === 'object' && typeof error.message === 'string') {
        return error.message
      }
      if (typeof parsed.message === 'string') return parsed.message
    } catch {
      return trimmed.slice(0, 500)
    }
  }

  return `Chat Completions upstream returned ${status}`
}

const upstreamTextFromContent = (content: unknown): string => {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (
    typeof content === 'object' &&
    UPSTREAM_IMAGE_TYPES.has(String((content as JsonObject).type))
  ) {
    throw unsupportedUpstreamImageOutput()
  }
  if (!Array.isArray(content)) {
    throw new ResponsesProtocolError(
      'Unsupported upstream message content',
      502,
      'unsupported_upstream_output'
    )
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        throw new ResponsesProtocolError(
          'Unsupported upstream message content part',
          502,
          'unsupported_upstream_output'
        )
      }
      if (UPSTREAM_IMAGE_TYPES.has(String(part.type))) throw unsupportedUpstreamImageOutput()
      if (part.type !== 'text' && part.type !== 'output_text') {
        throw new ResponsesProtocolError(
          `Unsupported upstream message content part: ${String(part.type)}`,
          502,
          'unsupported_upstream_output'
        )
      }
      if (typeof part.text !== 'string') {
        throw new ResponsesProtocolError(
          'Upstream text output must contain string text',
          502,
          'unsupported_upstream_output'
        )
      }
      return part.text
    })
    .join('')
}

const hasUpstreamImageField = (value: JsonObject): boolean =>
  (Array.isArray(value.images) && value.images.length > 0) ||
  value.image !== undefined ||
  value.image_url !== undefined ||
  value.output_image !== undefined

const responseFunctionIdentity = (
  chatName: unknown,
  tools: readonly ResponsesBridgeNamespacedTool[]
): { name: string; namespace?: string } => {
  const name = String(chatName ?? '')
  const namespaced = tools.find((tool) => `${tool.namespace}__${tool.name}` === name)
  return namespaced ? { name: namespaced.name, namespace: namespaced.namespace } : { name }
}

const responseEnvelope = (
  id: string,
  model: string,
  output: JsonObject[],
  usage?: unknown,
  status: string = 'completed',
  error: unknown = null
): JsonObject => ({
  id,
  object: 'response',
  created_at: Math.floor(Date.now() / 1000),
  status,
  error,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: null,
  model,
  output,
  parallel_tool_calls: true,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: false,
  temperature: null,
  text: { format: { type: 'text' } },
  tool_choice: 'auto',
  tools: [],
  top_p: null,
  truncation: 'disabled',
  usage: usage ?? null,
  user: null,
  metadata: {}
})

const chatUsageToResponsesUsage = (usage: unknown): JsonObject | undefined => {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined

  const chatUsage = usage as JsonObject
  const tokenCount = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const inputTokens = tokenCount(chatUsage.prompt_tokens)
  const outputTokens = tokenCount(chatUsage.completion_tokens)

  if (inputTokens === undefined || outputTokens === undefined) return undefined

  const cachedTokens = tokenCount(chatUsage.prompt_tokens_details?.cached_tokens) ?? 0
  const reasoningTokens = tokenCount(chatUsage.completion_tokens_details?.reasoning_tokens) ?? 0

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: tokenCount(chatUsage.total_tokens) ?? inputTokens + outputTokens
  }
}

export const completionToResponse = (
  completion: JsonObject,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = []
): JsonObject => {
  const message = completion.choices?.[0]?.message ?? {}
  const output: JsonObject[] = []
  if (hasUpstreamImageField(message)) throw unsupportedUpstreamImageOutput()
  const contentText = upstreamTextFromContent(message.content)
  const text =
    contentText.length > 0
      ? contentText
      : typeof message.refusal === 'string' && message.refusal.length > 0
        ? message.refusal
        : ''
  if (text) {
    output.push({
      id: `msg_${completion.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  for (const tool of message.tool_calls ?? []) {
    const identity = responseFunctionIdentity(tool.function?.name, namespacedTools)
    output.push({
      id: `fc_${tool.id}`,
      type: 'function_call',
      status: 'completed',
      call_id: tool.id,
      ...identity,
      arguments: tool.function?.arguments ?? '{}'
    })
  }
  return responseEnvelope(
    completion.id ?? `resp_${randomBytes(6).toString('hex')}`,
    completion.model,
    output,
    chatUsageToResponsesUsage(completion.usage)
  )
}

const writeEvent = (
  response: ResponsesStreamWriter,
  type: string,
  sequence: number,
  fields: JsonObject = {}
): void => {
  response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...fields })}\n\n`
  )
}

export const streamChatToResponses = async (
  upstream: Response,
  response: ResponsesStreamWriter,
  model: string,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = [],
  maxResponseBytes = DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
): Promise<{ reasoning: string; callIds: string[] }> => {
  if (!upstream.body) throw new Error('Chat Completions upstream returned no body')
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })

  const responseId = `resp_${randomBytes(8).toString('hex')}`
  const output: JsonObject[] = []
  const toolItems = new Map<number, { chatId: string; chatName: string; item?: JsonObject }>()
  let textItem: JsonObject | undefined
  let reasoning = ''
  let usage: JsonObject | undefined
  let sequence = 0
  writeEvent(response, 'response.created', sequence++, {
    response: responseEnvelope(responseId, model, [])
  })
  writeEvent(response, 'response.in_progress', sequence++, {
    response: responseEnvelope(responseId, model, [])
  })

  const decoder = new TextDecoder()
  let buffered = ''
  let terminalFinishReason: string | undefined
  let sawDone = false
  const ensureToolItem = (index: number): JsonObject => {
    const state = toolItems.get(index) ?? { chatId: '', chatName: '' }
    toolItems.set(index, state)
    if (state.item) return state.item

    const identity = responseFunctionIdentity(state.chatName, namespacedTools)
    const callId = state.chatId || `call_${responseId}_${index}`
    const item: JsonObject = {
      id: `fc_${callId}_${index}`,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      ...identity,
      arguments: ''
    }
    state.item = item
    output.push(item)
    writeEvent(response, 'response.output_item.added', sequence++, {
      output_index: output.indexOf(item),
      item
    })
    return item
  }
  const consume = (chunk: JsonObject): void => {
    usage = chatUsageToResponsesUsage(chunk.usage) ?? usage
    const finishReason = chunk.choices?.[0]?.finish_reason
    if (typeof finishReason === 'string' && finishReason.length > 0) {
      terminalFinishReason = finishReason
    }
    const delta = chunk.choices?.[0]?.delta ?? {}
    if (hasUpstreamImageField(delta)) throw unsupportedUpstreamImageOutput()
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    const contentText = upstreamTextFromContent(delta.content)
    const textDelta =
      contentText.length > 0
        ? contentText
        : typeof delta.refusal === 'string' && delta.refusal.length > 0
          ? delta.refusal
          : ''
    if (textDelta) {
      if (!textItem) {
        textItem = {
          id: `msg_${responseId}`,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: []
        }
        output.push(textItem)
        writeEvent(response, 'response.output_item.added', sequence++, {
          output_index: output.length - 1,
          item: textItem
        })
        writeEvent(response, 'response.content_part.added', sequence++, {
          item_id: textItem.id,
          output_index: output.length - 1,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] }
        })
      }
      writeEvent(response, 'response.output_text.delta', sequence++, {
        item_id: textItem.id,
        output_index: output.indexOf(textItem),
        content_index: 0,
        delta: textDelta
      })
      textItem.content.push({ type: 'output_text', text: textDelta, annotations: [] })
    }
    for (const call of delta.tool_calls ?? []) {
      const index = Number(call.index ?? 0)
      const state = toolItems.get(index) ?? { chatId: '', chatName: '' }
      toolItems.set(index, state)
      if (typeof call.id === 'string') state.chatId += call.id
      if (typeof call.function?.name === 'string') state.chatName += call.function.name
      const argumentsDelta = call.function?.arguments ?? ''
      if (!argumentsDelta && !state.item) continue
      const item = ensureToolItem(index)
      item.arguments += argumentsDelta
      if (argumentsDelta) {
        writeEvent(response, 'response.function_call_arguments.delta', sequence++, {
          item_id: item.id,
          output_index: output.indexOf(item),
          delta: argumentsDelta
        })
      }
    }
  }

  const handleRecord = (record: string): void => {
    const data = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (data === '[DONE]') sawDone = true
    else if (data) consume(JSON.parse(data) as JsonObject)
  }

  let streamError: unknown
  try {
    await consumeBoundedResponseBody(
      upstream,
      maxResponseBytes,
      'Chat Completions upstream SSE response',
      (chunk) => {
        buffered += decoder.decode(chunk, { stream: true })
        const records = buffered.split(/\r?\n\r?\n/)
        buffered = records.pop() ?? ''
        for (const record of records) handleRecord(record)
      }
    )
    buffered += decoder.decode()
    if (buffered.trim()) handleRecord(buffered)
  } catch (error) {
    streamError = error
  }

  for (const index of toolItems.keys()) ensureToolItem(index)

  for (const item of output) {
    item.status = 'completed'
    const outputIndex = output.indexOf(item)
    if (item.type === 'message') {
      const text = item.content.map((part: JsonObject) => part.text).join('')
      item.content = [{ type: 'output_text', text, annotations: [] }]
      writeEvent(response, 'response.output_text.done', sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text
      })
      writeEvent(response, 'response.content_part.done', sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: item.content[0]
      })
    } else {
      writeEvent(response, 'response.function_call_arguments.done', sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments
      })
    }
    writeEvent(response, 'response.output_item.done', sequence++, {
      output_index: outputIndex,
      item
    })
  }
  if (streamError instanceof ResponsesProtocolError) {
    log.warn('bridge unsupported upstream output', { model, type: streamError.type })
    writeEvent(response, 'response.failed', sequence++, {
      response: responseEnvelope(responseId, model, output, undefined, 'failed', {
        type: streamError.type,
        message: streamError.message
      })
    })
  } else if (streamError) {
    log.warn('bridge stream error', {
      model,
      error: streamError instanceof Error ? streamError.message : String(streamError)
    })
    writeEvent(response, 'response.failed', sequence++, {
      response: responseEnvelope(responseId, model, output, usage, 'failed', {
        type: 'upstream_error',
        message: 'Upstream stream ended before completion'
      })
    })
  } else if (terminalFinishReason === 'stop' || terminalFinishReason === 'tool_calls') {
    writeEvent(response, 'response.completed', sequence++, {
      response: responseEnvelope(responseId, model, output, usage)
    })
  } else if (terminalFinishReason) {
    log.warn('bridge stream incomplete', { model, finishReason: terminalFinishReason })
    writeEvent(response, 'response.incomplete', sequence++, {
      response: {
        ...responseEnvelope(responseId, model, output, usage, 'incomplete'),
        incomplete_details: { reason: terminalFinishReason }
      }
    })
  } else if (sawDone) {
    writeEvent(response, 'response.completed', sequence++, {
      response: responseEnvelope(responseId, model, output, usage)
    })
  } else {
    log.warn('bridge stream truncated (no terminal finish_reason)', { model })
    writeEvent(response, 'response.failed', sequence++, {
      response: responseEnvelope(responseId, model, output, usage, 'failed', {
        type: 'upstream_incomplete',
        message: 'Upstream stream ended without a terminal finish_reason'
      })
    })
  }
  response.end()

  const toolCalls = output.filter((item) => item.type === 'function_call')
  log.info('bridge turn completed (stream)', {
    model,
    textItems: output.filter((item) => item.type === 'message').length,
    toolCalls: toolCalls.length,
    toolNames: toolCalls.map((item) => item.name)
  })

  return { reasoning, callIds: toolCalls.map((item) => String(item.call_id)) }
}
