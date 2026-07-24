import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createLogger } from '../logger'
import { appendChatCompletions } from './base-url'

// The bridge deliberately keeps protocol payloads open-ended; validation rejects unsupported shapes
// at the boundary before values reach the upstream request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

// Diagnostics for the Codex Responses bridge. Logs the resolved upstream model, the tool translation
// (Responses tool types in → Chat function names out), and what each turn actually produced (text vs
// tool calls) so a "tools not called / task not continued" report can be traced. Never logs keys,
// prompt text, or tool arguments — only shapes, counts, names, and the model id.
const log = createLogger('acp-bridge')

export type ResponsesBridgeTarget = {
  baseUrl: string
  key?: string
  // Codex uses a catalog model for its local metadata; bridge providers may need a different
  // upstream model id (for example, DeepSeek's model name).
  model?: string
  namespacedTools?: ResponsesBridgeNamespacedTool[]
  connectorInstructions?: ResponsesBridgeConnectorInstruction[]
  // Forward reasoning.effort upstream as reasoning_effort ONLY when the user explicitly picked a
  // level. Codex emits its own default effort even when the app never configured one, so
  // unconditional forwarding would change what existing bridged users send to their gateway —
  // and gateways fronting non-OpenAI models often reject unknown parameters.
  forwardReasoningEffort?: boolean
  reviewerScope?: {
    namespacedTools: ResponsesBridgeNamespacedTool[]
  }
}

export type ResponsesBridgeNamespacedTool = {
  namespace: string
  name: string
  description?: string
  parameters: JsonObject
  strict?: boolean
}

export type ResponsesBridgeConnectorInstruction = {
  id: string
  aliases: string[]
  content: string
}

export type ResponsesBridgeConnection = {
  baseUrl: string
  token: string
}

type BridgeFetch = typeof fetch

class BridgeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string
  ) {
    super(message)
    this.name = 'BridgeHttpError'
  }
}

const ALLOWED_INCLUDE_VALUES = new Set(['reasoning.encrypted_content'])
const ALLOWED_REASONING_KEYS = new Set(['effort', 'summary'])
const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const ALLOWED_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed'])
const ALLOWED_IMAGE_DETAILS = new Set(['auto', 'low', 'high'])
const UPSTREAM_IMAGE_TYPES = new Set(['image', 'image_url', 'input_image', 'output_image'])

const unsupportedUpstreamImageOutput = (): BridgeHttpError =>
  new BridgeHttpError(
    'Upstream image output is not supported by this gateway',
    502,
    'unsupported_upstream_output'
  )

const UNSUPPORTED_FIELDS = [
  'previous_response_id',
  'conversation',
  'background',
  'prompt',
  'context_management'
] as const

// Codex built-in / auto-generated ResponseItem types that carry no Chat Completions message form and
// are safe to skip (logged). Anything outside {message, function_call, function_call_output} and this
// set is unknown history the bridge would silently discard, so it hard-errors instead (see
// inputToMessages) — that throw happens before response headers, so it surfaces as a clean 400.
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

// A Chat Completions endpoint can only accept `function` tools. These Codex built-in, Responses-native
// tool declarations (including tool_search, whose deferred-tool discovery only works against the real
// OpenAI Responses backend) have no Chat Completions representation and are safe to drop (logged). A
// tool type outside {function} and this set is unknown: the bridge hard-errors rather than silently
// dropping it, matching the MVP boundary used for unknown history items (throw before headers ⇒ 400).
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

// Codex's MCP resource browser functions enumerate resources exposed by MCP servers attached directly
// to Codex. Open Science data connectors are reached through host.mcp in the notebook instead, so these
// names are misleading in bridge mode (e.g. `mcp-pubmed` is a skill, not a Codex MCP server).
const FILTERABLE_FUNCTION_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
])

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const readBody = async (request: IncomingMessage): Promise<JsonObject> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject
}

// The upstream Chat Completions endpoint. `target.baseUrl` is already the resolved OpenAI base (an
// official vendor's exact versioned base, or a custom root normalized to `<root>/v1`), so this only
// appends `/chat/completions` — preserving any query/hash on the base.
const chatUrl = (value: string): string => appendChatCompletions(value)

