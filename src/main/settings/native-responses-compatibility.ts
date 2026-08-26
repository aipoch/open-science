import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

import { createLogger, diagnosticErrorFields } from '../logger'
import type {
  ResponsesBridgeConnection,
  ResponsesBridgeModelTarget,
  ResponsesBridgeNamespacedTool,
  ResponsesBridgeSkillCandidate,
  ResponsesBridgeSkillInput
} from './responses-bridge'
import {
  boundedSkillSelectorCatalog,
  renderSkillSelectorCatalog,
  resolveSelectedSkills,
  selectExplicitConnectorSkills
} from './skill-selector-routing'
import {
  ProviderLoopbackHttpHost,
  ProviderLoopbackRequestError,
  writeProviderLoopbackJson as json,
  type ProviderLoopbackHttpRequest
} from './provider-loopback-http-host'
import {
  DeterministicProviderErrorReplay,
  isDeterministicProviderErrorStatus,
  providerErrorClientStatus,
  providerRequestHeadersFingerprint,
  providerRequestFingerprint,
  readBoundedProviderErrorBody
} from './provider-error-replay'

// Responses payloads are intentionally open-ended across providers. Keep the compatibility boundary
// permissive, then validate the fields this module rewrites before touching them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

type NativeResponsesCompatibilityTarget = {
  baseUrl: string
  key?: string
  resolveKey?: (forceRefresh?: boolean) => Promise<string>
  sanitizeRequest?: (body: JsonObject) => JsonObject
  model?: string
  reviewerScope?: {
    namespacedTools: ResponsesBridgeNamespacedTool[]
  }
}

type NativeResponsesCompatibilityOptions = {
  responseHeaderTimeoutMs?: number
  skillSelectorTimeoutMs?: number
  streamIdleTimeoutMs?: number
}

export type NativeResponsesToolIdentity = {
  namespace: string
  name: string
}

export type NativeResponsesToolAliases = Map<string, NativeResponsesToolIdentity>

type NativeFetch = typeof fetch

type NativeResponsesStreamSummary = Readonly<{
  terminalEventType: string
  terminalStatus?: string
  terminalOutputItemCount: number
  terminalMessageCount: number
  observedFunctionCallCount: number
  observedArtifactFunctionCallCount: number
}>

const log = createLogger('native-responses-compatibility')
const DEFAULT_RESPONSE_HEADER_TIMEOUT_MS = 2 * 60_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000
const MAX_REPLAY_ERROR_BODY_BYTES = 256 * 1024
const SAFE_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT'
])

type ProviderErrorSnapshot = Readonly<{
  body: Buffer
  headers: Record<string, string>
  status: number
  upstreamStatus: number
}>

class NativeResponsesTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'

  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const safeNetworkErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const directCode = safeRead(error, 'code')
  if (typeof directCode === 'string' && SAFE_NETWORK_ERROR_CODES.has(directCode)) return directCode
  const cause = safeRead(error, 'cause')
  if (typeof cause !== 'object' || cause === null) return undefined
  const causeCode = safeRead(cause, 'code')
  return typeof causeCode === 'string' && SAFE_NETWORK_ERROR_CODES.has(causeCode)
    ? causeCode
    : undefined
}

