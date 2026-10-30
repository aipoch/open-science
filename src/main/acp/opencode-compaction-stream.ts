import type { AnyMessage, JsonRpcId, Stream } from '@agentclientprotocol/sdk'
import type { ResolvedAgentBackend } from '../agent-framework'
import { isRecord } from '../value-guards'

type MessageIdentity = { sessionId: string; messageId: string }
type Classification = { summary: boolean; finished: boolean; succeeded: boolean }

const classificationError = (): Error =>
  new Error(
    'OpenCode message classification failed. Output was withheld. Check the local OpenCode service and use an OpenCode 1.x version that supplies ACP message IDs.'
  )

const lifecycle = (
  identity: MessageIdentity,
  status: 'started' | 'completed' | 'failed'
): AnyMessage => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: identity.sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      _meta: { 'opencode/compaction': { messageId: identity.messageId, reason: 'auto', status } }
    }
  }
})

// OpenCode 1.x can put a part ID on reasoning chunks. Normalize it before the SDK queues or
// observes the update, including session/load replay. Never inspect prose or modify native history.
export function createOpenCodeCompactionStream(
  stream: Stream,
  options: {
    api: ResolvedAgentBackend['opencodeUsageApi']
    resolveSessionCwd: (sessionId: string) => string
    signal: AbortSignal
    fetchImpl?: typeof fetch
  }
): Stream {
  const cache = new Map<string, Classification>()
  const pending = new Map<string, MessageIdentity>()
  const requests = new Map<JsonRpcId, { method: string; sessionId?: string; cwd?: string }>()
  const sessionCwds = new Map<string, string>()
  const partMessages = new Map<string, string>()
  const abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal])
  const clear = (): void => {
    cache.clear()
    pending.clear()
    requests.clear()
    sessionCwds.clear()
    partMessages.clear()
  }
  signal.addEventListener('abort', clear, { once: true })
  const resolveMessageId = async (identity: MessageIdentity): Promise<MessageIdentity> => {
    try {
      if (!identity.messageId.startsWith('prt_')) return identity
      const cached = partMessages.get(`${identity.sessionId}:${identity.messageId}`)
      if (cached) return { ...identity, messageId: cached }
      if (!options.api || signal.aborted) throw classificationError()
      const url = new URL(
        `/session/${encodeURIComponent(identity.sessionId)}/message`,
        options.api.baseUrl
      )
      const loading = [...requests.values()].find(
        (request) => request.sessionId === identity.sessionId && request.cwd
      )
      url.searchParams.set(
        'directory',
        loading?.cwd ??
          sessionCwds.get(identity.sessionId) ??
          options.resolveSessionCwd(identity.sessionId)
      )
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { authorization: options.api.authorization },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      })
      if (!response.ok) throw classificationError()
      const body: unknown = await response.json()
      const messages = Array.isArray(body)
        ? body
        : isRecord(body) && Array.isArray(body.data)
          ? body.data
          : undefined
      const match = messages?.find((message) => {
        if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts))
          return false
        return (
          message.info.sessionID === identity.sessionId &&
          message.info.role === 'assistant' &&
          typeof message.info.id === 'string' &&
          message.parts.some((part) => isRecord(part) && part.id === identity.messageId)
        )
      })
      const messageId = isRecord(match) && isRecord(match.info) ? match.info.id : undefined
      if (typeof messageId !== 'string' || !messageId.startsWith('msg_'))
        throw classificationError()
      partMessages.set(`${identity.sessionId}:${identity.messageId}`, messageId)
      return { ...identity, messageId }
    } catch {
      throw classificationError()
    }
  }
  const classify = async (identity: MessageIdentity): Promise<Classification> => {
    try {
      if (!options.api || signal.aborted) throw classificationError()
      const url = new URL(
        `/session/${encodeURIComponent(identity.sessionId)}/message/${encodeURIComponent(identity.messageId)}`,
        options.api.baseUrl
      )
      // Replay arrives before session/load attaches the ActiveSession to the registry.
      const loading = [...requests.values()].find(
        (request) => request.sessionId === identity.sessionId && request.cwd
      )
      url.searchParams.set(
        'directory',
        loading?.cwd ??
          sessionCwds.get(identity.sessionId) ??
          options.resolveSessionCwd(identity.sessionId)
      )
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { authorization: options.api.authorization },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      })
      if (!response.ok) throw classificationError()
      const body: unknown = await response.json()
      const info = isRecord(body) ? body.info : undefined
      if (
        signal.aborted ||
        !isRecord(info) ||
        info.id !== identity.messageId ||
        info.sessionID !== identity.sessionId ||
        info.role !== 'assistant' ||
        (info.summary !== undefined && typeof info.summary !== 'boolean')
      )
        throw classificationError()
      return {
        summary: info.summary === true,
        finished: typeof info.finish === 'string' || info.error != null,
        succeeded: info.finish === 'stop' && info.error == null
      }
    } catch {
      // Native response bodies, paths and transport errors may contain internal context.
      throw classificationError()
    }
  }
  const finish = async (
    sessionId: string,
    controller: TransformStreamDefaultController<AnyMessage>
  ): Promise<void> => {
    for (const [key, identity] of pending) {
      if (identity.sessionId !== sessionId) continue
      const info = await classify(identity)
      controller.enqueue(lifecycle(identity, info.succeeded ? 'completed' : 'failed'))
      pending.delete(key)
    }
  }
  const writer = stream.writable.getWriter()
  return {
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        if (
          'method' in message &&
          'id' in message &&
          [
            'session/new',
            'session/load',
            'session/resume',
            'session/fork',
            'session/prompt',
            'session/close',
            'session/delete'
          ].includes(message.method) &&
          isRecord(message.params)
        ) {
          requests.set(message.id, {
            method: message.method,
            ...(typeof message.params.sessionId === 'string'
              ? { sessionId: message.params.sessionId }
              : {}),
            ...(typeof message.params.cwd === 'string' ? { cwd: message.params.cwd } : {})
          })
        }
        await writer.write(message)
      },
      close: () => writer.close(),
      abort: (reason) => {
        abort.abort()
        return writer.abort(reason)
      }
    }),
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        async transform(message, controller) {
          if (signal.aborted) throw classificationError()
          if (!('method' in message)) {
            const request = requests.get(message.id)
            if (
              request?.sessionId &&
              ['session/prompt', 'session/load', 'session/resume'].includes(request.method)
            ) {
              await finish(request.sessionId, controller)
            }
            if (request && 'result' in message) {
              const providerSessionId =
                isRecord(message.result) && typeof message.result.sessionId === 'string'
                  ? message.result.sessionId
                  : request.sessionId
              if (request.cwd && providerSessionId) sessionCwds.set(providerSessionId, request.cwd)
              if (
                request.sessionId &&
                ['session/close', 'session/delete'].includes(request.method)
              ) {
                sessionCwds.delete(request.sessionId)
                // Cached identity contains no content and is bounded. Reclassify after a close,
                // including a later load of the same native ID in another working directory.
                cache.clear()
                partMessages.clear()
                for (const [key, identity] of pending) {
                  if (identity.sessionId === request.sessionId) pending.delete(key)
                }
              }
            }
            requests.delete(message.id)
            controller.enqueue(message)
            return
          }
          const params = message.params
          const update = isRecord(params) ? params.update : undefined
          if (
            message.method !== 'session/update' ||
            !isRecord(update) ||
            !['agent_message_chunk', 'agent_thought_chunk'].includes(String(update.sessionUpdate))
          ) {
            controller.enqueue(message)
            return
          }
          if (
            !isRecord(params) ||
            typeof params.sessionId !== 'string' ||
            typeof update.messageId !== 'string' ||
            !update.messageId
          )
            throw classificationError()
          const incoming = { sessionId: params.sessionId, messageId: update.messageId }
          const identity = await resolveMessageId(incoming)
          const normalized =
            identity.messageId === incoming.messageId
              ? message
              : ({
                  ...message,
                  params: {
                    ...params,
                    update: { ...update, messageId: identity.messageId }
                  }
                } as AnyMessage)
          const key = JSON.stringify([identity.sessionId, identity.messageId])
          let info = cache.get(key)
          if (!info) {
            info = await classify(identity)
            // Bound per-connection identity memory; eviction only causes another safe lookup.
            if (cache.size >= 256) cache.delete(cache.keys().next().value!)
            cache.set(key, info)
            if (info.summary) {
              controller.enqueue(
                lifecycle(
                  identity,
                  info.finished ? (info.succeeded ? 'completed' : 'failed') : 'started'
                )
              )
              if (!info.finished) pending.set(key, identity)
            }
          }
          if (info.summary) return
          await finish(identity.sessionId, controller)
          controller.enqueue(normalized)
        },
        flush: clear
      }),
      { signal }
    )
  }
}
