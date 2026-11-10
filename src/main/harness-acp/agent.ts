import * as acp from '@agentclientprotocol/sdk'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createJournalAgentStore,
  openAgentSession,
  type AgentSession,
  type AgentSessionInspection,
  type AgentEvent,
  type AgentMessage,
  type ContentBlock,
  type ModelRequest,
  type ModelUsage,
  type Json
} from '@aipoch/agent-harness'
import { createChatCompletionsModel } from '@aipoch/agent-harness/chat-completions'
import { createResponsesModel, ResponsesError } from '@aipoch/agent-harness/responses'
import { createMessagesModel } from '@aipoch/agent-harness/messages'
import {
  HARNESS_AUTH_METHOD,
  HARNESS_INSTRUCTIONS,
  HARNESS_TOOL_LESS,
  HARNESS_OWNER,
  harnessOwnerSchema,
  harnessConfigSchema,
  type HarnessConfig
} from './config'
import { connectHarnessMcp } from './mcp'
import { classifyFailure } from '../../shared/failure/classify'

// Built-in Agent context accounting. The provider's reported input tokens are the authority; this
// meter only predicts the next request before dispatch:
// - after a reported request, reuse its exact token count for the unchanged prefix and estimate only
//   the appended messages, conservatively (DELTA_SAFETY);
// - otherwise estimate the whole request from the session's observed bytes-per-token ratio;
// - a provider context-overflow rejection lowers that ratio so the retried request compacts.

type Snapshot = { fixed: string; hashes: string[]; bytes: number[] }
type Anchor = Snapshot & { tokens: number }

// UTF-8 bytes per token before any provider report. English/JSON prompts measure ~4.9 (cl100k);
// CJK text measures lower, so the first report replaces this value.
const DEFAULT_BYTES_PER_TOKEN = 4
// A report outside this range is not a whole-request count (e.g. an adapter omitting cached input);
// it cannot calibrate the estimate.
const MIN_BYTES_PER_TOKEN = 1
const MAX_BYTES_PER_TOKEN = 8
// Appended content is estimated with a 25% smaller ratio, i.e. a larger token count.
const DELTA_SAFETY = 0.8
const ENVELOPE_TOKENS = 64

const hash = (text: string): string => createHash('sha256').update(text).digest('base64')

const snapshot = (request: Pick<ModelRequest, 'instructions' | 'tools' | 'messages'>): Snapshot => {
  const texts = request.messages.map((message) => JSON.stringify(message))
  return {
    fixed: hash(JSON.stringify([request.instructions, request.tools])),
    hashes: texts.map(hash),
    bytes: texts.map((text) => Buffer.byteLength(text, 'utf8'))
  }
}

const fixedBytes = (request: Pick<ModelRequest, 'instructions' | 'tools'>): number =>
  Buffer.byteLength(JSON.stringify([request.instructions, request.tools]), 'utf8')

export type ContextMeter = {
  /** Estimated input tokens for a complete request. */
  measure(request: ModelRequest): number
  /** Estimated input tokens for messages with the last admitted instructions and tools. */
  measureMessages(messages: AgentMessage[]): number | undefined
  /** Records a main request immediately before dispatch. */
  admitted(request: ModelRequest): void
  /** Records a compaction summary request immediately before dispatch, for overflow pricing only. */
  summarizing(request: ModelRequest): void
  /** Applies the provider's report for an admitted request. */
  reported(requestId: string, usage: ModelUsage): void
  /** The provider rejected the last dispatched request as too large for its context window. */
  overflowed(contextWindow: number): void
  /** Estimated tokens for one message, using the current ratio. */
  messageTokens(message: AgentMessage): number
}

