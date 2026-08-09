import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createLogger } from '../logger'
import { appendChatCompletions } from './base-url'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type {
  CustomReasoningEffortTransport,
  ModelReasoningEffort
} from '../../shared/reasoning-effort'
import {
  responsesToChatRequest,
  type ResponsesBridgeNamespacedTool
} from './responses-request-adapter'
import {
  boundedSkillSelectorCatalog,
  renderSkillSelectorCatalog,
  resolveSelectedSkills,
  selectExplicitConnectorSkills
} from './skill-selector-routing'

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
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
  // Codex uses a catalog model for its local metadata; bridge providers may need a different
  // upstream model id (for example, DeepSeek's model name).
  model?: string
  namespacedTools?: ResponsesBridgeNamespacedTool[]
  // The active model's resolved API value. This explicitly overrides Codex's transport-model effort,
  // which may use a smaller vocabulary or emit its own default. Undefined strips the field.
  reasoningEffort?: ModelReasoningEffort
  reviewerScope?: {
    namespacedTools: ResponsesBridgeNamespacedTool[]
  }
}

export type ResponsesBridgeModelTarget = Pick<
  ResponsesBridgeTarget,
  'model' | 'vendorId' | 'reasoningEffortTransport' | 'reasoningEffort'
>

export type ResponsesBridgeConnection = {
  baseUrl: string
  token: string
  // Opaque, non-secret identity for this in-memory bridge instance. Session recovery compares it to
  // avoid resuming Codex history after the hidden reasoning cache has been lost.
  continuityToken?: string
  // Absent is the legacy Chat Completions bridge. Native Responses compatibility stays on the
  // Responses wire protocol and opts in explicitly so framework config can preserve its model.
  kind?: 'responses-compatibility'
}

export type ResponsesBridgeSkillCandidate = {
  name: string
  description: string
  path: string
  source?: 'connector'
}

export type ResponsesBridgeSkillInput = Pick<ResponsesBridgeSkillCandidate, 'name' | 'path'>

