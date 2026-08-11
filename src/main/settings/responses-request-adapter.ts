import { createLogger } from '../logger'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type {
  CustomReasoningEffortTransport,
  ModelReasoningEffort
} from '../../shared/reasoning-effort'
import { resolveChatReasoningTransport } from './reasoning-transport'
import type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'

// Responses and Chat Completions payloads are open-ended at this protocol seam. The adapter validates
// the supported subset before producing an upstream request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

const log = createLogger('acp-bridge')

export type ResponsesRequestAdapterOptions = {
  reasoningEffortOverride?: ModelReasoningEffort
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
}

const ALLOWED_INCLUDE_VALUES = new Set(['reasoning.encrypted_content'])
const ALLOWED_REASONING_KEYS = new Set(['effort', 'summary'])
const ALLOWED_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const ALLOWED_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed'])
const ALLOWED_IMAGE_DETAILS = new Set(['auto', 'low', 'high'])

const UNSUPPORTED_FIELDS = [
  'previous_response_id',
  'conversation',
  'background',
  'prompt',
  'context_management'
] as const

// Known Codex Responses items with no Chat Completions message representation are intentionally
// skipped. Unknown history is rejected so the adapter never silently loses a turn dependency.
const KNOWN_SKIPPABLE_ITEM_TYPES = new Set([
  'reasoning',
  'additional_tools',
  'tool_search_call',
  'tool_search_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'web_search_call',
  'image_generation_call',
  'compaction',
  'compaction_trigger',
  'context_compaction',
  'local_shell_call',
  'internal_chat_message_metadata_passthrough'
])

// Chat Completions accepts only function tools. These known Responses-native declarations have no
// equivalent and are dropped; unknown declarations remain hard errors.
const FILTERABLE_TOOL_TYPES = new Set([
  'namespace',
  'mcp',
  'web_search',
  'web_search_preview',
  'file_search',
  'code_interpreter',
  'computer_use_preview',
  'image_generation',
  'local_shell',
  'custom',
  'tool_search'
])

const FILTERABLE_FUNCTION_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
])

const imageUrlFromPart = (part: JsonObject): JsonObject => {
  if (part.file_id !== undefined && part.file_id !== null) {
    throw new Error('Responses image file_id is not supported by this gateway')
  }

  const imageUrl = part.image_url
  const url = typeof imageUrl === 'object' && imageUrl !== null ? imageUrl.url : imageUrl
  const nestedDetail =
    typeof imageUrl === 'object' && imageUrl !== null ? imageUrl.detail : undefined
  if (part.detail !== undefined && nestedDetail !== undefined && part.detail !== nestedDetail) {
    throw new Error('Responses image detail values must not conflict')
  }
  const detail = part.detail ?? nestedDetail

  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Responses image_url must be a non-empty string')
  }
  if (detail !== undefined && !ALLOWED_IMAGE_DETAILS.has(String(detail))) {
    throw new Error(`Unsupported Responses image detail: ${String(detail)}`)
  }

  if (url.startsWith('data:')) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/i.exec(url)
    if (!match || match[1].length % 4 !== 0) {
      throw new Error('Responses image data URL must contain valid base64 image data')
    }
  } else {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Responses image_url must be an absolute HTTP(S) or image data URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Responses image_url must use HTTP(S) or an image data URL')
    }
  }

  return {
    type: 'image_url',
    image_url: { url, ...(detail === undefined ? {} : { detail }) }
  }
}

const textFromContent = (content: unknown): string | JsonObject[] => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      throw new Error('Responses content parts must be objects')
    }
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new Error(`Responses ${String(part.type)} content must contain string text`)
      }
      return { type: 'text', text: part.text }
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      return imageUrlFromPart(part)
    }
    throw new Error(`Unsupported Responses content part: ${String(part.type)}`)
  })
}

const namespacedToolAlias = (
  tool: Pick<ResponsesBridgeNamespacedTool, 'namespace' | 'name'>
): string => `${tool.namespace}__${tool.name}`