const upstreamErrorMessage = (body: string, status: number): string => {
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
    throw new BridgeHttpError(
      'Unsupported upstream message content',
      502,
      'unsupported_upstream_output'
    )
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        throw new BridgeHttpError(
          'Unsupported upstream message content part',
          502,
          'unsupported_upstream_output'
        )
      }
      if (UPSTREAM_IMAGE_TYPES.has(String(part.type))) throw unsupportedUpstreamImageOutput()
      if (part.type !== 'text' && part.type !== 'output_text') {
        throw new BridgeHttpError(
          `Unsupported upstream message content part: ${String(part.type)}`,
          502,
          'unsupported_upstream_output'
        )
      }
      if (typeof part.text !== 'string') {
        throw new BridgeHttpError(
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

const plainTextFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is JsonObject => part && typeof part === 'object')
    .filter((part) => ['input_text', 'output_text', 'text'].includes(String(part.type)))
    .map((part) => String(part.text ?? ''))
    .join('\n')
}

const connectorMentioned = (text: string, alias: string): boolean => {
  const normalizedAlias = alias.trim().toLowerCase()
  if (!normalizedAlias) return false
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
}

const selectConnectorInstructions = (
  body: JsonObject,
  connectors: readonly ResponsesBridgeConnectorInstruction[]
): ResponsesBridgeConnectorInstruction[] => {
  const input =
    typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input)) return []
  // Route from the latest user turn only. Looking across the whole Responses history makes an old
  // connector mention contaminate a later, unrelated request.
  const latestUser = input.findLast(
    (item) => item && typeof item === 'object' && item.role === 'user'
  )
  const userText = latestUser ? plainTextFromContent(latestUser.content).toLowerCase() : ''
  if (!userText) return []

  return connectors.filter((connector) =>
    [connector.id, ...connector.aliases].some((alias) => connectorMentioned(userText, alias))
  )
}

const withConnectorInstructions = (
  body: JsonObject,
  connectors: readonly ResponsesBridgeConnectorInstruction[]
): { body: JsonObject; selectedIds: string[] } => {
  const selected = selectConnectorInstructions(body, connectors)
  if (selected.length === 0) return { body, selectedIds: [] }
  const connectorText = [
    '<open_science_connector_instructions>',
    'The following connector instructions are mandatory for this turn.',
    ...selected.map((connector) => connector.content),
    '</open_science_connector_instructions>'
  ].join('\n\n')
  const instructions =
    typeof body.instructions === 'string' && body.instructions.length > 0
      ? `${body.instructions}\n\n${connectorText}`
      : connectorText
  return {
    body: { ...body, instructions },
    selectedIds: selected.map((connector) => connector.id)
  }
}

const namespacedToolAlias = (
  tool: Pick<ResponsesBridgeNamespacedTool, 'namespace' | 'name'>
): string => `${tool.namespace}__${tool.name}`

const namespacedToolByAlias = (
  tools: readonly ResponsesBridgeNamespacedTool[]
): Map<string, ResponsesBridgeNamespacedTool> =>
  new Map(tools.map((tool) => [namespacedToolAlias(tool), tool]))

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

const responseFunctionIdentity = (
  chatName: unknown,
  tools: readonly ResponsesBridgeNamespacedTool[]
): { name: string; namespace?: string } => {
  const name = String(chatName ?? '')
  const namespaced = namespacedToolByAlias(tools).get(name)
  return namespaced ? { name: namespaced.name, namespace: namespaced.namespace } : { name }
}

