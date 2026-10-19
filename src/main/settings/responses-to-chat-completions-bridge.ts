import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { observeProviderFailure } from './provider-failure-observation'
import type {
  ResponsesConnection,
  ResponsesModelTarget,
  ResponsesSkillCandidate,
  ResponsesSkillInput,
  ResponsesToChatCompletionsBridgeTarget
} from './responses-transport-contract'
export type {
  ResponsesConnection,
  ResponsesModelTarget,
  ResponsesSkillCandidate,
  ResponsesSkillInput,
  ResponsesToChatCompletionsBridgeTarget
} from './responses-transport-contract'

import { createLogger } from '@aipoch/diagnostics/node'
import type { ModelReasoningEffort } from '@aipoch/providers'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import type { SkillSelectorUsageObservation } from '../agent-framework/types'
import {
  createResponsesAdapter,
  appendChatCompletionsPath,
  type ResponsesNamespacedTool,
  ResponsesProtocolError,
  upstreamErrorMessage
} from '@aipoch/providers/protocol'
import {
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  ResponseBodyLimitError,
  fetchProviderRequest
} from '@aipoch/providers/transport'

import { selectChatSkills } from './chat-skill-selector'
import {
  DeterministicProviderErrorReplay,
  providerErrorClientStatus,
  providerRequestFingerprint,
  readBoundedProviderErrorBody
} from './provider-error-replay'