type ResponsesBridgeOptions = {
  skillSelectorTimeoutMs?: number
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

const UPSTREAM_IMAGE_TYPES = new Set(['image', 'image_url', 'input_image', 'output_image'])

const unsupportedUpstreamImageOutput = (): BridgeHttpError =>
  new BridgeHttpError(
    'Upstream image output is not supported by this gateway',
    502,
    'unsupported_upstream_output'
  )

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
  private readonly toolLessSessionKeys = new Set<string>()
  private readonly scopedToolLessSessionKeys = new Set<string>()

  constructor(
    target: ResponsesBridgeTarget,
    private readonly fetchImpl: BridgeFetch = fetch,
    private readonly options: ResponsesBridgeOptions = {}
  ) {
    this.target = target
  }

  async selectSkills(
    text: string,
    catalog: ResponsesBridgeSkillCandidate[],
    signal?: AbortSignal
  ): Promise<ResponsesBridgeSkillInput[]> {
    if (!text.trim() || catalog.length === 0 || signal?.aborted) return []
    const explicit = selectExplicitConnectorSkills(text, catalog)
    if (explicit.length > 0) return explicit
    const selectorCatalog = boundedSkillSelectorCatalog(catalog)
    if (selectorCatalog.length === 0) return []

    const timeout = new AbortController()
    let timedOut = false
    const abortFromCaller = (): void => timeout.abort(signal?.reason)
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      timeout.abort()
    }, this.options.skillSelectorTimeoutMs ?? 15_000)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(chatUrl(this.target.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.target.key ? { authorization: `Bearer ${this.target.key}` } : {})
        },
        body: JSON.stringify({
          model: this.target.model,
          stream: false,
          temperature: 0,
          max_tokens: 512,
          messages: [
            {
              role: 'system',
              content:
                'You are a Skill routing classifier. Select only the Skills needed to execute the current user request. Do not perform the task. Call select_skills exactly once. Use only catalog names. Return an empty list when no Skill applies.\n\nSkill catalog:\n' +
                renderSkillSelectorCatalog(selectorCatalog)
            },
            { role: 'user', content: text }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'select_skills',
                description: 'Select zero to three applicable Skills from the provided catalog.',
                parameters: {
                  type: 'object',
                  properties: {
                    skill_names: {
                      type: 'array',
                      maxItems: 3,
                      items: { type: 'string' }
                    }
                  },
                  required: ['skill_names'],
                  additionalProperties: false
                }
              }
            }
          ]
        }),
        signal: timeout.signal
      })
      if (!response.ok) {
        log.warn('bridge skill selection failed', {
          model: this.target.model,
          reason: 'upstream-http',
          status: response.status
        })
        return []
      }

      const completion = (await response.json()) as JsonObject
      const calls = completion.choices?.[0]?.message?.tool_calls
      const call = Array.isArray(calls)
        ? calls.find((candidate) => candidate?.function?.name === 'select_skills')
        : undefined
      if (typeof call?.function?.arguments !== 'string') {
        log.warn('bridge skill selection failed', {
          model: this.target.model,
          reason: 'missing-function-call'
        })
        return []
      }

      const args = JSON.parse(call.function.arguments) as JsonObject
      const requested = Array.isArray(args.skill_names) ? args.skill_names : []
      const selected = resolveSelectedSkills(requested, selectorCatalog)
      log.info('bridge skill selection completed', {
        model: this.target.model,
        catalogCount: catalog.length,
        routedCatalogCount: selectorCatalog.length,
        selectedNames: selected.map(({ name }) => name)
      })
      return selected
    } catch {
      log.warn('bridge skill selection failed', {
        model: this.target.model,
        reason: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'invalid-response'
      })
      return []
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  setTarget(target: ResponsesBridgeTarget): void {
    // Clear the reasoning cache only when the upstream target actually changes. setTarget is also
    // called on same-provider reconnects (skill reload, session resume); clearing then would drop the
    // reasoning_content a resumed thinking-mode session still needs to replay. On a real provider
    // switch the old provider's reasoning must not leak into the new one.
    const changed =
      this.target.baseUrl !== target.baseUrl ||
      this.target.model !== target.model ||
      this.target.vendorId !== target.vendorId ||
      this.target.reasoningEffortTransport !== target.reasoningEffortTransport ||
      this.target.key !== target.key
    this.target = target
    if (changed) this.reasoningByCallId.clear()
  }

  setModelTarget(target: ResponsesBridgeModelTarget): void {
    this.setTarget({ ...this.target, ...target })
  }

  // Updates only the resolved upstream effort on the live target. Deliberately not a setTarget: the
  // provider is unchanged, so the reasoning cache must be preserved.
  setReasoningEffort(effort?: ModelReasoningEffort): void {
    this.target = { ...this.target, reasoningEffort: effort }
  }

  registerReviewerSession(promptCacheKey: string): void {
    this.reviewerSessionKeys.add(promptCacheKey)
    this.scopedReviewerSessionKeys.delete(promptCacheKey)
  }

  unregisterReviewerSession(promptCacheKey: string): boolean {
    this.reviewerSessionKeys.delete(promptCacheKey)
    return this.scopedReviewerSessionKeys.delete(promptCacheKey)
  }

  registerToolLessSession(promptCacheKey: string): void {
    this.toolLessSessionKeys.add(promptCacheKey)
    this.scopedToolLessSessionKeys.delete(promptCacheKey)
  }

  unregisterToolLessSession(promptCacheKey: string): boolean {
    this.toolLessSessionKeys.delete(promptCacheKey)
    return this.scopedToolLessSessionKeys.delete(promptCacheKey)
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
      this.connection = {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token,
        continuityToken: randomBytes(16).toString('hex')
      }
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
    this.toolLessSessionKeys.clear()
    this.scopedToolLessSessionKeys.clear()
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
      const toolLessScoped =
        promptCacheKey !== undefined && this.toolLessSessionKeys.has(promptCacheKey)
      if (reviewerScoped) this.scopedReviewerSessionKeys.add(promptCacheKey)
      if (toolLessScoped) this.scopedToolLessSessionKeys.add(promptCacheKey)
      const namespacedTools = reviewerScoped
        ? (this.target.reviewerScope?.namespacedTools ?? [])
        : toolLessScoped
          ? []
          : (this.target.namespacedTools ?? [])
      // codex-acp ignores disableBuiltInTools metadata and still advertises shell/filesystem tools.
      // For reviewer turns, replace the entire declaration set at the protocol boundary so the model
      // can call only the scope-bounded reviewer HTTP MCP functions.
      const scopedBody =
        reviewerScoped || toolLessScoped ? { ...body, tools: [], tool_choice: 'auto' } : body
      const chatRequest = responsesToChatRequest(
        scopedBody,
        this.target.model,
        this.reasoningByCallId,
        namespacedTools,
        {
          reasoningEffortOverride: this.target.reasoningEffort,
          vendorId: this.target.vendorId,
          reasoningEffortTransport: this.target.reasoningEffortTransport
        }
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

export { chatUrl, completionToResponse, upstreamErrorMessage }
export {
  inputToMessages,
  responsesToChatRequest,
  toolsToChat,
  type ResponsesBridgeNamespacedTool
} from './responses-request-adapter'