// Thinking-mode providers (e.g. DeepSeek reasoner) reject a follow-up request whose assistant
// tool-call turn omits the reasoning_content the model produced with those calls ("the
// reasoning_content in the thinking mode must be passed back to the API"). Codex never round-trips
// that field, so the bridge caches it per tool-call id when a response is produced and re-attaches it
// here when the same call is replayed in history. Optional so plain (non-thinking) turns and unit
// tests need not supply it.
const inputToMessages = (
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
  // Chat Completions requires an assistant message with tool_calls to be immediately followed by a
  // tool message per tool_call_id. Codex emits parallel tool calls as consecutive function_call items
  // (fc_A, fc_B, output_A, output_B), so coalesce a run of function_call items into ONE assistant
  // message rather than one message each — otherwise assistant[A] is followed by assistant[B] and the
  // upstream rejects it. Flushed when a message or a tool output ends the run.
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
      // Responses uses `developer` for higher-priority instructions; Chat Completions vendors such
      // as DeepSeek generally only accept `system`, so preserve the instruction semantics with the
      // broadly supported role.
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
      // Known built-in items (reasoning, additional_tools, …) have no Chat Completions message form.
      // Skip them (logged), but do NOT flush a pending tool-call run — that would split parallel calls
      // back into separate assistant messages.
      droppedItemTypes.add(String(item.type))
    } else {
      // An unknown item type would silently discard history while still returning a "successful"
      // answer. Fail the turn instead (before headers ⇒ clean 400) so the boundary stays explicit.
      throw new Error(`Unsupported Responses input item: ${String(item.type)}`)
    }
  }
  // A run of tool calls at the very end (no trailing output yet) still emits as one assistant message.
  flushToolCalls()

  if (droppedItemTypes.size > 0) {
    log.info('bridge dropped non-representable input items', {
      droppedTypes: [...droppedItemTypes]
    })
  }

  const systemMessages = messages.filter((message) => message.role === 'system')
  if (systemMessages.length <= 1) return messages

  // Some OpenAI-compatible gateways (notably MiniMax) only accept one system message and require
  // it to be first. Responses can provide both `instructions` and developer message items, so merge
  // their text while preserving the order of every non-system message.
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

const toolsToChat = (
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
    // Known built-in types (tool_search, custom/freeform apply_patch, web_search, namespace, …) have no
    // Chat Completions equivalent; drop them (logged). tool_search in particular can't work over the
    // bridge — Codex's deferred-tool discovery is resolved server-side by the OpenAI Responses backend,
    // so forwarding it just yields tool calls Codex rejects as "unsupported". An unknown type is
    // rejected so the boundary stays explicit rather than silently discarding a tool the turn needs.
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
  options?: { forwardReasoningEffort?: boolean }
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
    // Codex requests `reasoning.encrypted_content` automatically. Chat Completions has no equivalent,
    // so the one allowlisted advisory value is intentionally omitted from the upstream request.
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
    // The summary preference has no portable Chat Completions equivalent and is omitted; the
    // effort is translated below.
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

  // Translate the Responses reasoning effort into the Chat Completions equivalent (validated above),
  // but only when the app's user explicitly picked a level: Codex also emits its own default effort,
  // and forwarding that would change what existing bridged users send upstream. OpenAI-shaped
  // gateways take `reasoning_effort`; the Codex-only 'xhigh' clamps to 'high', and 'none' is
  // omitted — Chat Completions has no "reasoning off" switch, so the upstream default stands.
  const requestedEffort =
    options?.forwardReasoningEffort &&
    body.reasoning &&
    typeof body.reasoning === 'object' &&
    !Array.isArray(body.reasoning)
      ? (body.reasoning as JsonObject).effort
      : undefined
  const chatReasoningEffort =
    requestedEffort === 'xhigh'
      ? 'high'
      : requestedEffort === 'minimal' ||
          requestedEffort === 'low' ||
          requestedEffort === 'medium' ||
          requestedEffort === 'high'
        ? requestedEffort
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
    ...(chatReasoningEffort ? { reasoning_effort: chatReasoningEffort } : {}),
    stream,
    // Responses stream options are not Chat Completions options. Request final usage explicitly and
    // do not forward fields such as include_obfuscation that a Chat-compatible gateway may reject.
    ...(stream ? { stream_options: { include_usage: true } } : {})
  }
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

// Chat Completions and Responses use different usage field names. Codex validates the Responses
// shape before publishing its ACP token-usage update, so passing Chat fields through makes usage
// silently disappear even though the upstream reported it.
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