import {
  writeProviderLoopbackJson as json,
  ProviderLoopbackHttpHost,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'

// The bridge deliberately keeps protocol payloads open-ended; validation rejects unsupported shapes
// at the boundary before values reach the upstream request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

// Diagnostics log only model IDs and tool shapes/counts, never keys, prompts, or arguments.
const log = createLogger('acp-bridge')

export type ResponsesToChatCompletionsBridgeOptions = {
  maxResponseBytes?: number
  skillSelectorTimeoutMs?: number
  skillSelectorFailureMode?: 'empty' | 'throw'
  reasoningCacheMaxEntries?: number
  reasoningCacheMaxCharacters?: number
}

type BridgeFetch = typeof fetch
const PLAN_GENERATE_BRIDGE_ALIAS = modelFacingAppMcpToolName(
  'codex',
  'open-science-plan',
  'generate_plan',
  true
)
const REQUEST_LOCAL_PLAN_NAMESPACE = PLAN_GENERATE_BRIDGE_ALIAS.slice(0, -'__generate_plan'.length)
const REQUEST_LOCAL_PLAN_TOOL_NAMES = new Set(['generate_plan', 'update_step_status'])

// The upstream Chat Completions endpoint. `target.baseUrl` is already the resolved OpenAI base (an
// official vendor's exact versioned base, or a custom root normalized to `<root>/v1`), so this only
// appends `/chat/completions` — preserving any query/hash on the base.
const chatUrl = (value: string): string => appendChatCompletionsPath(value)

export class ResponsesToChatCompletionsBridge {
  private readonly host: ProviderLoopbackHttpHost<ResponsesConnection>
  private target: ResponsesToChatCompletionsBridgeTarget
  private readonly adapter: ReturnType<typeof createResponsesAdapter>
  private readonly reviewerSessionKeys = new Set<string>()
  private readonly scopedReviewerSessionKeys = new Set<string>()
  private readonly toolLessSessionKeys = new Set<string>()
  private readonly scopedToolLessSessionKeys = new Set<string>()
  private readonly hostMessageSessionScopes = new Map<string, ResponsesNamespacedTool[]>()
  private readonly scopedHostMessageSessionKeys = new Set<string>()
  private readonly strictHostMessageSessionKeys = new Set<string>()
  private readonly sessionMcpTools = new Map<string, ResponsesNamespacedTool[]>()
  private readonly sessionMcpNamespaces = new Map<string, readonly string[]>()
  private readonly deterministicErrors = new DeterministicProviderErrorReplay<{
    message: string
    upstreamStatus: number
  }>()

  constructor(
    target: ResponsesToChatCompletionsBridgeTarget,
    private readonly fetchImpl: BridgeFetch = fetch,
    private readonly options: ResponsesToChatCompletionsBridgeOptions = {}
  ) {
    this.target = target
    this.adapter = createResponsesAdapter({
      maxResponseBytes: options.maxResponseBytes,
      reasoningCacheMaxEntries: options.reasoningCacheMaxEntries,
      reasoningCacheMaxCharacters: options.reasoningCacheMaxCharacters
    })
    this.host = new ProviderLoopbackHttpHost({
      diagnosticName: 'responses',
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
        const responseLimitError = error instanceof ResponseBodyLimitError
        json(response, bridgeError?.status ?? (responseLimitError ? 502 : 400), {
          error: {
            type: bridgeError?.type ?? (responseLimitError ? 'api_error' : 'invalid_request_error'),
            message: error instanceof Error ? error.message : String(error)
          }
        })
      },
      handle: (request, response) => this.handle(request, response)
    })
  }

  async selectSkills(
    text: string,
    catalog: ResponsesSkillCandidate[],
    signal?: AbortSignal,
    observeUsage?: (observation: SkillSelectorUsageObservation) => void
  ): Promise<ResponsesSkillInput[]> {
    try {
      return await selectChatSkills({
        text,
        catalog,
        target: {
          url: chatUrl(this.target.baseUrl),
          ...(this.target.key ? { key: this.target.key } : {}),
          ...(this.target.model ? { model: this.target.model } : {}),
          ...(this.target.vendorId ? { vendorId: this.target.vendorId } : {}),
          ...(this.target.reasoningEffortTransport
            ? { reasoningEffortTransport: this.target.reasoningEffortTransport }
            : {})
        },
        fetchImpl: this.fetchImpl,
        timeoutMs: this.options.skillSelectorTimeoutMs ?? 15_000,
        maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
        ...(signal ? { signal } : {}),
        ...(observeUsage ? { observeUsage } : {})
      })
    } catch (error) {
      if (this.options.skillSelectorFailureMode === 'throw') throw error
      return []
    }
  }

  setTarget(target: ResponsesToChatCompletionsBridgeTarget): void {
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
      this.adapter.clear()
      this.deterministicErrors.clear()
    }
  }

  setModelTarget(target: ResponsesModelTarget): void {
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
    namespacedTools: ResponsesNamespacedTool[],
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

  registerMcpSession(
    promptCacheKey: string,
    namespacedTools: ResponsesNamespacedTool[],
    namespaces: readonly string[] = [...new Set(namespacedTools.map(({ namespace }) => namespace))]
  ): void {
    this.sessionMcpTools.set(promptCacheKey, namespacedTools)
    this.sessionMcpNamespaces.set(promptCacheKey, [...new Set(namespaces)])
  }

  unregisterMcpSession(promptCacheKey: string): boolean {
    this.sessionMcpNamespaces.delete(promptCacheKey)
    return this.sessionMcpTools.delete(promptCacheKey)
  }

  async start(): Promise<ResponsesConnection> {
    return this.host.start()
  }

  async close(): Promise<void> {
    this.adapter.clear()
    this.deterministicErrors.clear()
    this.reviewerSessionKeys.clear()
    this.scopedReviewerSessionKeys.clear()
    this.toolLessSessionKeys.clear()
    this.scopedToolLessSessionKeys.clear()
    this.hostMessageSessionScopes.clear()
    this.scopedHostMessageSessionKeys.clear()
    this.strictHostMessageSessionKeys.clear()
    this.sessionMcpNamespaces.clear()
    this.sessionMcpTools.clear()
    await this.host.close()
  }

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.path !== '/v1/responses') {
      json(response, 404, { error: { message: 'Unknown Responses bridge route' } })
      return
    }

    const target = this.target
    const body = (await request.readJsonObject()) as JsonObject
    const promptCacheKey =
      typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined
    const reviewerScoped =
      promptCacheKey !== undefined && this.reviewerSessionKeys.has(promptCacheKey)
    const toolLessScoped =
      promptCacheKey !== undefined && this.toolLessSessionKeys.has(promptCacheKey)
    const hostMessageTools =
      promptCacheKey === undefined ? undefined : this.hostMessageSessionScopes.get(promptCacheKey)
    const sessionMcpTools =
      promptCacheKey === undefined ? undefined : this.sessionMcpTools.get(promptCacheKey)
    const sessionMcpNamespaces =
      promptCacheKey === undefined ? undefined : this.sessionMcpNamespaces.get(promptCacheKey)
    const hostMessageScoped = hostMessageTools !== undefined
    const hostMessageBoundaryActive = this.strictHostMessageSessionKeys.size > 0
    if (reviewerScoped) this.scopedReviewerSessionKeys.add(promptCacheKey)
    if (toolLessScoped) this.scopedToolLessSessionKeys.add(promptCacheKey)
    if (hostMessageScoped) this.scopedHostMessageSessionKeys.add(promptCacheKey!)
    // This app-owned MCP server carries the current session's Skill allowlist. Preserve its
    // request-local schema; a backend-wide declaration would outlive Specialist scope changes.
    const skillNamespace = Array.isArray(body.tools)
      ? body.tools.find((tool) => tool?.type === 'namespace' && tool.name === 'mcp__skills')
      : undefined
    const skillLoader = Array.isArray(skillNamespace?.tools)
      ? skillNamespace.tools.find(
          (tool: JsonObject) => tool?.type === 'function' && tool.name === 'load_skill'
        )
      : undefined
    const skillTools: ResponsesNamespacedTool[] = skillLoader
      ? [{ ...skillLoader, namespace: 'mcp__skills' }]
      : []
    // The Plan MCP server is provisioned per Session, so its namespace is authoritative only for
    // this request. Forward the two public tools only when Codex advertises that live capability;
    // never promote them into the bridge-wide fallback catalog.
    const planNamespace = Array.isArray(body.tools)
      ? body.tools.find(
          (tool) => tool?.type === 'namespace' && tool.name === REQUEST_LOCAL_PLAN_NAMESPACE
        )
      : undefined
    const planTools: ResponsesNamespacedTool[] = Array.isArray(planNamespace?.tools)
      ? planNamespace.tools
          .filter(
            (tool: JsonObject) =>
              tool?.type === 'function' && REQUEST_LOCAL_PLAN_TOOL_NAMES.has(String(tool.name))
          )
          .map((tool: JsonObject) => ({ ...tool, namespace: REQUEST_LOCAL_PLAN_NAMESPACE }))
      : []
    const namespacedTools = reviewerScoped
      ? (target.reviewerScope?.namespacedTools ?? [])
      : toolLessScoped
        ? []
        : hostMessageScoped
          ? hostMessageTools
          : hostMessageBoundaryActive
            ? []
            : [
                ...(sessionMcpTools || sessionMcpNamespaces
                  ? [
                      ...(target.namespacedTools ?? []).filter(
                        (tool) =>
                          !(sessionMcpNamespaces ?? []).includes(tool.namespace) &&
                          !(sessionMcpTools ?? []).some(
                            ({ namespace }) => namespace === tool.namespace
                          )
                      ),
                      ...(sessionMcpTools ?? [])
                    ]
                  : (target.namespacedTools ?? [])),
                ...skillTools,
                ...planTools
              ]
    // codex-acp ignores disableBuiltInTools metadata and still advertises shell/filesystem tools.
    // For reviewer turns, replace the entire declaration set at the protocol boundary so the model
    // can call only the scope-bounded reviewer HTTP MCP functions.
    const scopedBody =
      reviewerScoped || toolLessScoped || hostMessageScoped || hostMessageBoundaryActive
        ? { ...body, tools: [], tool_choice: 'auto' }
        : body
    // These tools belong to the host's MCP resource policy, not the wire converter.
    const hostFilteredBody = {
      ...scopedBody,
      tools: Array.isArray(scopedBody.tools)
        ? scopedBody.tools.filter(
            (tool: JsonObject) =>
              tool?.type !== 'function' ||
              !['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(
                String(tool.name)
              )
          )
        : scopedBody.tools
    }
    // Go requires conversation affinity. The Responses-to-Chat translation removes
    // prompt_cache_key, so carry the existing Codex identity across the HTTP boundary.
    // Never replace a missing conversation identity with a shared or per-request UUID.
    const goSession =
      target.vendorId === 'opencode-go'
        ? (request.headers['x-opencode-session'] ?? request.headers['session-id'] ?? promptCacheKey)
        : undefined
    if (
      target.vendorId === 'opencode-go' &&
      (typeof goSession !== 'string' ||
        !/^[\x21-\x7e]+$/.test(goSession) ||
        goSession.includes(','))
    ) {
      json(response, 400, {
        error: { message: 'OpenCode Go requires a valid conversation session ID.' }
      })
      return
    }
    // Host admission must succeed before preparation reconciles the replay history.
    const turn = this.adapter.prepare({
      body: hostFilteredBody,
      scope: promptCacheKey,
      model: target.model,
      tools: namespacedTools,
      reasoning: {
        reasoningEffortOverride: target.reasoningEffort,
        vendorId: target.vendorId,
        reasoningEffortTransport: target.reasoningEffortTransport
      }
    })
    const chatRequest = turn.request
    const chatRequestBody = JSON.stringify(chatRequest)
    const replayKey = providerRequestFingerprint(
      target.baseUrl,
      chatRequestBody,
      typeof goSession === 'string' ? goSession : ''
    )

    // Reveals which real model actually serves the turn (Codex only ever sees the internal catalog
    // model, not the upstream) and whether Codex's advertised tools survived translation into Chat
    // function tools. An empty incomingToolCount means Codex advertised nothing (e.g. a code_mode_only
    // catalog model); an empty outgoingToolNames with a non-empty incoming set means the bridge
    // filtered them.
    const incomingTools = Array.isArray(body.tools) ? (body.tools as JsonObject[]) : []
    const incomingNamespaces = incomingTools
      .filter((tool) => tool?.type === 'namespace')
      .slice(0, 32)
      .map((namespace) => ({
        name:
          typeof namespace.name === 'string'
            ? namespace.name.slice(0, 128)
            : '(missing namespace name)',
        toolNames: Array.isArray(namespace.tools)
          ? namespace.tools
              .slice(0, 64)
              .map((tool: JsonObject) =>
                typeof tool?.name === 'string' ? tool.name.slice(0, 128) : '(missing tool name)'
              )
          : []
      }))
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
      incomingNamespaces: incomingNamespaces.map((namespace) => namespace.name),
      incomingNamespaceToolNames: incomingNamespaces.flatMap((namespace) =>
        namespace.toolNames.map((toolName) => `${namespace.name}/${toolName}`)
      ),
      outgoingToolNames,
      reviewerScoped,
      hostMessageScoped,
      toolChoice: chatRequest.tool_choice ?? null
    })

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(target.key ? { authorization: `Bearer ${target.key}` } : {}),
      ...(typeof goSession === 'string'
        ? { 'x-opencode-session': goSession, 'user-agent': 'open-science/codex-bridge' }
        : {})
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
    const startedAt = Date.now()
    const upstream = await fetchProviderRequest(this.fetchImpl, chatUrl(target.baseUrl), {
      method: 'POST',
      headers,
      body: chatRequestBody,
      signal: request.signal
    })
    if (!upstream.ok) {
      const errorBody = await readBoundedProviderErrorBody(upstream, { signal: request.signal })
      await observeProviderFailure(
        target.onProviderFailure,
        { model: chatRequest.model, endpoint: 'chat-completions', startedAt },
        upstream.status,
        errorBody.complete ? errorBody.body.toString('utf8') : undefined
      )
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
    const converted = await turn.convert(upstream)
    response.writeHead(converted.status, Object.fromEntries(converted.headers))
    if (converted.body)
      await pipeline(Readable.fromWeb(converted.body as NodeReadableStream<Uint8Array>), response)
    else response.end()
  }
}

export { chatUrl }