export function createContextMeter(): ContextMeter {
  let ratio = DEFAULT_BYTES_PER_TOKEN
  let anchor: Anchor | undefined
  let last: ModelRequest | undefined
  const pending = new Map<string, { snapshot: Snapshot; bytes: number }>()
  const total = (request: ModelRequest, current: Snapshot): number =>
    fixedBytes(request) + current.bytes.reduce((sum, bytes) => sum + bytes, 0)
  const measure = (request: ModelRequest): number => {
    const current = snapshot(request)
    const prefix =
      anchor &&
      anchor.fixed === current.fixed &&
      anchor.hashes.length <= current.hashes.length &&
      anchor.hashes.every((value, index) => current.hashes[index] === value)
    if (prefix) {
      const appended = current.bytes
        .slice(anchor!.hashes.length)
        .reduce((sum, bytes) => sum + bytes, 0)
      return anchor!.tokens + Math.ceil(appended / (ratio * DELTA_SAFETY))
    }
    return Math.ceil(total(request, current) / ratio) + ENVELOPE_TOKENS
  }
  return {
    measure,
    measureMessages: (messages) => (last ? measure({ ...last, messages }) : undefined),
    admitted(request) {
      const current = snapshot(request)
      last = request
      pending.set(request.requestId, { snapshot: current, bytes: total(request, current) })
    },
    summarizing(request) {
      const current = snapshot(request)
      pending.set(request.requestId, { snapshot: current, bytes: total(request, current) })
    },
    reported(requestId, usage) {
      const entry = pending.get(requestId)
      pending.clear()
      if (!entry || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 1) return
      const observed = entry.bytes / usage.inputTokens
      if (observed < MIN_BYTES_PER_TOKEN || observed > MAX_BYTES_PER_TOKEN) return
      ratio = observed
      anchor = { ...entry.snapshot, tokens: usage.inputTokens }
    },
    overflowed(contextWindow) {
      const rejected = [...pending.values()].at(-1)
      pending.clear()
      anchor = undefined
      // The rejected request needed more than contextWindow tokens. Price it just above the window:
      // the retry must compact, and compacting it by the 10% safety margin can fit again.
      if (rejected)
        ratio = Math.max(
          MIN_BYTES_PER_TOKEN,
          Math.min(ratio, rejected.bytes / (contextWindow + 1 - ENVELOPE_TOKENS))
        )
    },
    messageTokens(message) {
      return Math.ceil(Buffer.byteLength(JSON.stringify(message), 'utf8') / ratio)
    }
  }
}

// Old tool results are the bulk of a long session. Above SOFT of the input budget, replace the
// model-facing content of older large results with a reference to the stored original until the
// estimate is below TARGET. Stored history is unchanged; read_tool_result returns the original.
const SOFT = 0.5
const TARGET = 0.4
const KEEP_RECENT_RESULTS = 6
const MIN_CLEARED_TOKENS = 500

export type ToolResultClearing = {
  project(messages: readonly AgentMessage[]): AgentMessage[]
}

const cleared = (message: AgentMessage): AgentMessage => {
  const text = message.content.reduce(
    (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
    0
  )
  const original = { ...message }
  // The stored preview, if any, describes the original result, not this reference.
  delete original.modelContent
  return {
    ...original,
    content: [
      {
        type: 'text',
        text: `[Earlier tool result cleared to save context (${text} characters). If it is needed again, call read_tool_result with invocationId=${JSON.stringify(message.invocationId)}; do not repeat the original tool.]`
      }
    ]
  }
}

export function createToolResultClearing(
  inputBudget: number,
  meter: ContextMeter
): ToolResultClearing {
  // Sticky: once cleared, a result stays cleared, so the projected prefix only changes per batch.
  const ids = new Set<string>()
  return {
    project(messages) {
      const view = messages.map((message) =>
        message.role === 'tool' && message.invocationId && ids.has(message.invocationId)
          ? cleared(message)
          : message
      )
      let tokens = meter.measureMessages(view)
      if (tokens === undefined || tokens <= inputBudget * SOFT) return view
      const results = view.flatMap((message, index) =>
        message.role === 'tool' && message.invocationId ? [index] : []
      )
      for (const index of results.slice(0, -KEEP_RECENT_RESULTS)) {
        if (tokens <= inputBudget * TARGET) break
        const message = view[index]
        if (ids.has(message.invocationId!)) continue
        // read_tool_result returns text only, so a result with media stays in the request.
        if (message.content.some((block) => block.type !== 'text')) continue
        const replacement = cleared(message)
        const saved = meter.messageTokens(message) - meter.messageTokens(replacement)
        if (saved < MIN_CLEARED_TOKENS) continue
        ids.add(message.invocationId!)
        view[index] = replacement
        tokens -= saved
      }
      return view
    }
  }
}

type Entry = {
  session: AgentSession
  /** True once per provider context-overflow rejection observed since the last call. */
  takeOverflow(): boolean
  close(): Promise<void>
  flush(): Promise<void>
  reconcile(): Promise<void>
  active: boolean
  cancelled: boolean
}
const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask' }] }

// Bounded read of a rejected response body; only its overflow classification leaves this process.
// The cloned stream is cancelled at the byte limit, on timeout, or when the request is aborted.
const MAX_ERROR_BODY_BYTES = 16_384
const ERROR_BODY_TIMEOUT_MS = 5_000
const readErrorPrefix = async (
  response: Response,
  signal?: AbortSignal | null
): Promise<string> => {
  const reader = response.clone().body?.getReader()
  if (!reader) return ''
  const stop = AbortSignal.any([
    AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS),
    ...(signal ? [signal] : [])
  ])
  const cancel = (): void => void reader.cancel().catch(() => undefined)
  stop.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // A failed or cancelled body is classified from the bytes already read.
  } finally {
    stop.removeEventListener('abort', cancel)
    cancel()
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES))
}
const isContextOverflowResponse = async (
  response: Response,
  signal?: AbortSignal | null
): Promise<boolean> => {
  if (response.status === 413) return true
  if (response.status !== 400) return false
  const text = await readErrorPrefix(response, signal)
  return (
    classifyFailure({ origin: 'provider', status: 400, text }).reason === 'input/context-overflow'
  )
}

