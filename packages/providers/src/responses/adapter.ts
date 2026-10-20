import { responsesToChatCompletionsRequest, type ResponsesRequestAdapterOptions } from './request'
import { completionToResponse } from './response'
import { convertChatStream, type ReplayReply } from './stream'
import { ReasoningReplay } from './replay'
import { DEFAULT_MAX_PROVIDER_RESPONSE_BYTES, readBoundedResponseText } from '../transport/body'
import type { ResponsesNamespacedTool } from './types'
// Extensible wire records are validated by the conversion boundary before execution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

export type ResponsesAdapterOptions = Readonly<{
  maxResponseBytes?: number
  reasoningCacheMaxEntries?: number
  reasoningCacheMaxCharacters?: number
}>
export type ResponsesTurnInput = Readonly<{
  body: JsonObject
  scope?: string
  model?: string
  tools?: readonly ResponsesNamespacedTool[]
  reasoning?: ResponsesRequestAdapterOptions
}>
export type ResponsesTurn = Readonly<{
  request: JsonObject
  convert(upstream: Response): Promise<Response>
}>
export type ResponsesAdapter = Readonly<{
  prepare(input: ResponsesTurnInput): ResponsesTurn
  clear(): void
  dispose(): void
}>

/** Protocol replay is owned here; the caller supplies an authorized opaque scope and tool list. */
export function createResponsesAdapter(options: ResponsesAdapterOptions = {}): ResponsesAdapter {
  const limits = {
    maxResponseBytes: options.maxResponseBytes,
    reasoningCacheMaxEntries: options.reasoningCacheMaxEntries,
    reasoningCacheMaxCharacters: options.reasoningCacheMaxCharacters
  }
  for (const value of Object.values(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new RangeError('Adapter limits must be positive safe integers')
  }
  const replay = new ReasoningReplay(limits)
  const active = new Set<AbortController>()
  let generation = 0
  let disposed = false
  const clear = (): void => {
    generation += 1
    replay.clear()
  }
  return {
    clear,
    dispose() {
      disposed = true
      clear()
      for (const controller of active) controller.abort()
      active.clear()
    },
    prepare(input) {
      if (disposed) throw new Error('Responses adapter is disposed')
      const epoch = generation
      const scope = input.scope
      // Snapshot caller-owned data so later edits cannot change an in-flight conversion's scope/tools.
      const tools = structuredClone(input.tools ?? [])
      const body = structuredClone(input.body)
      const request = responsesToChatCompletionsRequest(
        body,
        input.model,
        replay.forRequest(scope),
        tools,
        input.reasoning
      )
      // A rejected request must not prune valid replay history.
      replay.reconcile(scope, body.input)
      const streaming = request.stream === true
      const model = String(request.model ?? '')
      let converted = false
      const record = (reply: ReplayReply): void => {
        if (!disposed && epoch === generation)
          replay.record(scope, reply.reasoning, reply.callIds, reply.messageId)
      }
      return {
        request,
        async convert(upstream) {
          if (converted) throw new Error('Responses turn is already converted')
          converted = true
          if (disposed) {
            await upstream.body?.cancel()
            throw new Error('Responses adapter is disposed')
          }
          const maxBytes = limits.maxResponseBytes ?? DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
          const controller = new AbortController()
          active.add(controller)
          controller.signal.addEventListener(
            'abort',
            () => {
              if (!upstream.body?.locked)
                void upstream.body?.cancel(controller.signal.reason).catch(() => undefined)
            },
            { once: true }
          )
          if (!streaming) {
            try {
              const completion = JSON.parse(
                await readBoundedResponseText(
                  upstream,
                  maxBytes,
                  'Chat Completions upstream response',
                  undefined,
                  controller.signal
                )
              ) as JsonObject
              const result = completionToResponse(completion, tools)
              const items: JsonObject[] = result.output ?? []
              const reasoning = completion.choices?.[0]?.message?.reasoning_content
              record({
                reasoning: typeof reasoning === 'string' ? reasoning : '',
                callIds: items
                  .filter((item) => item.type === 'function_call')
                  .map((item) => String(item.call_id)),
                messageId: items.find((item) => item.type === 'message')?.id
              })
              return Response.json(result)
            } finally {
              active.delete(controller)
            }
          }
          const iterator = convertChatStream(
            upstream,
            model,
            tools,
            maxBytes,
            record,
            controller.signal
          )
          const encoder = new TextEncoder()
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(output) {
                try {
                  const next = await iterator.next()
                  if (next.done) {
                    active.delete(controller)
                    output.close()
                  } else output.enqueue(encoder.encode(next.value))
                } catch (error) {
                  active.delete(controller)
                  output.error(error)
                }
              },
              async cancel(reason) {
                controller.abort(reason)
                active.delete(controller)
                await iterator.return(undefined)
                if (!upstream.body?.locked)
                  await upstream.body?.cancel(reason).catch(() => undefined)
              }
            }),
            { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }
          )
        }
      }
    }
  }
}

/** Stateless request conversion for probes that do not need replay or response adaptation. */
export function convertResponsesRequest(input: Omit<ResponsesTurnInput, 'scope'>): JsonObject {
  return responsesToChatCompletionsRequest(
    input.body,
    input.model,
    undefined,
    input.tools,
    input.reasoning
  )
}