const upstreamResponseType = (contentType: string): 'event-stream' | 'json' | 'binary' => {
  if (contentType.includes('text/event-stream')) return 'event-stream'
  if (contentType.includes('application/json')) return 'json'
  return 'binary'
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const containsText = (value: unknown, marker: string): boolean => {
  if (typeof value === 'string') return value.includes(marker)
  if (Array.isArray(value)) return value.some((item) => containsText(item, marker))
  return isObject(value) && Object.values(value).some((item) => containsText(item, marker))
}

const isArtifactTool = (value: unknown, aliases: NativeResponsesToolAliases): boolean => {
  if (!isObject(value) || typeof value.name !== 'string') return false
  const identity =
    typeof value.namespace === 'string'
      ? { namespace: value.namespace, name: value.name }
      : aliases.get(value.name)
  return (
    identity?.namespace === 'mcp__open_science_artifacts' && identity.name === 'write_artifact_file'
  )
}

const namespaceAlias = (namespace: string, name: string): string => `${namespace}__${name}`

const combinedDescription = (namespaceDescription: unknown, toolDescription: unknown): string =>
  [namespaceDescription, toolDescription]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n\n')

const flattenHistoryItem = (item: unknown): unknown => {
  if (!isObject(item)) return item
  if (
    (item.type !== 'function_call' && item.type !== 'custom_tool_call') ||
    typeof item.namespace !== 'string' ||
    typeof item.name !== 'string'
  ) {
    return item
  }

  const { namespace, ...withoutNamespace } = item
  return { ...withoutNamespace, name: namespaceAlias(namespace, item.name) }
}

const flattenToolChoice = (toolChoice: unknown): unknown => {
  if (
    !isObject(toolChoice) ||
    typeof toolChoice.namespace !== 'string' ||
    typeof toolChoice.name !== 'string'
  ) {
    return toolChoice
  }

  const { namespace, ...withoutNamespace } = toolChoice
  return { ...withoutNamespace, name: namespaceAlias(namespace, toolChoice.name) }
}

export const flattenNativeResponsesRequest = (
  body: JsonObject
): { request: JsonObject; aliases: NativeResponsesToolAliases } => {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new ProviderLoopbackRequestError('native Responses tools must be an array')
  }

  const tools = (body.tools ?? []) as unknown[]
  const aliases: NativeResponsesToolAliases = new Map()
  const occupiedNames = new Set(
    tools.flatMap((tool) =>
      isObject(tool) && tool.type !== 'namespace' && typeof tool.name === 'string'
        ? [tool.name]
        : []
    )
  )
  const flattenedTools = tools.flatMap((tool) => {
    if (!isObject(tool) || tool.type !== 'namespace') return [tool]
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) {
      throw new ProviderLoopbackRequestError(
        'native Responses namespace tools require a name and child tools'
      )
    }

    return tool.tools.map((child) => {
      if (!isObject(child) || child.type !== 'function' || typeof child.name !== 'string') {
        throw new ProviderLoopbackRequestError(
          'native Responses namespace children must be function tools'
        )
      }
      const alias = namespaceAlias(tool.name, child.name)
      if (occupiedNames.has(alias) || aliases.has(alias)) {
        throw new ProviderLoopbackRequestError(`duplicate native Responses tool alias: ${alias}`)
      }
      occupiedNames.add(alias)
      aliases.set(alias, { namespace: tool.name, name: child.name })
      const description = combinedDescription(tool.description, child.description)
      return {
        ...child,
        name: alias,
        ...(description ? { description } : {})
      }
    })
  })

  return {
    request: {
      ...body,
      ...(body.tools === undefined ? {} : { tools: flattenedTools }),
      ...(body.tool_choice === undefined
        ? {}
        : { tool_choice: flattenToolChoice(body.tool_choice) }),
      ...(Array.isArray(body.input) ? { input: body.input.map(flattenHistoryItem) } : {})
    },
    aliases
  }
}

export const restoreNativeResponsesPayload = (
  value: unknown,
  aliases: NativeResponsesToolAliases
): unknown => {
  if (Array.isArray(value)) return value.map((item) => restoreNativeResponsesPayload(item, aliases))
  if (!isObject(value)) return value

  const restored = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      restoreNativeResponsesPayload(child, aliases)
    ])
  ) as JsonObject
  if (
    (restored.type === 'function_call' || restored.type === 'custom_tool_call') &&
    restored.namespace === undefined &&
    typeof restored.name === 'string'
  ) {
    const identity = aliases.get(restored.name)
    if (identity) {
      restored.name = identity.name
      restored.namespace = identity.namespace
    }
  }
  return restored
}