const completionToResponse = (
  completion: JsonObject,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = []
): JsonObject => {
  const message = completion.choices?.[0]?.message ?? {}
  const output: JsonObject[] = []
  if (hasUpstreamImageField(message)) throw unsupportedUpstreamImageOutput()
  // Mirror the streaming path: drop reasoning_content (no faithful Responses representation) and fall
  // back to a refusal as the visible answer, rather than rejecting model output outright.
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
  response: ServerResponse,
  type: string,
  sequence: number,
  fields: JsonObject = {}
): void => {
  response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...fields })}\n\n`
  )
}

const streamChatToResponses = async (
  upstream: Response,
  response: ServerResponse,
  model: string,
  namespacedTools: readonly ResponsesBridgeNamespacedTool[] = []
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
  // Accumulated so the caller can cache it against this turn's tool-call ids (see inputToMessages).
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
  // Classify how the upstream stream ended so a truncation or token-limit cutoff is never reported as a
  // clean completion. `terminalFinishReason` is the last finish_reason seen; `sawDone` marks the [DONE]
  // sentinel. Neither seen ⇒ the connection dropped mid-stream.
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
    // Never throw on model output mid-stream: the turn's headers are already sent, so a throw would
    // reset the socket and reach the agent as an opaque "error decoding response body". Reasoning-model
    // providers stream `reasoning_content` deltas that have no faithful Responses representation here,
    // so drop them; a `refusal` IS the model's answer, so surface it as visible text.
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

  // A mid-stream read error (socket reset, fetch timeout) throws here. Headers are already sent, so
  // instead of letting it bubble to the server's catch — which would abruptly destroy the socket and
  // surface as an opaque "error decoding response body" — record it as a truncation and fall through
  // to emit a terminal response.failed below.
  let streamError: unknown
  try {
    for await (const chunk of upstream.body) {
      buffered += decoder.decode(chunk, { stream: true })
      // SSE records are separated by a blank line; tolerate both LF and CRLF framing.
      const records = buffered.split(/\r?\n\r?\n/)
      buffered = records.pop() ?? ''
      for (const record of records) handleRecord(record)
    }
    // Flush a trailing record not terminated by a blank line (e.g. a final `data: [DONE]`) so its
    // terminal signal is not lost.
    buffered += decoder.decode()
    if (buffered.trim()) handleRecord(buffered)
  } catch (error) {
    streamError = error
  }

  // A valid no-argument tool call may never stream an arguments delta, so materialize any buffered
  // id/name pair before completing output items.
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
  // Classification priority: an explicit clean finish_reason wins (the answer finished even if trailing
  // bytes then errored); otherwise a mid-stream error or a non-terminal finish_reason (`length`,
  // `content_filter`) is a cut-off answer; a bare [DONE] with no finish_reason still counts as a proper
  // termination; anything else means the stream dropped with no terminal signal at all.
  if (streamError instanceof BridgeHttpError) {
    log.warn('bridge unsupported upstream output', { model, type: streamError.type })
    writeEvent(response, 'response.failed', sequence++, {
      response: responseEnvelope(responseId, model, output, undefined, 'failed', {
        type: streamError.type,
        message: streamError.message
      })
    })
  } else if (terminalFinishReason === 'stop' || terminalFinishReason === 'tool_calls') {
    writeEvent(response, 'response.completed', sequence++, {
      response: responseEnvelope(responseId, model, output, usage)
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
  } else if (terminalFinishReason) {
    // A non-terminal finish_reason (e.g. `length`, `content_filter`) is a truncated answer, not a
    // complete one — surface it as incomplete so the agent doesn't treat a cut-off as a full result.
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
    // No finish_reason and no [DONE]: the upstream ended mid-stream without a terminal signal.
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

export class ResponsesBridge {
  private server: Server | undefined
  private connection: ResponsesBridgeConnection | undefined
  private target: ResponsesBridgeTarget
  // reasoning_content produced with each tool call, keyed by call_id, so a follow-up request can pass
  // it back to thinking-mode providers that require it. Grows within a session; cleared on close (a
  // provider switch / disconnect). Keyed by call_id, which Codex round-trips, so lookups stay stable.
  private readonly reasoningByCallId = new Map<string, string>()
  private readonly reviewerSessionKeys = new Set<string>()
  private readonly scopedReviewerSessionKeys = new Set<string>()

  constructor(
    target: ResponsesBridgeTarget,
    private readonly fetchImpl: BridgeFetch = fetch
  ) {
    this.target = target
  }

  setTarget(target: ResponsesBridgeTarget): void {
    // Clear the reasoning cache only when the upstream target actually changes. setTarget is also
    // called on same-provider reconnects (skill reload, session resume); clearing then would drop the
    // reasoning_content a resumed thinking-mode session still needs to replay. On a real provider
    // switch the old provider's reasoning must not leak into the new one.
    const changed =
      this.target.baseUrl !== target.baseUrl ||
      this.target.model !== target.model ||
      this.target.key !== target.key
    this.target = target
    if (changed) this.reasoningByCallId.clear()
  }

  // Updates only the effort-forwarding policy on the live target, for when the user's reasoning-effort
  // setting changes without a reconnect (Codex applies level changes live over ACP). Deliberately not
  // a setTarget: the upstream provider is unchanged, so the reasoning cache must be preserved.
  setForwardReasoningEffort(forward: boolean): void {
    this.target = { ...this.target, forwardReasoningEffort: forward }
  }

  registerReviewerSession(promptCacheKey: string): void {
    this.reviewerSessionKeys.add(promptCacheKey)
    this.scopedReviewerSessionKeys.delete(promptCacheKey)
  }

  unregisterReviewerSession(promptCacheKey: string): boolean {
    this.reviewerSessionKeys.delete(promptCacheKey)
    return this.scopedReviewerSessionKeys.delete(promptCacheKey)
  }

  async start(): Promise<ResponsesBridgeConnection> {
    if (this.connection) return this.connection
    const token = randomBytes(24).toString('hex')
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return
        if (!response.headersSent) {
          const bridgeError = error instanceof BridgeHttpError ? error : undefined
          json(response, bridgeError?.status ?? 400, {
            error: {
              type: bridgeError?.type ?? 'invalid_request_error',
              message: error instanceof Error ? error.message : String(error)
            }
          })
        } else {
          response.destroy()
        }
      })
    })
    // Own the server before listen resolves so every partial-start failure remains closeable.
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Responses bridge did not bind a port')
      this.connection = { baseUrl: `http://127.0.0.1:${address.port}/v1`, token }
      return this.connection
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.connection = undefined
    this.reasoningByCallId.clear()
    this.reviewerSessionKeys.clear()
    this.scopedReviewerSessionKeys.clear()
    if (!server) return
    const closing = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    server.closeAllConnections()
    await closing
  }

  // Records this turn's reasoning against its tool-call ids so the next request can pass it back to
  // thinking-mode providers. No-op when the turn produced no reasoning or made no tool calls.
  private cacheReasoning(reasoning: string, callIds: string[]): void {
    if (!reasoning) return
    for (const callId of callIds) this.reasoningByCallId.set(callId, reasoning)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      json(response, 404, { error: { message: 'Unknown Responses bridge route' } })
      return
    }
    if (request.headers.authorization !== `Bearer ${this.connection?.token}`) {
      json(response, 401, { error: { message: 'Invalid Responses bridge token' } })
      return
    }
    const abortController = new AbortController()
    const abortUpstream = (): void => abortController.abort()
    const abortOnRequestClose = (): void => {
      if (request.aborted || !request.complete) abortUpstream()
    }
    const abortOnResponseClose = (): void => {
      if (!response.writableEnded) abortUpstream()
    }
    request.once('aborted', abortUpstream)
    request.once('close', abortOnRequestClose)
    response.once('close', abortOnResponseClose)

    try {
      const body = await readBody(request)
      const promptCacheKey =
        typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined
      const reviewerScoped =
        promptCacheKey !== undefined && this.reviewerSessionKeys.has(promptCacheKey)
      if (reviewerScoped) this.scopedReviewerSessionKeys.add(promptCacheKey)
      const namespacedTools = reviewerScoped
        ? (this.target.reviewerScope?.namespacedTools ?? [])
        : (this.target.namespacedTools ?? [])
      // codex-acp ignores disableBuiltInTools metadata and still advertises shell/filesystem tools.
      // For reviewer turns, replace the entire declaration set at the protocol boundary so the model
      // can call only the scope-bounded reviewer HTTP MCP functions.
      const scopedBody = reviewerScoped ? { ...body, tools: [], tool_choice: 'auto' } : body
      const connectorSelection = reviewerScoped
        ? { body: scopedBody, selectedIds: [] }
        : withConnectorInstructions(scopedBody, this.target.connectorInstructions ?? [])
      const chatRequest = responsesToChatRequest(
        connectorSelection.body,
        this.target.model,
        this.reasoningByCallId,
        namespacedTools,
        { forwardReasoningEffort: this.target.forwardReasoningEffort }
      )

      // Reveals which real model actually serves the turn (Codex only ever sees the internal catalog
      // model, not the upstream) and whether Codex's advertised tools survived translation into Chat
      // function tools. An empty incomingToolCount means Codex advertised nothing (e.g. a code_mode_only
      // catalog model); an empty outgoingToolNames with a non-empty incoming set means the bridge
      // filtered them.
      const incomingTools = Array.isArray(body.tools) ? (body.tools as JsonObject[]) : []
      const outgoingTools = Array.isArray(chatRequest.tools)
        ? (chatRequest.tools as JsonObject[])
        : []
      const outgoingToolNames = outgoingTools.map((tool) => tool?.function?.name)
      log.info('bridge request', {
        catalogModel: body.model,
        upstreamModel: chatRequest.model,
        stream: chatRequest.stream === true,
        incomingToolTypes: [
          ...new Set(incomingTools.map((tool) => String(tool?.type ?? '(missing)')))
        ],
        incomingToolCount: incomingTools.length,
        outgoingToolNames,
        selectedConnectors: connectorSelection.selectedIds,
        reviewerScoped,
        toolChoice: chatRequest.tool_choice ?? null
      })

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(this.target.key ? { authorization: `Bearer ${this.target.key}` } : {})
      }
      const upstream = await this.fetchImpl(chatUrl(this.target.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(chatRequest),
        signal: abortController.signal
      })
      if (!upstream.ok) {
        const errorBody = await upstream.text()
        log.warn('bridge upstream error', {
          upstreamModel: chatRequest.model,
          status: upstream.status
        })
        json(response, upstream.status, {
          error: {
            type: 'upstream_error',
            message: upstreamErrorMessage(errorBody, upstream.status),
            status: upstream.status
          }
        })
        return
      }
      if (chatRequest.stream) {
        const { reasoning, callIds } = await streamChatToResponses(
          upstream,
          response,
          String(body.model ?? ''),
          namespacedTools
        )
        this.cacheReasoning(reasoning, callIds)
        return
      }
      const completion = (await upstream.json()) as JsonObject
      const message = (completion.choices?.[0]?.message ?? {}) as JsonObject
      const result = completionToResponse(completion, namespacedTools)
      const outputItems = Array.isArray(result.output) ? (result.output as JsonObject[]) : []
      const toolCalls = outputItems.filter((item) => item.type === 'function_call')
      this.cacheReasoning(
        typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
        toolCalls.map((item) => String(item.call_id))
      )
      log.info('bridge turn completed (json)', {
        model: chatRequest.model,
        textItems: outputItems.filter((item) => item.type === 'message').length,
        toolCalls: toolCalls.length,
        toolNames: toolCalls.map((item) => item.name)
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } finally {
      request.off('aborted', abortUpstream)
      request.off('close', abortOnRequestClose)
      response.off('close', abortOnResponseClose)
    }
  }
}

export { chatUrl, completionToResponse, inputToMessages, toolsToChat, upstreamErrorMessage }
