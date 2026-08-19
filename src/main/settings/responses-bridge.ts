import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

import { createLogger } from '../logger'
import { appendChatCompletions } from './base-url'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type {
  CustomReasoningEffortTransport,
  ModelReasoningEffort
} from '../../shared/reasoning-effort'
import { responsesToChatRequest } from './responses-request-adapter'
import {
  completionToResponse,
  ResponsesProtocolError,
  streamChatToResponses,
  upstreamErrorMessage
} from './responses-response-adapter'
import type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'
import {
  boundedSkillSelectorCatalog,
  renderSkillSelectorCatalog,
  resolveSelectedSkills,
  selectExplicitConnectorSkills
} from './skill-selector-routing'
import {
  ProviderLoopbackHttpHost,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'
import {
  DeterministicProviderErrorReplay,
  providerErrorClientStatus,
  providerRequestFingerprint,
  readBoundedProviderErrorBody
} from './provider-error-replay'

// The bridge deliberately keeps protocol payloads open-ended; validation rejects unsupported shapes
// at the boundary before values reach the upstream request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

// Diagnostics log only model IDs and tool shapes/counts, never keys, prompts, or arguments.
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
  reasoningCacheMaxEntries?: number
  reasoningCacheMaxCharacters?: number
}

type BridgeFetch = typeof fetch

const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 4_096
const DEFAULT_REASONING_CACHE_MAX_CHARACTERS = 8 * 1024 * 1024

// The upstream Chat Completions endpoint. `target.baseUrl` is already the resolved OpenAI base (an
// official vendor's exact versioned base, or a custom root normalized to `<root>/v1`), so this only
// appends `/chat/completions` — preserving any query/hash on the base.
const chatUrl = (value: string): string => appendChatCompletions(value)

export class ResponsesBridge {
  private readonly host: ProviderLoopbackHttpHost<ResponsesBridgeConnection>
  private target: ResponsesBridgeTarget
  // reasoning_content produced with each tool call, partitioned by Codex's prompt_cache_key (its
  // provider Session id) before call_id. The bridge is shared across Sessions, and providers may
  // reuse call ids, so a bridge-global call-id map would mix otherwise unrelated histories.
  private readonly reasoningByPromptCacheKey = new Map<string, Map<string, string>>()
  private reasoningCacheEntryCount = 0
  private reasoningCacheCharacterCount = 0
  private readonly reviewerSessionKeys = new Set<string>()
  private readonly scopedReviewerSessionKeys = new Set<string>()
  private readonly toolLessSessionKeys = new Set<string>()
  private readonly scopedToolLessSessionKeys = new Set<string>()
  private readonly hostMessageSessionScopes = new Map<string, ResponsesBridgeNamespacedTool[]>()
  private readonly scopedHostMessageSessionKeys = new Set<string>()
  private readonly strictHostMessageSessionKeys = new Set<string>()
  private readonly deterministicErrors = new DeterministicProviderErrorReplay<{
    message: string
    upstreamStatus: number
  }>()