const responsesUrl = (baseUrl: string): string =>
  `${baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/responses$/i, '')}/responses`

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const upstreamHeaders = (
  request: ProviderLoopbackHttpRequest,
  key: string | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    // Node fetch adds Fetch Metadata headers to the loopback request. Chromium owns these headers and
    // rejects callers that pass them explicitly to Electron net.fetch with ERR_INVALID_ARGUMENT.
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      name === 'authorization' ||
      name.startsWith('sec-fetch-') ||
      value === undefined
    ) {
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers['content-type'] = 'application/json'
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

const copyResponseHeaders = (upstream: Response): Record<string, string> => {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    // Fetch decodes compressed bodies. Forwarding the original encoding after rewriting would make
    // Codex try to decompress already-decoded bytes.
    if (!HOP_BY_HOP_HEADERS.has(name) && name !== 'content-encoding') headers[name] = value
  })
  return headers
}

const streamSummaryObserver = (
  aliases: NativeResponsesToolAliases
): Readonly<{
  observe: (value: unknown) => void
  summary: () => NativeResponsesStreamSummary | undefined
}> => {
  const functionCallKeys = new Set<string>()
  const artifactFunctionCallKeys = new Set<string>()
  let terminal:
    | Readonly<{
        type: string
        status?: string
        output: unknown[]
      }>
    | undefined

  const observeFunctionCall = (item: unknown, outputIndex?: unknown): void => {
    if (!isObject(item) || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) {
      return
    }
    const key =
      typeof item.call_id === 'string'
        ? `call:${item.call_id}`
        : typeof item.id === 'string'
          ? `id:${item.id}`
          : typeof outputIndex === 'number'
            ? `index:${outputIndex}`
            : `anonymous:${functionCallKeys.size}`
    functionCallKeys.add(key)
    if (isArtifactTool(item, aliases)) artifactFunctionCallKeys.add(key)
  }

  const observe = (value: unknown): void => {
    if (!isObject(value)) return
    if (
      (value.type === 'response.output_item.added' || value.type === 'response.output_item.done') &&
      isObject(value.item)
    ) {
      observeFunctionCall(value.item, value.output_index)
    }
    if (
      (value.type !== 'response.completed' &&
        value.type !== 'response.failed' &&
        value.type !== 'response.incomplete') ||
      !isObject(value.response)
    ) {
      return
    }
    const output = Array.isArray(value.response.output) ? value.response.output : []
    output.forEach((item, index) => observeFunctionCall(item, index))
    terminal = {
      type: value.type,
      ...(typeof value.response.status === 'string' ? { status: value.response.status } : {}),
      output
    }
  }

  return {
    observe,
    summary: () => {
      if (!terminal) return undefined
      return {
        terminalEventType: terminal.type,
        ...(terminal.status ? { terminalStatus: terminal.status } : {}),
        terminalOutputItemCount: terminal.output.length,
        terminalMessageCount: terminal.output.filter(
          (item) => isObject(item) && item.type === 'message'
        ).length,
        observedFunctionCallCount: functionCallKeys.size,
        observedArtifactFunctionCallCount: artifactFunctionCallKeys.size
      }
    }
  }
}

const rewriteSseLine = (
  line: string,
  aliases: NativeResponsesToolAliases,
  observe: (value: unknown) => void
): string => {
  if (!line.startsWith('data:')) return line
  const data = line.slice('data:'.length).trimStart()
  if (!data || data === '[DONE]') return line
  try {
    const payload = JSON.parse(data) as unknown
    observe(payload)
    return `data: ${JSON.stringify(restoreNativeResponsesPayload(payload, aliases))}`
  } catch {
    return line
  }
}

