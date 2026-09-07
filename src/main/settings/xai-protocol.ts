import { Tiktoken } from 'js-tiktoken/lite'
import o200kBase from 'js-tiktoken/ranks/o200k_base'
import type { ProviderType } from '../../shared/settings'

type Json = Record<string, unknown>

const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) =>
      object(part) &&
      (part.type === 'text' || part.type === 'input_text') &&
      typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('')
}

const contentParts = (content: unknown): unknown => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (!object(part)) return part
    if (part.type === 'text') return { type: 'input_text', text: part.text }
    if (part.type === 'image_url' && object(part.image_url)) {
      return { type: 'input_image', image_url: part.image_url.url }
    }
    if (part.type === 'image' && object(part.source) && part.source.type === 'url') {
      return { type: 'input_image', image_url: part.source.url }
    }
    if (part.type === 'image' && object(part.source) && part.source.type === 'base64') {
      return {
        type: 'input_image',
        image_url: `data:${String(part.source.media_type)};base64,${String(part.source.data)}`
      }
    }
    return part
  })
}

export const sanitizeXaiResponsesRequest = (body: Json): Json => {
  // Unsupported request metadata is top-level. Schemas and tool output are opaque business data.
  const sanitized = Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        value !== null &&
        key !== 'prompt_cache_retention' &&
        key !== 'safety_identifier' &&
        key !== 'external_web_access'
    )
  )
  if (Array.isArray(sanitized.additional_tools)) {
    sanitized.tools = [
      ...(Array.isArray(sanitized.tools) ? sanitized.tools : []),
      ...sanitized.additional_tools
    ]
    delete sanitized.additional_tools
  }
  return sanitized
}

export const xaiNativeResponsesTargetFields = (
  providerType: ProviderType,
  resolveKey: ((forceRefresh?: boolean) => Promise<string>) | undefined
): {
  resolveKey?: (forceRefresh?: boolean) => Promise<string>
  sanitizeRequest?: typeof sanitizeXaiResponsesRequest
} =>
  providerType === 'xai-subscription'
    ? { resolveKey, sanitizeRequest: sanitizeXaiResponsesRequest }
    : {}

export const anthropicToResponses = (body: Json, model: string): Json => {
  const instructions = textOf(body.system)
  const input: unknown[] = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!object(message) || typeof message.role !== 'string') continue
    if (typeof message.content === 'string') {
      if (message.content.length > 0) {
        input.push({ role: message.role, content: message.content })
      }
      continue
    }
    const parts = Array.isArray(message.content) ? message.content : [message.content]
    const messageContent: unknown[] = []
    for (const part of parts) {
      if (!object(part)) {
        messageContent.push(part)
      } else if (part.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        })
      } else if (part.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: part.tool_use_id,
          output: textOf(part.content)
        })
        if (Array.isArray(part.content)) {
          const media: unknown[] = []
          for (const resultPart of part.content) {
            if (!object(resultPart)) throw new Error('Unsupported tool result content.')
            if (resultPart.type === 'text' || resultPart.type === 'input_text') continue
            const converted = contentParts([resultPart])
            const image = Array.isArray(converted) ? converted[0] : undefined
            if (
              !object(image) ||
              image.type !== 'input_image' ||
              typeof image.image_url !== 'string'
            ) {
              throw new Error('Unsupported tool result image content.')
            }
            media.push(image)
          }
          if (media.length > 0) {
            messageContent.push(
              { type: 'input_text', text: `Images from tool call ${String(part.tool_use_id)}:` },
              ...media
            )
          }
        }
      } else {
        const converted = contentParts([part])
        messageContent.push(Array.isArray(converted) ? converted[0] : part)
      }
    }
    if (messageContent.length > 0) {
      input.push({ role: message.role, content: messageContent })
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) =>
        object(tool) && typeof tool.name === 'string'
          ? [
              {
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
                strict: false
              }
            ]
          : []
      )
    : undefined
  return sanitizeXaiResponsesRequest({
    model,
    stream: false,
    ...(instructions ? { instructions } : {}),
    input,
    ...(tools ? { tools } : {}),
    ...(typeof body.max_tokens === 'number' ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  })
}

