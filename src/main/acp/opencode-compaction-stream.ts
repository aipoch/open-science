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

// OpenCode 1.x omits summary identity from ACP chunks. Classify before the SDK queues or
// observes them, including session/load replay. Never inspect prose or modify native history.
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
  const requests = new Map<JsonRpcId, { sessionId: string; cwd?: string }>()
  const abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal])
  const clear = (): void => {
    cache.clear()
    pending.clear()
    requests.clear()
  }
  signal.addEventListener('abort', clear, { once: true })
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
        loading?.cwd ?? options.resolveSessionCwd(identity.sessionId)
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
          ['session/prompt', 'session/load', 'session/resume'].includes(message.method) &&
          isRecord(message.params) &&
          typeof message.params.sessionId === 'string'
        ) {
          requests.set(message.id, {
            sessionId: message.params.sessionId,
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
            if (request) await finish(request.sessionId, controller)
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
          const identity = { sessionId: params.sessionId, messageId: update.messageId }
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
          controller.enqueue(message)
        },
        flush: clear
      }),
      { signal }
    )
  }
}