const streamResponse = async (
  upstream: Response,
  response: ServerResponse,
  aliases: NativeResponsesToolAliases,
  onActivity: () => void
): Promise<NativeResponsesStreamSummary | undefined> => {
  if (!upstream.body) throw new Error('native Responses upstream returned no body')
  response.writeHead(upstream.status, copyResponseHeaders(upstream))
  const decoder = new TextDecoder()
  let buffered = ''
  const observer = streamSummaryObserver(aliases)
  for await (const chunk of upstream.body) {
    onActivity()
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) response.write(`${rewriteSseLine(line, aliases, observer.observe)}\n`)
  }
  buffered += decoder.decode()
  if (buffered) response.write(rewriteSseLine(buffered, aliases, observer.observe))
  response.end()
  return observer.summary()
}

const readResponseText = async (upstream: Response, onActivity: () => void): Promise<string> => {
  if (!upstream.body) throw new Error('native Responses upstream returned no body')
  const decoder = new TextDecoder()
  let body = ''
  for await (const chunk of upstream.body) {
    onActivity()
    body += decoder.decode(chunk, { stream: true })
  }
  return body + decoder.decode()
}

const namespaceToolDeclarations = (tools: ResponsesBridgeNamespacedTool[]): JsonObject[] => {
  const byNamespace = new Map<string, JsonObject[]>()
  for (const tool of tools) {
    const children = byNamespace.get(tool.namespace) ?? []
    children.push({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict })
    })
    byNamespace.set(tool.namespace, children)
  }
  return Array.from(byNamespace, ([name, children]) => ({
    type: 'namespace',
    name,
    tools: children
  }))
}

export class NativeResponsesCompatibilityProxy {
  private readonly host: ProviderLoopbackHttpHost<ResponsesBridgeConnection>
  private readonly reviewerSessionKeys = new Set<string>()
  private readonly scopedReviewerSessionKeys = new Set<string>()
  private readonly toolLessSessionKeys = new Set<string>()
  private readonly scopedToolLessSessionKeys = new Set<string>()
  private readonly hostMessageSessionScopes = new Map<string, ResponsesBridgeNamespacedTool[]>()
  private readonly scopedHostMessageSessionKeys = new Set<string>()
  private readonly strictHostMessageSessionKeys = new Set<string>()
  private readonly deterministicErrors =
    new DeterministicProviderErrorReplay<ProviderErrorSnapshot>()

