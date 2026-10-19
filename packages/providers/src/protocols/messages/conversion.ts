type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => (object(part) && typeof part.text === 'string' ? [part.text] : []))
    .join('')
}

const messagesContent = (content: unknown): unknown => {
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

export const chatCompletionsToMessages = (body: Json, model: string): Json => {
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
    const converted = messagesContent(value.content)
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
  const messagesToolChoice =
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
    ...(messagesToolChoice ? { tool_choice: messagesToolChoice } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  }
}

export const messagesToChatCompletions = (message: Json, model: string): Json => {
  if (
    message.stop_reason != null &&
    !['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'refusal'].includes(
      String(message.stop_reason)
    )
  ) {
    throw new Error('Unsupported upstream Messages stop reason.')
  }
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
  const promptTokens =
    Number(usage.input_tokens ?? 0) +
    Number(usage.cache_read_input_tokens ?? 0) +
    Number(usage.cache_creation_input_tokens ?? 0)
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
        finish_reason:
          message.stop_reason === 'max_tokens'
            ? 'length'
            : message.stop_reason === 'refusal'
              ? 'content_filter'
              : toolCalls.length > 0
                ? 'tool_calls'
                : 'stop'
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(typeof usage.cache_read_input_tokens === 'number'
        ? { prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens } }
        : {}),
      ...(typeof usage.cache_creation_input_tokens === 'number'
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
        : {})
    }
  }
}