export const chatToResponses = (body: Json, model: string): Json => {
  const input: unknown[] = []
  const instructions: string[] = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!object(message) || typeof message.role !== 'string') continue
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(textOf(message.content))
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textOf(message.content)
      })
      continue
    }
    const converted = contentParts(message.content)
    if (
      converted != null &&
      converted !== '' &&
      !(Array.isArray(converted) && converted.length === 0)
    ) {
      input.push({ role: message.role, content: converted })
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!object(call) || !object(call.function)) continue
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        })
      }
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) =>
        object(tool) && object(tool.function)
          ? [{ type: 'function', ...tool.function, strict: false }]
          : []
      )
    : undefined
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  const toolChoice = body.tool_choice
  const responsesToolChoice =
    toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required'
      ? toolChoice
      : object(toolChoice) &&
          object(toolChoice.function) &&
          typeof toolChoice.function.name === 'string'
        ? { type: 'function', name: toolChoice.function.name }
        : undefined
  return sanitizeXaiResponsesRequest({
    model,
    stream: false,
    ...(instructions.some(Boolean)
      ? { instructions: instructions.filter(Boolean).join('\n\n') }
      : {}),
    input,
    ...(tools ? { tools } : {}),
    ...(responsesToolChoice ? { tool_choice: responsesToolChoice } : {}),
    ...(typeof body.max_completion_tokens === 'number'
      ? { max_output_tokens: body.max_completion_tokens }
      : typeof body.max_tokens === 'number'
        ? { max_output_tokens: body.max_tokens }
        : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  })
}

const outputs = (response: Json): Json[] =>
  Array.isArray(response.output) ? response.output.filter(object) : []

const responseText = (response: Json): string =>
  outputs(response)
    .flatMap((item) => (item.type === 'message' && Array.isArray(item.content) ? item.content : []))
    .filter(object)
    .flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
    .join('')

const responseCalls = (response: Json): Json[] =>
  outputs(response).filter((item) => item.type === 'function_call')

const usage = (response: Json): Json => (object(response.usage) ? response.usage : {})

const responseFinishReason = (response: Json): 'length' | 'content_filter' | undefined => {
  if (response.status === 'incomplete') {
    const reason = object(response.incomplete_details)
      ? response.incomplete_details.reason
      : undefined
    if (reason === 'max_output_tokens') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    throw new Error('Upstream response is incomplete for an unsupported reason.')
  }
  // Older compatible providers omit status. Explicit nonterminal/failed statuses are not success.
  if (response.status != null && response.status !== 'completed') {
    throw new Error('Upstream response did not complete successfully.')
  }
  return undefined
}

export const responsesToAnthropic = (response: Json, model: string): Json => {
  const finishReason = responseFinishReason(response)
  const content: Json[] = []
  const text = responseText(response)
  if (text) content.push({ type: 'text', text })
  for (const call of responseCalls(response)) {
    let input: unknown
    try {
      input = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : undefined
    } catch {
      throw new Error('Upstream tool arguments must be a valid JSON object.')
    }
    if (!object(input)) throw new Error('Upstream tool arguments must be a valid JSON object.')
    content.push({ type: 'tool_use', id: call.call_id ?? call.id, name: call.name, input })
  }
  const counts = usage(response)
  return {
    id: response.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason:
      finishReason === 'length'
        ? 'max_tokens'
        : finishReason === 'content_filter'
          ? 'refusal'
          : responseCalls(response).length > 0
            ? 'tool_use'
            : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: counts.input_tokens ?? 0,
      output_tokens: counts.output_tokens ?? 0
    }
  }
}

export const responsesToChat = (response: Json, model: string): Json => {
  const finishReason = responseFinishReason(response)
  const calls = responseCalls(response)
  const counts = usage(response)
  const inputDetails = object(counts.input_tokens_details) ? counts.input_tokens_details : {}
  const outputDetails = object(counts.output_tokens_details) ? counts.output_tokens_details : {}
  return {
    id: response.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: responseText(response) || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((call, index) => ({
                  id: call.call_id ?? call.id,
                  type: 'function',
                  index,
                  function: { name: call.name, arguments: call.arguments ?? '{}' }
                }))
              }
            : {})
        },
        finish_reason: finishReason ?? (calls.length ? 'tool_calls' : 'stop')
      }
    ],
    usage: {
      prompt_tokens: counts.input_tokens ?? 0,
      completion_tokens: counts.output_tokens ?? 0,
      total_tokens: Number(counts.input_tokens ?? 0) + Number(counts.output_tokens ?? 0),
      ...(typeof inputDetails.cached_tokens === 'number'
        ? { prompt_tokens_details: { cached_tokens: inputDetails.cached_tokens } }
        : {}),
      ...(typeof outputDetails.reasoning_tokens === 'number'
        ? { completion_tokens_details: { reasoning_tokens: outputDetails.reasoning_tokens } }
        : {})
    }
  }
}

let tokenizer: Tiktoken | undefined
export const countAnthropicInputTokens = (body: Json): number => {
  tokenizer ??= new Tiktoken(o200kBase)
  return tokenizer.encode(
    JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })
  ).length
}