  constructor(
    private target: NativeResponsesCompatibilityTarget,
    private readonly fetchImpl: NativeFetch = fetch,
    private readonly options: NativeResponsesCompatibilityOptions = {}
  ) {
    this.host = new ProviderLoopbackHttpHost({
      diagnosticName: 'native-responses-compatibility',
      credentialMode: 'bearer',
      createConnection: (origin, token) => ({
        baseUrl: origin + '/v1',
        token,
        kind: 'responses-compatibility'
      }),
      onUnauthorized: (response) =>
        json(response, 401, {
          error: { message: 'Invalid native Responses compatibility token' }
        }),
      onError: (error, response) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        const requestError = error instanceof ProviderLoopbackRequestError
        json(response, requestError ? 400 : 502, {
          error: {
            type: requestError ? 'invalid_request_error' : 'api_error',
            message: 'Native Responses compatibility request failed'
          }
        })
      },
      handle: (request, response) => this.handle(request, response)
    })
  }

  setTarget(target: NativeResponsesCompatibilityTarget): void {
    const changed =
      this.target.baseUrl !== target.baseUrl ||
      this.target.model !== target.model ||
      this.target.key !== target.key
    this.target = target
    if (changed) this.deterministicErrors.clear()
  }

  setModelTarget(target: ResponsesBridgeModelTarget): void {
    this.setTarget({ ...this.target, model: target.model })
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
    if (!this.target.model) return []

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
      const resolvedKey = this.target.resolveKey ? await this.target.resolveKey() : this.target.key
      const response = await this.fetchImpl(responsesUrl(this.target.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(resolvedKey ? { authorization: `Bearer ${resolvedKey}` } : {})
        },
        body: JSON.stringify({
          model: this.target.model,
          stream: false,
          instructions:
            'Select only the Skills needed to execute the current user request. Do not perform the task. Call select_skills exactly once using only catalog names. Return an empty list when no Skill applies.\n\nSkill catalog:\n' +
            renderSkillSelectorCatalog(selectorCatalog),
          input: text,
          tools: [
            {
              type: 'function',
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
          ],
          tool_choice: { type: 'function', name: 'select_skills' },
          parallel_tool_calls: false
        }),
        signal: timeout.signal
      })
      if (!response.ok) {
        log.warn('native Responses Skill selection failed', {
          model: this.target.model,
          reason: 'upstream-http',
          status: response.status
        })
        return []
      }
      const payload = (await response.json()) as JsonObject
      const output = Array.isArray(payload.output) ? payload.output : []
      const call = output.find(
        (item: unknown) =>
          isObject(item) && item.type === 'function_call' && item.name === 'select_skills'
      )
      if (!isObject(call) || typeof call.arguments !== 'string') return []
      const argumentsValue = JSON.parse(call.arguments) as unknown
      if (!isObject(argumentsValue) || !Array.isArray(argumentsValue.skill_names)) return []

      const selected = resolveSelectedSkills(argumentsValue.skill_names, selectorCatalog)
      log.info('native Responses Skill selection completed', {
        model: this.target.model,
        catalogCount: catalog.length,
        selectedCount: selected.length
      })
      return selected
    } catch {
      log.warn('native Responses Skill selection failed', {
        model: this.target.model,
        reason: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'invalid-response'
      })
      return []
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  async start(): Promise<ResponsesBridgeConnection> {
    return this.host.start()
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

  async close(): Promise<void> {
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

  private async handle(
    request: ProviderLoopbackHttpRequest,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.path !== '/v1/responses') {
      json(response, 404, { error: { message: 'Unknown native Responses compatibility route' } })
      return
    }

    const requestId = randomUUID()
    const startedAt = Date.now()
    const upstreamAbort = new AbortController()
    let upstreamTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutError: NativeResponsesTimeoutError | undefined
    const clearUpstreamTimeout = (): void => {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      upstreamTimer = undefined
    }
    const armUpstreamTimeout = (timeoutMs: number, message: string): void => {
      clearUpstreamTimeout()
      upstreamTimer = setTimeout(() => {
        timeoutError = new NativeResponsesTimeoutError(message)
        upstreamAbort.abort(timeoutError)
      }, timeoutMs)
      upstreamTimer.unref?.()
    }
    const armStreamIdleTimeout = (): void =>
      armUpstreamTimeout(
        this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        'Native Responses upstream stream became idle.'
      )
    let phase = 'read-request'

    try {
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
      // Codex currently advertises built-in tools even when reviewer session metadata disables them.
      // Replace the full declaration set at this boundary so reviewer turns can reach only their
      // scope-bounded reviewer MCP, matching the Chat bridge's fail-closed contract.
      const scopedBody =
        reviewerScoped || toolLessScoped || hostMessageScoped || hostMessageBoundaryActive
          ? {
              ...body,
              tools: namespaceToolDeclarations(
                reviewerScoped
                  ? (this.target.reviewerScope?.namespacedTools ?? [])
                  : hostMessageScoped
                    ? hostMessageTools
                    : []
              ),
              tool_choice: 'auto'
            }
          : body
      const routedBody = this.target.model
        ? { ...scopedBody, model: this.target.model }
        : scopedBody
      const { request: flattenedRequest, aliases } = flattenNativeResponsesRequest(routedBody)
      const upstreamRequest = this.target.sanitizeRequest
        ? this.target.sanitizeRequest(flattenedRequest)
        : flattenedRequest
      const upstreamRequestBody = JSON.stringify(upstreamRequest)
      const resolvedKey = this.target.resolveKey ? await this.target.resolveKey() : this.target.key
      const headersToForward = upstreamHeaders(request, resolvedKey)
      const replayKey = providerRequestFingerprint(
        this.target.baseUrl,
        providerRequestHeadersFingerprint(headersToForward),
        upstreamRequestBody
      )
      const requestBytes = Buffer.byteLength(upstreamRequestBody, 'utf8')
      // Derive the input size from the already-serialized body so a large multimodal input is not
      // serialized a second time just for diagnostics. The subtracted 8/9 bytes are the JSON key and
      // optional comma around the removed `input` field.
      const { input: upstreamInput, ...upstreamRequestWithoutInput } = upstreamRequest
      const inputBytes =
        upstreamInput === undefined
          ? 0
          : Math.max(
              0,
              requestBytes -
                Buffer.byteLength(JSON.stringify(upstreamRequestWithoutInput), 'utf8') -
                (Object.keys(upstreamRequestWithoutInput).length > 0 ? 9 : 8)
            )
      const inputItems = Array.isArray(upstreamInput) ? upstreamInput : []
      const developerItems = inputItems.filter(
        (item) => isObject(item) && item.type === 'message' && item.role === 'developer'
      )
      const topLevelArtifactInstructionPresent = containsText(
        upstreamRequest.instructions,
        '<open_science_artifact_instructions>'
      )
      const developerArtifactInstructionPresent = developerItems.some((item) =>
        containsText(item.content, '<open_science_artifact_instructions>')
      )
      log.info('native Responses compatibility request', {
        requestId,
        requestBytes,
        inputBytes,
        inputItemCount: Array.isArray(upstreamInput)
          ? upstreamInput.length
          : upstreamInput === undefined
            ? 0
            : 1,
        instructionTextBytes:
          typeof upstreamRequest.instructions === 'string'
            ? Buffer.byteLength(upstreamRequest.instructions, 'utf8')
            : 0,
        toolDefinitionCount: Array.isArray(upstreamRequest.tools)
          ? upstreamRequest.tools.length
          : 0,
        developerInstructionItemCount: developerItems.length,
        topLevelArtifactInstructionPresent,
        developerArtifactInstructionPresent,
        artifactInstructionPresent:
          topLevelArtifactInstructionPresent || developerArtifactInstructionPresent,
        artifactToolPresent:
          Array.isArray(upstreamRequest.tools) &&
          upstreamRequest.tools.some((tool: unknown) => isArtifactTool(tool, aliases)),
        functionCallOutputHistoryCount: inputItems.filter(
          (item) => isObject(item) && item.type === 'function_call_output'
        ).length,
        promptCacheKeyPresent: promptCacheKey !== undefined,
        namespaceToolCount: aliases.size,
        stream: body.stream === true,
        reviewerScoped,
        toolLessScoped
      })
      phase = 'upstream-fetch'
      const replay = this.deterministicErrors.get(replayKey)
      if (replay) {
        phase = 'forward-response'
        response.writeHead(replay.status, replay.headers)
        response.end(replay.body)
        log.info('native Responses compatibility request completed', {
          requestId,
          status: replay.upstreamStatus,
          replayed: true,
          durationMs: Math.max(0, Date.now() - startedAt)
        })
        return
      }
      armUpstreamTimeout(
        this.options.responseHeaderTimeoutMs ?? DEFAULT_RESPONSE_HEADER_TIMEOUT_MS,
        'Native Responses upstream did not return response headers in time.'
      )
      let upstream = await this.fetchImpl(responsesUrl(this.target.baseUrl), {
        method: 'POST',
        headers: headersToForward,
        body: upstreamRequestBody,
        signal: AbortSignal.any([request.signal, upstreamAbort.signal])
      })
      if (upstream.status === 401 && this.target.resolveKey) {
        const refreshedKey = await this.target.resolveKey(true)
        upstream = await this.fetchImpl(responsesUrl(this.target.baseUrl), {
          method: 'POST',
          headers: upstreamHeaders(request, refreshedKey),
          body: upstreamRequestBody,
          signal: AbortSignal.any([request.signal, upstreamAbort.signal])
        })
      }
      clearUpstreamTimeout()
      const contentType = upstream.headers.get('content-type') ?? ''
      const responseType = upstreamResponseType(contentType)
      log.info('native Responses compatibility upstream response', {
        requestId,
        status: upstream.status,
        responseType,
        durationMs: Math.max(0, Date.now() - startedAt)
      })
      phase = 'forward-response'
      if (isDeterministicProviderErrorStatus(upstream.status)) {
        const boundedBody = await readBoundedProviderErrorBody(upstream, {
          signal: request.signal
        })
        let rawBody = boundedBody.body
        let bodyIsReplayable = boundedBody.complete
        if (boundedBody.complete && responseType === 'json') {
          try {
            rawBody = Buffer.from(
              JSON.stringify(
                restoreNativeResponsesPayload(
                  JSON.parse(boundedBody.body.toString('utf8')),
                  aliases
                )
              )
            )
          } catch {
            bodyIsReplayable = false
          }
        }
        bodyIsReplayable &&= rawBody.byteLength <= MAX_REPLAY_ERROR_BODY_BYTES
        const bodyToReplay = bodyIsReplayable
          ? rawBody
          : Buffer.from(
              JSON.stringify({
                error: {
                  type: 'invalid_request_error',
                  message: `Provider request failed with status ${upstream.status}`,
                  status: upstream.status
                }
              })
            )
        const headers = {
          ...copyResponseHeaders(upstream),
          ...(bodyIsReplayable ? {} : { 'content-type': 'application/json' }),
          'content-length': String(bodyToReplay.byteLength),
          'x-open-science-upstream-status': String(upstream.status)
        }
        const snapshot = {
          body: bodyToReplay,
          headers,
          status: providerErrorClientStatus(upstream.status),
          upstreamStatus: upstream.status
        }
        this.deterministicErrors.remember(replayKey, upstream.status, snapshot)
        response.writeHead(snapshot.status, snapshot.headers)
        response.end(snapshot.body)
      } else if (responseType === 'event-stream') {
        armStreamIdleTimeout()
        const summary = await streamResponse(upstream, response, aliases, armStreamIdleTimeout)
        log.info('native Responses compatibility stream completed', {
          requestId,
          ...(summary ?? { terminalEventType: 'missing' })
        })
      } else if (responseType === 'json') {
        armStreamIdleTimeout()
        const payload = restoreNativeResponsesPayload(
          JSON.parse(await readResponseText(upstream, armStreamIdleTimeout)),
          aliases
        )
        response.writeHead(upstream.status, copyResponseHeaders(upstream))
        response.end(JSON.stringify(payload))
      } else {
        response.writeHead(upstream.status, copyResponseHeaders(upstream))
        response.end(Buffer.from(await upstream.arrayBuffer()))
      }
      log.info('native Responses compatibility request completed', {
        requestId,
        status: upstream.status,
        durationMs: Math.max(0, Date.now() - startedAt)
      })
    } catch (error) {
      const failure = timeoutError ?? error
      const errorCode = safeNetworkErrorCode(failure)
      log.warn('native Responses compatibility request failed', {
        requestId,
        phase,
        outcome: request.signal.aborted ? 'aborted' : 'error',
        durationMs: Math.max(0, Date.now() - startedAt),
        ...diagnosticErrorFields(failure),
        ...(errorCode ? { errorCode } : {})
      })
      throw failure
    } finally {
      clearUpstreamTimeout()
    }
  }
}

export type { NativeResponsesCompatibilityOptions, NativeResponsesCompatibilityTarget }
