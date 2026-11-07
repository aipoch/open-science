import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { normalizeChatCompletionsUsage, type ProviderTokenUsage } from '@aipoch/providers/protocol'
import {
  chatCompletionsToMessages,
  chatCompletionsToResponses,
  messagesToChatCompletions,
  responsesToChatCompletions
} from '@aipoch/providers/protocol'
import {
  fetchProviderRequest,
  readBoundedResponseText,
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
} from '@aipoch/providers/transport'
import type { HarnessProviderLease } from './provider-transport-owner'

export type HarnessModelObservation = Readonly<{
  requestId: string
  turnId: string
  step: number
  route: HarnessProviderLease['route']
  startedAt: number
  status: 'started' | 'completed' | 'failed' | 'interrupted'
  usage?: ProviderTokenUsage
  httpStatus?: number
}>
export type HarnessModelObserver = (event: HarnessModelObservation) => Promise<void>

const completion = z
  .object({
    choices: z
      .array(
        z.object({
          finish_reason: z.enum(['stop', 'tool_calls']),
          message: z
            .object({
              role: z.literal('assistant'),
              content: z.string().nullable().optional(),
              reasoning_content: z.string().optional(),
              tool_calls: z
                .array(
                  z.object({
                    id: z.string().min(1),
                    type: z.literal('function'),
                    function: z.object({ name: z.string().min(1), arguments: z.string() })
                  })
                )
                .optional()
            })
            .passthrough()
        })
      )
      .length(1)
  })
  .passthrough()
export type HarnessModelResult = Readonly<{
  response: z.infer<typeof completion>
  observation: HarnessModelObservation
}>

export async function requestHarnessModel(
  input: {
    model: Pick<HarnessProviderLease, 'route' | 'connection'>
    turnId: string
    step: number
    body: Readonly<Record<string, unknown>>
    signal: AbortSignal
    observe: HarnessModelObserver
  },
  fetchImpl: typeof fetch = fetch
): Promise<HarnessModelResult> {
  const { model, signal, observe } = input
  signal.throwIfAborted()
  if (
    !Array.isArray(input.body.messages) ||
    input.body.stream === true ||
    (input.body.n !== undefined && input.body.n !== 1)
  ) {
    throw new Error('Harness requires non-streaming messages with one completion')
  }
  const protocol = model.route.protocol
  const chat = { ...input.body, model: model.route.model, stream: false, n: 1 }
  const body = JSON.stringify(
    protocol === 'messages'
      ? chatCompletionsToMessages(chat, model.route.model)
      : protocol === 'responses'
        ? chatCompletionsToResponses(chat, model.route.model)
        : chat
  )
  const identity = {
    requestId: randomUUID(),
    turnId: input.turnId,
    step: input.step,
    route: Object.freeze({ ...model.route }),
    startedAt: Date.now()
  }
  await observe(Object.freeze({ ...identity, status: 'started' }))
  let status: HarnessModelObservation['status'] = 'completed'
  let usage: ProviderTokenUsage | undefined
  let httpStatus: number | undefined
  let response: z.infer<typeof completion> | undefined
  let failure: unknown
  try {
    signal.throwIfAborted()
    const upstream = await fetchProviderRequest(
      fetchImpl,
      `${model.connection.baseUrl}/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${model.connection.token}`,
          'content-type': 'application/json',
          ...(protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {})
        },
        body,
        signal
      }
    )
    httpStatus = upstream.status
    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new Error(`Harness provider HTTP ${httpStatus}`)
    }
    const text = await readBoundedResponseText(
      upstream,
      DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
      'Harness model response',
      undefined,
      signal
    )
    let raw: unknown
    try {
      const payload = JSON.parse(text)
      raw =
        protocol === 'messages'
          ? messagesToChatCompletions(payload, model.route.model)
          : protocol === 'responses'
            ? responsesToChatCompletions(payload, model.route.model)
            : payload
    } catch {
      throw new Error('Invalid harness model JSON')
    }
    if (raw && typeof raw === 'object' && 'usage' in raw) {
      const normalized = normalizeChatCompletionsUsage(raw.usage)
      if (normalized) usage = Object.freeze(normalized)
    }
    const parsed = completion.safeParse(raw)
    if (!parsed.success) throw new Error('Incomplete or invalid harness model response')
    response = parsed.data
    const choice = response.choices[0]
    if (
      (choice.finish_reason === 'tool_calls') !== !!choice.message.tool_calls?.length ||
      (choice.finish_reason === 'stop' && typeof choice.message.content !== 'string')
    ) {
      throw new Error('Incomplete or invalid harness model response')
    }
    signal.throwIfAborted()
  } catch (error) {
    status = signal.aborted ? 'interrupted' : 'failed'
    failure = error
  }
  const observation = Object.freeze({
    ...identity,
    status,
    ...(usage ? { usage } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus })
  })
  try {
    await observe(observation)
  } catch (error) {
    if (status !== 'completed')
      throw new AggregateError([failure, error], 'Harness request and observation failed')
    throw error
  }
  if (status !== 'completed') throw failure
  signal.throwIfAborted()
  return Object.freeze({ response: response!, observation })
}