const chatToolName = (
  item: JsonObject,
  tools: readonly ResponsesBridgeNamespacedTool[]
): string => {
  if (typeof item.namespace !== 'string' || item.namespace.length === 0) {
    return String(item.name ?? '')
  }

  const match = tools.find(
    (tool) => tool.namespace === item.namespace && tool.name === String(item.name ?? '')
  )
  return match ? namespacedToolAlias(match) : `${item.namespace}__${String(item.name ?? '')}`
}

export const inputToMessages = (
  body: JsonObject,
  reasoningByCallId?: Map<string, string>,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = []
): JsonObject[] => {
  const messages: JsonObject[] = []
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input =
    typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: body.input }]
      : body.input
  if (!Array.isArray(input)) return messages

  const droppedItemTypes = new Set<string>()
  let pendingToolCalls: JsonObject[] = []
  let pendingReasoning: string | undefined
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    messages.push({
      role: 'assistant',
      ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
      tool_calls: pendingToolCalls
    })
    pendingToolCalls = []
    pendingReasoning = undefined
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('Responses input items must be objects')
    if (item.type === 'function_call') {
      const callId = item.call_id ?? item.id
      const reasoning = reasoningByCallId?.get(String(callId))
      if (reasoning && !pendingReasoning) pendingReasoning = reasoning
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: { name: chatToolName(item, namespacedTools), arguments: item.arguments ?? '{}' }
      })
    } else if (item.type === 'message') {
      flushToolCalls()
      const role = item.role === 'developer' ? 'system' : (item.role ?? 'user')
      if (!['system', 'user', 'assistant'].includes(role)) {
        throw new Error(`Unsupported Responses message role: ${String(item.role)}`)
      }
      messages.push({ role, content: textFromContent(item.content) })
    } else if (item.type === 'function_call_output') {
      flushToolCalls()
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      })
    } else if (KNOWN_SKIPPABLE_ITEM_TYPES.has(String(item.type))) {
      droppedItemTypes.add(String(item.type))
    } else {
      throw new Error(`Unsupported Responses input item: ${String(item.type)}`)
    }
  }
  flushToolCalls()

  if (droppedItemTypes.size > 0) {
    log.info('bridge dropped non-representable input items', {
      droppedTypes: [...droppedItemTypes]
    })
  }

  const systemMessages = messages.filter((message) => message.role === 'system')
  if (systemMessages.length <= 1) return messages

  const systemText = systemMessages
    .map((message) => {
      if (typeof message.content === 'string') return message.content
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => (typeof part === 'object' ? String(part.text ?? '') : String(part)))
          .join('')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')

  return [
    { role: 'system', content: systemText },
    ...messages.filter((message) => message.role !== 'system')
  ]
}

export const toolsToChat = (
  tools: unknown,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = []
): JsonObject[] | undefined => {
  if (tools === undefined) return undefined
  if (!Array.isArray(tools)) throw new Error('Responses tools must be an array')

  const dropped = new Set<string>()
  const droppedFunctions = new Set<string>()
  const converted = tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || typeof tool.type !== 'string') {
      throw new Error('Responses tools must have a supported type')
    }
    const responseTool = tool as JsonObject
    if (
      responseTool.type === 'function' &&
      FILTERABLE_FUNCTION_NAMES.has(String(responseTool.name))
    ) {
      droppedFunctions.add(String(responseTool.name))
      return []
    }
    if (responseTool.type !== 'function') {
      if (!FILTERABLE_TOOL_TYPES.has(responseTool.type)) {
        throw new Error(`Unsupported Responses tool type: ${responseTool.type}`)
      }
      dropped.add(responseTool.type)
      return []
    }
    return {
      type: 'function',
      function: {
        name: responseTool.name,
        description: responseTool.description,
        parameters: responseTool.parameters,
        ...(responseTool.strict === undefined ? {} : { strict: responseTool.strict })
      }
    }
  })
  for (const tool of namespacedTools) {
    converted.push({
      type: 'function',
      function: {
        name: namespacedToolAlias(tool),
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.strict === undefined ? {} : { strict: tool.strict })
      }
    })
  }
  if (dropped.size > 0) {
    log.info('bridge dropped non-function tools', { droppedTypes: [...dropped] })
  }
  if (droppedFunctions.size > 0) {
    log.info('bridge dropped MCP resource browser functions', {
      droppedNames: [...droppedFunctions]
    })
  }
  return converted
}