  constructor(
    target: ResponsesBridgeTarget,
    private readonly fetchImpl: BridgeFetch = fetch,
    private readonly options: ResponsesBridgeOptions = {}
  ) {
    this.target = target
    this.host = new ProviderLoopbackHttpHost({
      credentialMode: 'bearer',
      createConnection: (origin, token) => ({
        baseUrl: origin + '/v1',
        token,
        continuityToken: randomBytes(16).toString('hex')
      }),
      onUnauthorized: (response) =>
        json(response, 401, { error: { message: 'Invalid Responses bridge token' } }),
      onError: (error, response) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        const bridgeError = error instanceof ResponsesProtocolError ? error : undefined
        json(response, bridgeError?.status ?? 400, {
          error: {
            type: bridgeError?.type ?? 'invalid_request_error',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      },
      handle: (request, response) => this.handle(request, response)
    })
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
    if (changed) {
      this.clearReasoningCache()
      this.deterministicErrors.clear()
    }
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

  registerHostMessageSession(
    promptCacheKey: string,
    namespacedTools: ResponsesBridgeNamespacedTool[],
    options?: Readonly<{ failClosedUnknownKeys?: boolean }>
  ): void {
    this.hostMessageSessionScopes.set(promptCacheKey, namespacedTools)
    this.scopedHostMessageSessionKeys.delete(promptCacheKey)
    if (options?.failClosedUnknownKeys) this.strictHostMessageSessionKeys.add(promptCacheKey)
    else this.strictHostMessageSessionKeys.delete(promptCacheKey)
  }

  unregisterHostMessageSession(promptCacheKey: string): boolean {
    this.hostMessageSessionScopes.delete(promptCacheKey)
    this.strictHostMessageSessionKeys.delete(promptCacheKey)
    return this.scopedHostMessageSessionKeys.delete(promptCacheKey)
  }

  async start(): Promise<ResponsesBridgeConnection> {
    return this.host.start()
  }

  async close(): Promise<void> {
    this.clearReasoningCache()
    this.deterministicErrors.clear()
    this.reviewerSessionKeys.clear()
    this.scopedReviewerSessionKeys.clear()
    this.toolLessSessionKeys.clear()
    this.scopedToolLessSessionKeys.clear()
    this.hostMessageSessionScopes.clear()
    this.scopedHostMessageSessionKeys.clear()
    this.strictHostMessageSessionKeys.clear()
    await this.host.close()
  }

  private clearReasoningCache(): void {
    this.reasoningByPromptCacheKey.clear()
    this.reasoningCacheEntryCount = 0
    this.reasoningCacheCharacterCount = 0
  }

  private reasoningForRequest(promptCacheKey: string | undefined): Map<string, string> | undefined {
    if (!promptCacheKey) return undefined
    return this.reasoningByPromptCacheKey.get(promptCacheKey)
  }

  private reconcileReasoningForRequest(promptCacheKey: string | undefined, input: unknown): void {
    if (!promptCacheKey) return
    const reasoningByCallId = this.reasoningByPromptCacheKey.get(promptCacheKey)
    if (!reasoningByCallId) return

    const retainedCallIds = new Set<string>()
    if (Array.isArray(input)) {
      for (const item of input) {
        if (!item || typeof item !== 'object' || !('type' in item)) continue
        if (item.type !== 'function_call') continue
        const callId = 'call_id' in item ? item.call_id : 'id' in item ? item.id : undefined
        if (callId !== undefined && callId !== null) retainedCallIds.add(String(callId))
      }
    }

    for (const [callId, reasoning] of reasoningByCallId) {
      if (retainedCallIds.has(callId)) continue
      reasoningByCallId.delete(callId)
      this.reasoningCacheEntryCount -= 1
      this.reasoningCacheCharacterCount -= reasoning.length
    }
    if (reasoningByCallId.size === 0) {
      this.reasoningByPromptCacheKey.delete(promptCacheKey)
      return
    }

    // Refresh this Session's insertion order so overflow evicts the least recently used scope.
    this.reasoningByPromptCacheKey.delete(promptCacheKey)
    this.reasoningByPromptCacheKey.set(promptCacheKey, reasoningByCallId)
  }

  // Records this turn's reasoning against its Session-scoped tool-call ids so the next request can
  // pass it back to thinking-mode providers. Missing prompt_cache_key fails closed: without a stable
  // Session boundary, cached reasoning cannot be replayed safely.
  private cacheReasoning(
    promptCacheKey: string | undefined,
    reasoning: string,
    callIds: string[]
  ): void {
    if (!promptCacheKey || !reasoning || callIds.length === 0) return
    let reasoningByCallId = this.reasoningByPromptCacheKey.get(promptCacheKey)
    if (!reasoningByCallId) {
      reasoningByCallId = new Map()
    } else {
      this.reasoningByPromptCacheKey.delete(promptCacheKey)
    }
    this.reasoningByPromptCacheKey.set(promptCacheKey, reasoningByCallId)

    for (const callId of callIds) {
      const previous = reasoningByCallId.get(callId)
      if (previous !== undefined) {
        this.reasoningCacheCharacterCount -= previous.length
      } else {
        this.reasoningCacheEntryCount += 1
      }
      reasoningByCallId.set(callId, reasoning)
      this.reasoningCacheCharacterCount += reasoning.length
    }
    this.enforceReasoningCacheLimits()
  }

  private enforceReasoningCacheLimits(): void {
    const maxEntries = Math.max(
      1,
      Math.floor(this.options.reasoningCacheMaxEntries ?? DEFAULT_REASONING_CACHE_MAX_ENTRIES)
    )
    const maxCharacters = Math.max(
      1,
      Math.floor(this.options.reasoningCacheMaxCharacters ?? DEFAULT_REASONING_CACHE_MAX_CHARACTERS)
    )
    while (
      this.reasoningByPromptCacheKey.size > 0 &&
      (this.reasoningCacheEntryCount > maxEntries ||
        this.reasoningCacheCharacterCount > maxCharacters)
    ) {
      const oldestPromptCacheKey = this.reasoningByPromptCacheKey.keys().next().value
      if (typeof oldestPromptCacheKey !== 'string') break
      const oldest = this.reasoningByPromptCacheKey.get(oldestPromptCacheKey)
      this.reasoningByPromptCacheKey.delete(oldestPromptCacheKey)
      if (!oldest) continue
      for (const reasoning of oldest.values()) {
        this.reasoningCacheEntryCount -= 1
        this.reasoningCacheCharacterCount -= reasoning.length
      }
    }
  }

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.path !== '/v1/responses') {
      json(response, 404, { error: { message: 'Unknown Responses bridge route' } })
      return
    }

    const body = (await request.readJsonObject()) as JsonObject
    const promptCacheKey =
      typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined
    const reviewerScoped =
      promptCacheKey !== undefined && this.reviewerSessionKeys.has(promptCacheKey)
    const toolLessScoped =
      promptCacheKey !== undefined && this.toolLessSessionKeys.has(promptCacheKey)
    const hostMessageTools =
      promptCacheKey === undefined ? undefined : this.hostMessageSessionScopes.get(promptCacheKey)
    const hostMessageScoped = hostMessageTools !== undefined
    const hostMessageBoundaryActive = this.strictHostMessageSessionKeys.size > 0
    if (reviewerScoped) this.scopedReviewerSessionKeys.add(promptCacheKey)
    if (toolLessScoped) this.scopedToolLessSessionKeys.add(promptCacheKey)
    if (hostMessageScoped) this.scopedHostMessageSessionKeys.add(promptCacheKey!)
    const namespacedTools = reviewerScoped
      ? (this.target.reviewerScope?.namespacedTools ?? [])
      : toolLessScoped
        ? []
        : hostMessageScoped
          ? hostMessageTools
          : hostMessageBoundaryActive
            ? []
            : (this.target.namespacedTools ?? [])
    // codex-acp ignores disableBuiltInTools metadata and still advertises shell/filesystem tools.
    // For reviewer turns, replace the entire declaration set at the protocol boundary so the model
    // can call only the scope-bounded reviewer HTTP MCP functions.
    const scopedBody =
      reviewerScoped || toolLessScoped || hostMessageScoped || hostMessageBoundaryActive
        ? { ...body, tools: [], tool_choice: 'auto' }
        : body
    const reasoningByCallId = this.reasoningForRequest(promptCacheKey)
    const chatRequest = responsesToChatRequest(
      scopedBody,
      this.target.model,
      reasoningByCallId,
      namespacedTools,
      {
        reasoningEffortOverride: this.target.reasoningEffort,
        vendorId: this.target.vendorId,
        reasoningEffortTransport: this.target.reasoningEffortTransport
      }
    )
    const chatRequestBody = JSON.stringify(chatRequest)
    const replayKey = providerRequestFingerprint(this.target.baseUrl, chatRequestBody)
    this.reconcileReasoningForRequest(promptCacheKey, body.input)

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
      hostMessageScoped,
      toolChoice: chatRequest.tool_choice ?? null
    })

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.target.key ? { authorization: `Bearer ${this.target.key}` } : {})
    }
    const replay = this.deterministicErrors.get(replayKey)
    if (replay) {
      json(response, providerErrorClientStatus(replay.upstreamStatus), {
        error: {
          type: 'upstream_error',
          message: replay.message,
          status: replay.upstreamStatus
        }
      })
      return
    }
    const upstream = await this.fetchImpl(chatUrl(this.target.baseUrl), {
      method: 'POST',
      headers,
      body: chatRequestBody,
      signal: request.signal
    })
    if (!upstream.ok) {
      const errorBody = await readBoundedProviderErrorBody(upstream, { signal: request.signal })
      const message = errorBody.complete
        ? upstreamErrorMessage(errorBody.body.toString('utf8'), upstream.status)
        : `Provider request failed with status ${upstream.status}`
      this.deterministicErrors.remember(replayKey, upstream.status, {
        message,
        upstreamStatus: upstream.status
      })
      log.warn('bridge upstream error', {
        upstreamModel: chatRequest.model,
        status: upstream.status
      })
      json(response, providerErrorClientStatus(upstream.status), {
        error: {
          type: 'upstream_error',
          message,
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
      this.cacheReasoning(promptCacheKey, reasoning, callIds)
      return
    }
    const completion = (await upstream.json()) as JsonObject
    const message = (completion.choices?.[0]?.message ?? {}) as JsonObject
    const result = completionToResponse(completion, namespacedTools)
    const outputItems = Array.isArray(result.output) ? (result.output as JsonObject[]) : []
    const toolCalls = outputItems.filter((item) => item.type === 'function_call')
    this.cacheReasoning(
      promptCacheKey,
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
  }
}

export { chatUrl, completionToResponse, upstreamErrorMessage }
export { inputToMessages, responsesToChatRequest, toolsToChat } from './responses-request-adapter'
export type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'
