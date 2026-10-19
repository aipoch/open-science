import { randomBytes } from 'node:crypto'

import type { ResponsesNamespacedTool } from './types'

// Upstream protocol payloads are open-ended and validated at this response seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

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

export const unsupportedUpstreamImageOutput = (): ResponsesProtocolError =>
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

export const upstreamTextFromContent = (content: unknown): string => {
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

export const hasUpstreamImageField = (value: JsonObject): boolean =>
  (Array.isArray(value.images) && value.images.length > 0) ||
  value.image !== undefined ||
  value.image_url !== undefined ||
  value.output_image !== undefined

export const responseFunctionIdentity = (
  chatName: unknown,
  tools: readonly ResponsesNamespacedTool[]
): { name: string; namespace?: string } => {
  const name = String(chatName ?? '')
  const namespaced = tools.find((tool) => `${tool.namespace}__${tool.name}` === name)
  return namespaced ? { name: namespaced.name, namespace: namespaced.namespace } : { name }
}

export const responseEnvelope = (
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

export const chatUsageToResponsesUsage = (usage: unknown): JsonObject | undefined => {
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

export const chatTerminalDetails = (
  finishReason: unknown
): { status: 'completed' | 'incomplete'; incomplete_details: { reason: string } | null } => {
  if (finishReason == null || finishReason === 'stop' || finishReason === 'tool_calls') {
    return { status: 'completed', incomplete_details: null }
  }
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return {
      status: 'incomplete',
      incomplete_details: {
        reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter'
      }
    }
  }
  throw new ResponsesProtocolError(
    'Unsupported upstream finish reason',
    502,
    'unsupported_upstream_output'
  )
}

export const completionToResponse = (
  completion: JsonObject,
  namespacedTools: readonly ResponsesNamespacedTool[] = []
): JsonObject => {
  const message = completion.choices?.[0]?.message ?? {}
  const terminal = chatTerminalDetails(completion.choices?.[0]?.finish_reason)
  const responseId = completion.id ?? `resp_${randomBytes(6).toString('hex')}`
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
      id: `msg_${responseId}`,
      type: 'message',
      status: terminal.status,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  for (const tool of message.tool_calls ?? []) {
    const identity = responseFunctionIdentity(tool.function?.name, namespacedTools)
    output.push({
      id: `fc_${tool.id}`,
      type: 'function_call',
      status: terminal.status,
      call_id: tool.id,
      ...identity,
      arguments: tool.function?.arguments ?? '{}'
    })
  }
  return {
    ...responseEnvelope(
      responseId,
      completion.model,
      output,
      chatUsageToResponsesUsage(completion.usage),
      terminal.status
    ),
    ...terminal
  }
}