const toolChoiceToChat = (toolChoice: unknown): unknown => {
  if (toolChoice === undefined || toolChoice === null) return toolChoice
  if (typeof toolChoice === 'string') {
    if (!['auto', 'none', 'required'].includes(toolChoice)) {
      throw new Error(`Unsupported Responses tool_choice: ${toolChoice}`)
    }
    return toolChoice
  }
  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    (toolChoice as JsonObject).type === 'function' &&
    typeof (toolChoice as JsonObject).name === 'string'
  ) {
    return { type: 'function', function: { name: (toolChoice as JsonObject).name } }
  }
  throw new Error('Only function tool_choice values are supported by the Chat Completions bridge')
}

export const responsesToChatRequest = (
  body: JsonObject,
  upstreamModel?: string,
  reasoningByCallId?: Map<string, string>,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = [],
  options?: ResponsesRequestAdapterOptions
): JsonObject => {
  for (const field of UNSUPPORTED_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new Error(`Responses field "${field}" is not supported by this gateway`)
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new Error('Responses stream must be a boolean')
  }
  if (body.include !== undefined && body.include !== null) {
    if (!Array.isArray(body.include)) throw new Error('Responses include must be an array')
    for (const value of body.include) {
      if (typeof value !== 'string' || !ALLOWED_INCLUDE_VALUES.has(value)) {
        throw new Error(
          `Responses include value is not supported by this gateway: ${String(value)}`
        )
      }
    }
  }
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) {
      throw new Error('Responses reasoning must be an object')
    }
    for (const key of Object.keys(body.reasoning)) {
      if (!ALLOWED_REASONING_KEYS.has(key)) {
        throw new Error(`Responses reasoning field is not supported by this gateway: ${key}`)
      }
    }
    const effort = body.reasoning.effort
    if (effort !== undefined && effort !== null && !ALLOWED_REASONING_EFFORTS.has(String(effort))) {
      throw new Error(`Unsupported Responses reasoning effort: ${String(effort)}`)
    }
    const summary = body.reasoning.summary
    if (
      summary !== undefined &&
      summary !== null &&
      !ALLOWED_REASONING_SUMMARIES.has(String(summary))
    ) {
      throw new Error(`Unsupported Responses reasoning summary: ${String(summary)}`)
    }
  }
  if (body.store !== undefined && body.store !== false && body.store !== null) {
    throw new Error('Stored Responses are not supported by this gateway')
  }
  if (
    body.prompt_cache_key !== undefined &&
    body.prompt_cache_key !== null &&
    typeof body.prompt_cache_key !== 'string'
  ) {
    throw new Error('Responses prompt_cache_key must be a string')
  }
  if (
    body.max_output_tokens !== undefined &&
    body.max_output_tokens !== null &&
    typeof body.max_output_tokens !== 'number'
  ) {
    throw new Error('Responses max_output_tokens must be a number')
  }

  const tools = toolsToChat(body.tools ?? [], namespacedTools)
  const hasTools = Boolean(tools && tools.length > 0)
  const requestedToolChoice =
    body.tool_choice === undefined ? undefined : toolChoiceToChat(body.tool_choice)
  const toolChoice = hasTools ? requestedToolChoice : undefined
  const stream = body.stream !== false
  const chatReasoningEffort = options?.reasoningEffortOverride
  const reasoningTransport = chatReasoningEffort
    ? resolveChatReasoningTransport(
        options?.vendorId,
        upstreamModel,
        chatReasoningEffort,
        options?.reasoningEffortTransport
      )
    : undefined

  return {
    model: upstreamModel ?? body.model,
    messages: inputToMessages(body, reasoningByCallId, namespacedTools),
    ...(hasTools ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(!hasTools || body.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: body.parallel_tool_calls }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    ...(body.max_output_tokens === undefined || body.max_output_tokens === null
      ? {}
      : { max_tokens: body.max_output_tokens }),
    ...(reasoningTransport?.reasoningEffort
      ? { reasoning_effort: reasoningTransport.reasoningEffort }
      : {}),
    ...(reasoningTransport?.thinking ? { thinking: reasoningTransport.thinking } : {}),
    ...(reasoningTransport?.reasoning ? { reasoning: reasoningTransport.reasoning } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {})
  }
}