export function createHarnessAcpAgent(directory: string): {
  app: acp.AgentApp
  dispose(): Promise<void>
} {
  if (!isAbsolute(directory)) throw new Error('Built-in Agent storage must be absolute')
  let config: HarnessConfig | undefined
  let disposed = false
  const lifetime = new AbortController()
  const entries = new Map<string, Entry>()
  const opening = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  const store = createJournalAgentStore({ directory: join(directory, 'checkpoints') })
  const requireEntry = (id: string): Entry => {
    const entry = entries.get(id)
    if (!entry || disposed) throw new Error('Built-in Agent session is unavailable')
    return entry
  }
  const modelState = (): { configOptions: acp.SessionConfigOption[]; modes: typeof modes } => ({
    modes,
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: config!.model,
        options: [{ value: config!.model, name: config!.model }]
      }
    ]
  })
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  const open = async (
    id: string,
    params: acp.NewSessionRequest,
    context: acp.AgentContext,
    resume: boolean
  ): Promise<void> => {
    if (!config || disposed) throw new Error('Built-in Agent is not authenticated')
    if (!/^[a-f0-9-]{36}$/.test(id) || !isAbsolute(params.cwd))
      throw new Error('Invalid session identity')
    if (entries.has(id) || opening.has(id)) throw new Error('Session already attached')
    opening.add(id)
    const controller = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    let mcp: Awaited<ReturnType<typeof connectHarnessMcp>> | undefined
    let session: AgentSession | undefined
    let closing: Promise<void> | undefined
    let notifications = Promise.resolve()
    let notificationError: unknown
    const flush = async (): Promise<void> => {
      await notifications
      if (notificationError) throw notificationError
    }
    const close = (): Promise<void> => {
      if (closing) return closing
      controller.abort()
      closing = (async () => {
        const results = await Promise.allSettled([session?.dispose(), mcp?.close()])
        const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
        if (failures.length)
          throw new AggregateError(failures, 'Built-in Agent session cleanup failed')
        entries.delete(id)
      })()
      return closing
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const bindingFile = join(directory, `${id}.json`)
      const rawOwner = params._meta?.[HARNESS_OWNER]
      const owner = rawOwner === undefined ? undefined : harnessOwnerSchema.parse(rawOwner)
      const binding = {
        cwd: resolve(params.cwd),
        ...(owner ? { owner: { ...owner, sessionId: owner.sessionId ?? id } } : {})
      }
      if (resume) {
        const previous = JSON.parse(await readFile(bindingFile, 'utf8'))
        if (previous.cwd !== binding.cwd || !(await store.load(id)))
          throw new Error('Session resume identity mismatch')
        if (previous.owner && JSON.stringify(previous.owner) !== JSON.stringify(binding.owner))
          throw new Error('Session resume owner mismatch')
        if (!previous.owner && binding.owner) {
          const temporary = `${bindingFile}.${randomUUID()}.tmp`
          await writeFile(temporary, JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
          await rename(temporary, bindingFile)
        }
      } else await writeFile(bindingFile, JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
      const instructions = params._meta?.[HARNESS_INSTRUCTIONS] ?? ''
      if (typeof instructions !== 'string') throw new Error('Invalid host instructions')
      const toolLess = params._meta?.[HARNESS_TOOL_LESS] === true
      if (toolLess && params.mcpServers.length)
        throw new Error('Tool-less sessions cannot attach MCP servers')
      mcp = await connectHarnessMcp({
        servers: params.mcpServers,
        sessionId: id,
        context,
        signal,
        beforePermission: flush
      })
      const notify = (update: acp.SessionUpdate): void => {
        notifications = notifications
          .then(() => context.notify(acp.methods.client.session.update, { sessionId: id, update }))
          .catch((error: unknown) => {
            notificationError ??= error
            controller.abort()
          })
      }
      const announced = new Set<string>(),
        completed = new Set<string>()
      const meter = createContextMeter()
      const inputBudget = Math.floor(config.contextWindow * 0.9) - config.maxOutputTokens
      const clearing = createToolResultClearing(inputBudget, meter)
      let overflow = false
      const onEvent = (event: AgentEvent): void => {
        if (event.type === 'compaction') {
          const started = event.status === 'started'
          const committed = event.status === 'finished' && event.outcome.status === 'committed'
          notify({
            sessionUpdate: started ? 'tool_call' : 'tool_call_update',
            toolCallId: `context-compaction:${event.compactionId}`,
            title: started
              ? 'Compacting context'
              : committed
                ? 'Context compacted'
                : 'Context compaction failed',
            kind: 'other',
            status: started ? 'in_progress' : committed ? 'completed' : 'failed',
            _meta: {
              contextCompaction: {
                version: 1,
                reason: 'automatic',
                ...(event.status === 'cancelled' ? { cancelled: true } : {})
              }
            }
          })
        } else if (event.type === 'model') {
          if (event.purpose === 'compaction') return
          if (event.event.type === 'finish' && event.event.usage)
            meter.reported(event.requestId, event.event.usage)
          if (event.event.type === 'finish' && event.event.usage)
            notify({
              sessionUpdate: 'usage_update',
              used: event.event.usage.inputTokens,
              size: config!.contextWindow
            })
          if (event.event.type === 'text-delta' || event.event.type === 'reasoning-delta')
            notify({
              sessionUpdate:
                event.event.type === 'text-delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
              messageId: `${event.requestId}:${event.event.type}`,
              content: { type: 'text', text: event.event.text }
            })
        } else if (event.type === 'tool-update')
          notify({
            sessionUpdate: 'tool_call_update',
            toolCallId: event.invocationId,
            status: 'in_progress',
            content: event.content
              .filter((block) => block.type === 'text')
              .map((content) => ({ type: 'content', content }))
          })
        else if (event.type === 'checkpoint') {
          for (const tool of event.checkpoint.pending) {
            if (!announced.has(tool.invocationId)) {
              announced.add(tool.invocationId)
              const toolName = mcp!.toolNames.get(tool.call.name) ?? tool.call.name
              notify({
                sessionUpdate: 'tool_call',
                toolCallId: tool.invocationId,
                title: toolName,
                _meta: { toolName },
                kind: 'other',
                status: 'pending',
                rawInput: tool.call.arguments
              })
            }
            if (tool.status === 'started')
              notify({
                sessionUpdate: 'tool_call_update',
                toolCallId: tool.invocationId,
                status: 'in_progress'
              })
          }
          for (const message of event.checkpoint.messages) {
            if (
              message.role !== 'tool' ||
              !message.invocationId ||
              !announced.has(message.invocationId) ||
              completed.has(message.invocationId)
            )
              continue
            completed.add(message.invocationId)
            notify({
              sessionUpdate: 'tool_call_update',
              toolCallId: message.invocationId,
              status: message.isError ? 'failed' : 'completed',
              content: message.content
                .filter((block) => block.type === 'text')
                .map((content) => ({ type: 'content', content }))
            })
          }
        }
      }
      const target = config
      const createModel =
        target.protocol === 'responses'
          ? createResponsesModel
          : target.protocol === 'messages'
            ? createMessagesModel
            : createChatCompletionsModel
      const model = createModel({
        endpoint: target.endpoint,
        model: target.model,
        // Retain existing Chat checkpoints; the new protocols get separate opaque-state identities.
        id:
          target.protocol === 'chat-completions'
            ? target.modelIdentity
            : `${target.protocol}:${target.modelIdentity}`,
        apiKey: async () => target.token,
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set('user-agent', 'open-science-agent/0.1.0')
          if (target.sessionHeader) headers.set(target.sessionHeader, id)
          const response = await fetch(url, { ...init, headers })
          if (!response.ok && (await isContextOverflowResponse(response, init?.signal))) {
            overflow = true
            meter.overflowed(target.contextWindow)
          }
          return response
        },
        inputCapabilities: target.inputCapabilities,
        parameters: target.parameters as Record<string, Json>
      })
      const admit = (request: ModelRequest, message: string): void => {
        if (meter.measure(request) + request.maxOutputTokens > target.contextWindow)
          throw new Error(message)
      }
      session = await openAgentSession({
        sessionId: id,
        store,
        model,
        tools: mcp.tools,
        // Original results are already authorized evidence in this exact session; no external access.
        toolResults: toolLess
          ? undefined
          : {
              authorize: async (_args, context) =>
                !context.signal.aborted && context.sessionId === id
            },
        signal,
        instructions,
        maxSteps: 64,
        maxOutputTokens: target.maxOutputTokens,
        compaction: {
          inputBudget,
          keepRecentItems: 1,
          maxOutputTokens: Math.min(2048, target.maxOutputTokens),
          measure: meter.measure,
          admit: (request) => {
            admit(request, 'Summary exceeds the model context budget')
            meter.summarizing(request)
          }
        },
        transformContext: (messages) => clearing.project(messages),
        admit: (request) => {
          admit(request, 'Request exceeds the model context budget')
          meter.admitted(request)
        },
        onEvent
      })
      if (resume) {
        const checkpoint = await session.inspect()
        for (const pending of checkpoint.pending) announced.add(pending.invocationId)
        // The host process owner stops the previous helper before reattaching this provider session.
        if (checkpoint.run?.status === 'running') await session.recover(checkpoint.run.id)
      }
      signal.throwIfAborted()
      entries.set(id, {
        session,
        takeOverflow: () => {
          const observed = overflow
          overflow = false
          return observed
        },
        close,
        reconcile: () => mcp!.reconcile(session!),
        active: false,
        cancelled: false,
        flush
      })
    } catch (error) {
      try {
        await close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Built-in Agent startup failed')
      }
      throw error
    } finally {
      opening.delete(id)
    }
  }
  const app = acp
    .agent({ name: 'open-science-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'open-science-agent', version: '0.1.0' },
      authMethods: [{ id: HARNESS_AUTH_METHOD, name: 'Open-Science Agent' }],
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: true, sse: false },
        // ACP initializes before authentication, so the selected provider protocol and model
        // capabilities are not available yet. Images are the only prompt media supported by all
        // configured protocols; audio is chat-completions-only and must not be advertised here.
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {} }
      }
    }))
    .onRequest(acp.methods.agent.authenticate, (context) => {
      if (config || disposed || context.params.methodId !== HARNESS_AUTH_METHOD)
        throw new Error('Invalid authentication transition')
      config = harnessConfigSchema.parse(context.params._meta?.['open-science-agent'])
      return {}
    })
    .onRequest(acp.methods.agent.session.new, (context) =>
      track(
        (async () => {
          const sessionId = randomUUID()
          await open(sessionId, context.params, context.client, false)
          return { sessionId, ...modelState() }
        })()
      )
    )
    .onRequest(acp.methods.agent.session.resume, (context) =>
      track(
        (async () => {
          await open(
            context.params.sessionId,
            { ...context.params, mcpServers: context.params.mcpServers ?? [] },
            context.client,
            true
          )
          return modelState()
        })()
      )
    )
    .onRequest(acp.methods.agent.session.setMode, (context) => {
      requireEntry(context.params.sessionId)
      if (context.params.modeId !== 'default') throw new Error('Permissions are owned by the host')
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
      requireEntry(context.params.sessionId)
      if (context.params.configId !== 'model' || context.params.value !== config?.model)
        throw new Error('Model changes require a new host connection')
      return { configOptions: modelState().configOptions }
    })
    .onRequest(acp.methods.agent.session.prompt, (context) =>
      track(
        (async (): Promise<acp.PromptResponse> => {
          const entry = requireEntry(context.params.sessionId)
          if (entry.active) throw new Error('Session is already running')
          const blocks: ContentBlock[] = context.params.prompt.map((block) => {
            if (block.type === 'text') return { type: 'text', text: block.text }
            if (block.type === 'image' || block.type === 'audio')
              return {
                type: block.type,
                mimeType: block.mimeType,
                source: `data:${block.mimeType};base64,${block.data}`
              }
            if (block.type === 'resource' && 'blob' in block.resource && block.resource.mimeType) {
              const mimeType = block.resource.mimeType
              return {
                type: mimeType.startsWith('video/')
                  ? 'video'
                  : mimeType.startsWith('audio/')
                    ? 'audio'
                    : mimeType.startsWith('image/')
                      ? 'image'
                      : 'file',
                mimeType,
                source: `data:${mimeType};base64,${block.resource.blob}`
              }
            }
            if (block.type === 'resource' && 'text' in block.resource)
              return { type: 'text', text: block.resource.text }
            throw new Error('Unsupported prompt content; host must resolve references')
          })
          entry.active = true
          entry.cancelled = false
          try {
            await entry.reconcile()
            const assertKnown = (checkpoint: AgentSessionInspection): void => {
              const unknown = checkpoint.pending.filter((tool) => tool.status === 'unknown')
              if (unknown.length)
                throw new acp.RequestError(
                  -32001,
                  `Built-in Agent tool outcome is unknown: ${unknown.map((tool) => `${tool.call.name} (${tool.invocationId})`).join(', ')}`
                )
            }
            const before = await entry.session.inspect()
            assertKnown(before)
            entry.takeOverflow()
            // A provider context overflow already lowered the meter's estimate. Continue the same turn
            // once so the next request compacts first; the rejected request executed no tool.
            const status = await entry.session
              .prompt(blocks)
              .catch(async (error: unknown) => {
                if (entry.cancelled || !entry.takeOverflow()) throw error
                const checkpoint = await entry.session.inspect()
                if (checkpoint.pending.length) throw error
                return entry.session.continue()
              })
              .catch(async (error: unknown) => {
                await entry.flush()
                if (!entry.cancelled) assertKnown(await entry.session.inspect())
                if (
                  error instanceof ResponsesError &&
                  [
                    'insufficient_quota',
                    'rate_limit_exceeded',
                    'model_not_found',
                    'authentication_error'
                  ].includes(error.code)
                )
                  throw new acp.RequestError(-32603, error.message, {
                    errorName: 'APIError',
                    errorKind: error.code,
                    ...(error.status === undefined ? {} : { status: error.status })
                  })
                throw error
              })
            await entry.flush()
            const after = await entry.session.inspect({ requestsFrom: before.requestCount })
            if (!entry.cancelled) assertKnown(after)
            const requests = after.requests
            if (!entry.cancelled && !['complete', 'cancelled', 'budget'].includes(status))
              throw new Error(
                `Built-in Agent turn ${status}; recovery requires host reconciliation`
              )
            return {
              stopReason: entry.cancelled
                ? 'cancelled'
                : status === 'complete'
                  ? 'end_turn'
                  : status === 'cancelled'
                    ? 'cancelled'
                    : 'max_turn_requests',
              _meta: {
                'open-science-agent/requests': requests.map(({ id, status, usage }) => ({
                  id,
                  status,
                  ...(usage ? { usage } : {})
                }))
              }
            }
          } finally {
            entry.active = false
          }
        })()
      )
    )
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      const entry = entries.get(context.params.sessionId)
      if (!entry?.active) return
      // ACP cancellation acknowledges prompt release; uncertain effects stay blocked in the journal.
      entry.cancelled = true
      entry.session.cancel()
    })
    .onRequest(acp.methods.agent.session.close, (context) =>
      track(
        (async () => {
          await requireEntry(context.params.sessionId).close()
          return {}
        })()
      )
    )
  return {
    app,
    async dispose() {
      disposed = true
      lifetime.abort()
      const results = await Promise.allSettled([
        ...pending,
        ...[...entries.values()].map((entry) => entry.close())
      ])
      config = undefined
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
      if (failures.length) throw new AggregateError(failures, 'Built-in Agent shutdown failed')
    }
  }
}
