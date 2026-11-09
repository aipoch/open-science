import * as acp from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createJournalAgentStore,
  openAgentSession,
  type AgentSession,
  type AgentSessionInspection,
  type AgentEvent,
  type ContentBlock,
  type ModelRequest,
  type Json
} from '@aipoch/agent-harness'
import { createChatCompletionsModel } from '@aipoch/agent-harness/chat-completions'
import { createResponsesModel } from '@aipoch/agent-harness/responses'
import { createMessagesModel } from '@aipoch/agent-harness/messages'
import {
  HARNESS_AUTH_METHOD,
  HARNESS_INSTRUCTIONS,
  HARNESS_OWNER,
  harnessOwnerSchema,
  harnessConfigSchema,
  type HarnessConfig
} from './config'
import { connectHarnessMcp } from './mcp'

type Entry = {
  session: AgentSession
  close(): Promise<void>
  flush(): Promise<void>
  reconcile(): Promise<void>
  active: boolean
  cancelled: boolean
}
const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask' }] }

// Conservative text/envelope byte estimate. It is not a bound on provider-expanded media
// (PDF pages, remote URLs, audio or video); provider usage remains authoritative.
export const measureHarnessRequest = (request: ModelRequest): number =>
  Buffer.byteLength(JSON.stringify(request), 'utf8') + 1024

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
        fetch: (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set('user-agent', 'open-science-agent/0.1.0')
          if (target.sessionHeader) headers.set(target.sessionHeader, id)
          return fetch(url, { ...init, headers })
        },
        inputCapabilities: target.inputCapabilities,
        parameters: target.parameters as Record<string, Json>
      })
      session = await openAgentSession({
        sessionId: id,
        store,
        model,
        tools: mcp.tools,
        // Original results are already authorized evidence in this exact session; no external access.
        toolResults: {
          authorize: async (_args, context) => !context.signal.aborted && context.sessionId === id
        },
        signal,
        instructions,
        maxSteps: 64,
        maxOutputTokens: target.maxOutputTokens,
        compaction: {
          inputBudget: Math.floor(target.contextWindow * 0.9) - target.maxOutputTokens,
          keepRecentItems: 1,
          maxOutputTokens: Math.min(2048, target.maxOutputTokens),
          measure: measureHarnessRequest,
          admit: (request) => {
            if (measureHarnessRequest(request) + request.maxOutputTokens > target.contextWindow)
              throw new Error('Summary exceeds the model context budget')
          }
        },
        admit: (request) => {
          if (measureHarnessRequest(request) + request.maxOutputTokens > target.contextWindow)
            throw new Error('Request exceeds the model context budget')
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
            const status = await entry.session.prompt(blocks).catch(async (error: unknown) => {
              await entry.flush()
              if (!entry.cancelled) assertKnown(await entry.session.inspect())
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
