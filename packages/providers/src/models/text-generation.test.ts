import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { providerTextGenerationFailure } from '../errors'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createTextGenerationModel, type TextGenerationModel } from './text-generation'
import type { ProviderTextGenerationRequest } from '../protocols/text-types'
const textRunner = (
  fetchImpl: typeof fetch
): {
  run(input: ProviderTextGenerationRequest): ReturnType<TextGenerationModel['generate']>
} => ({
  run: ({ target, ...input }: ProviderTextGenerationRequest) =>
    createTextGenerationModel(target.vendorId ?? 'custom', target, fetchImpl).generate(input)
})

const protocolUrls = {
  'chat-completions': 'https://provider.example/v1/chat/completions',
  messages: 'https://provider.example/v1/messages',
  responses: 'https://provider.example/v1/responses'
}
const target = {
  model: 'science-model',
  key: 'private-key',
  protocol: 'chat-completions' as const,
  url: protocolUrls['chat-completions' as const]
}
const request = {
  target,
  systemPrompt: 'Translate faithfully.',
  prompt: '{"source":"Cell"}',
  signal: new AbortController().signal,
  maxOutputTokens: 8192,
  outputLimitBytes: 262144
}
const completion = { choices: [{ finish_reason: 'stop', message: { content: 'cell' } }] }

describe('provider text generation service', () => {
  it.each(['chat-completions', 'messages'] as const)(
    'makes one bounded, tool-less %s request',
    async (apiType) => {
      const fetchImpl = vi.fn(async () =>
        Response.json(
          apiType === 'chat-completions'
            ? completion
            : {
                stop_reason: 'end_turn',
                content: [
                  { type: 'thinking', thinking: 'private reasoning' },
                  { type: 'text', text: 'cell' }
                ]
              }
        )
      )
      const runner = textRunner(fetchImpl as typeof fetch)
      const result = await runner.run({
        ...request,
        target: { ...target, protocol: apiType, url: protocolUrls[apiType] }
      })
      expect(result).toEqual({ text: 'cell', stopReason: 'end_turn' })
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(
        `https://provider.example/v1/${apiType === 'chat-completions' ? 'chat/completions' : 'messages'}`
      )
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBe(request.signal)
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe(target.model)
      expect(body).not.toHaveProperty('tools')
      expect(body).not.toHaveProperty('previous_response_id')
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )
  it.each([
    { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'partial', tool_calls: [{}] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: ' ', refusal: 'refused' } }] },
    { choices: [{ message: { content: 'uncertain completion' } }] },
    null
  ])('rejects incomplete or non-text output', async (value) => {
    const runner = textRunner(vi.fn(async () => Response.json(value)))
    await expect(runner.run(request)).rejects.toThrow(
      '[provider-text-generation:incomplete-output]'
    )
  })
  it('ignores separate reasoning fields and joins only answer text blocks', async () => {
    const runner = textRunner(
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                reasoning_content: 'private reasoning',
                reasoning_details: [{ type: 'reasoning.text', text: 'private reasoning' }],
                content: [
                  { type: 'text', text: 'ce' },
                  { type: 'text', text: 'll' }
                ]
              }
            }
          ]
        })
      )
    )
    await expect(runner.run(request)).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
  })

  it.each(['chat-completions', 'messages'] as const)(
    'rejects reasoning-only %s responses',
    async (apiType) => {
      const runner = textRunner(
        vi.fn(async () =>
          Response.json(
            apiType === 'chat-completions'
              ? {
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { content: null, reasoning_content: 'private reasoning' }
                    }
                  ]
                }
              : {
                  stop_reason: 'end_turn',
                  content: [
                    { type: 'thinking', thinking: 'private reasoning' },
                    { type: 'redacted_thinking', data: 'opaque' }
                  ]
                }
          )
        )
      )
      await expect(
        runner.run({
          ...request,
          target: { ...target, protocol: apiType, url: protocolUrls[apiType] }
        })
      ).rejects.toThrow('[provider-text-generation:incomplete-output]')
    }
  )
  it('does not leak provider error bodies or retry a billed request', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('private-key and private PDF text', { status: 429 })
    )
    await expect(textRunner(fetchImpl).run(request)).rejects.toThrow('HTTP 429')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('honors cancellation and rejects oversized responses', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      return Response.json(completion)
    })
    await expect(
      textRunner(fetchImpl).run({ ...request, signal: controller.signal })
    ).rejects.toThrow()
    await expect(
      textRunner(vi.fn(async () => Response.json(completion))).run({
        ...request,
        outputLimitBytes: 10
      })
    ).rejects.toThrow('exceeded')
  })
})

it.each(['chat-completions', 'messages'] as const)(
  'reports %s billed usage even when the answer is rejected',
  async (apiType) => {
    const onUsage = vi.fn()
    const usage =
      apiType === 'chat-completions'
        ? {
            prompt_tokens: 100,
            completion_tokens: 12,
            prompt_tokens_details: { cached_tokens: 20 },
            completion_tokens_details: { reasoning_tokens: 8 }
          }
        : {
            input_tokens: 80,
            output_tokens: 12,
            cache_read_input_tokens: 15,
            cache_creation_input_tokens: 5
          }
    const fetchImpl = vi.fn(async () =>
      Response.json({
        usage,
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
        stop_reason: 'max_tokens',
        content: []
      })
    )
    await expect(
      textRunner(fetchImpl).run({
        ...request,
        onUsage,
        target: { ...target, protocol: apiType, url: protocolUrls[apiType] }
      })
    ).rejects.toThrow('incomplete-output')
    expect(onUsage).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 80, cacheTokens: 20, outputTokens: 12 })
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  }
)

it('retains usage on HTTP errors but does not estimate absent or invalid reports', async () => {
  for (const usage of [
    undefined,
    { prompt_tokens: -1, completion_tokens: 12 },
    { prompt_tokens: 3, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } },
    { prompt_tokens: 30, completion_tokens: 12 }
  ]) {
    const onUsage = vi.fn()
    const runner = textRunner(vi.fn(async () => Response.json({ usage }, { status: 500 })))
    await expect(runner.run({ ...request, onUsage })).rejects.toThrow('HTTP 500')
    expect(onUsage).toHaveBeenCalledTimes(usage?.prompt_tokens === 30 ? 1 : 0)
  }
})

const responsesMessage = {
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'cell' }]
}
const responsesCompletion = {
  status: 'completed',
  error: null,
  incomplete_details: null,
  output: [
    { type: 'reasoning', encrypted_content: 'private', summary: [{ text: 'private' }] },
    {
      ...responsesMessage,
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'working' }]
    },
    { ...responsesMessage, phase: 'final_answer' }
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 12,
    output_tokens_details: { reasoning_tokens: 8 },
    total_tokens: 112
  }
}
const responsesTarget = {
  ...target,
  protocol: 'responses' as const,
  url: protocolUrls['responses' as const]
}

it('uses stateless Responses final text and includes thinking in billed output exactly once', async () => {
  const onUsage = vi.fn()
  const fetchImpl = vi.fn(async () => Response.json(responsesCompletion))
  const runner = textRunner(fetchImpl)
  await expect(
    runner.run({ ...request, target: { ...responsesTarget, reasoningEffort: 'low' }, onUsage })
  ).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://provider.example/v1/responses')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-key')
  expect(JSON.parse(String(init.body))).toEqual({
    model: target.model,
    instructions: request.systemPrompt,
    input: [{ role: 'user', content: request.prompt }],
    store: false,
    stream: false,
    max_output_tokens: 8192,
    reasoning: { effort: 'low' }
  })
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({
    inputTokens: 80,
    cacheTokens: 20,
    cachedReadTokens: 20,
    cachedWriteTokens: 0,
    outputTokens: 12
  })
})

it.each([
  { status: 'incomplete' },
  { status: 'failed' },
  { status: 'in_progress' },
  { error: { message: 'private error' } },
  { incomplete_details: { reason: 'max_output_tokens' } },
  { output: [{ type: 'reasoning', summary: [] }] },
  { output: [{ ...responsesMessage, phase: 'commentary' }] },
  { output: [{ ...responsesMessage, status: 'incomplete' }] },
  { output: [{ ...responsesMessage, role: 'user' }] },
  { output: [{ ...responsesMessage, content: [{ type: 'refusal', refusal: 'private refusal' }] }] },
  { output: [responsesMessage, { type: 'function_call', name: 'bad', arguments: '{}' }] },
  { output: [] }
])(
  'rejects unfinished/tool/refusal Responses output while retaining reported usage: %j',
  async (override) => {
    const onUsage = vi.fn()
    const fetchImpl = vi.fn(async () => Response.json({ ...responsesCompletion, ...override }))
    await expect(
      textRunner(fetchImpl).run({
        ...request,
        target: responsesTarget,
        onUsage
      })
    ).rejects.toThrow('incomplete-output')
    expect(onUsage).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
  }
)

it.each([
  {
    vendorId: 'minimax' as const,
    effort: 'none' as const,
    fields: { thinking: { type: 'disabled' } }
  },
  {
    vendorId: 'minimax' as const,
    effort: 'high' as const,
    fields: { thinking: { type: 'adaptive' } }
  },
  {
    vendorId: 'deepseek' as const,
    effort: 'none' as const,
    fields: { thinking: { type: 'disabled' } }
  },
  {
    vendorId: 'deepseek' as const,
    effort: 'high' as const,
    fields: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
  },
  {
    vendorId: 'openrouter' as const,
    effort: 'none' as const,
    fields: { reasoning: { enabled: false } }
  },
  {
    vendorId: 'xiaomimimo' as const,
    effort: 'none' as const,
    fields: { thinking: { type: 'disabled' } }
  }
])(
  'uses the shared Chat thinking transport for $vendorId / $effort',
  async ({ vendorId, effort, fields }) => {
    const fetchImpl = vi.fn(async () => Response.json(completion))
    await textRunner(fetchImpl).run({
      ...request,
      target: { ...target, reasoningEffort: effort, vendorId }
    })
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    expect(body).toMatchObject({ ...fields, max_tokens: 8192 })
    expect(body).not.toHaveProperty('max_completion_tokens')
  }
)

it.each(['chat-completions', 'messages', 'responses'] as const)(
  'omits unknown thinking controls for %s and never falls back after errors',
  async (protocol) => {
    const onUsage = vi.fn()
    const fetchImpl = vi.fn(async () =>
      Response.json({ ...responsesCompletion, ...completion }, { status: 400 })
    )
    await expect(
      textRunner(fetchImpl).run({
        ...request,
        onUsage,
        target: {
          ...target,
          reasoningEffort: 'default',
          protocol: protocol,
          url: protocolUrls[protocol]
        }
      })
    ).rejects.toThrow('HTTP 400')
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    for (const field of ['thinking', 'reasoning', 'reasoning_effort', 'output_config'])
      expect(body).not.toHaveProperty(field)
    expect(fetchImpl).toHaveBeenCalledOnce()
  }
)

it('does not send an already-cancelled request', async () => {
  const fetchImpl = vi.fn(async () => Response.json(responsesCompletion))
  const signal = AbortSignal.abort()
  await expect(
    textRunner(fetchImpl).run({
      ...request,
      target: responsesTarget,
      signal
    })
  ).rejects.toThrow()
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('classifies a response-body abort without caller cancellation as a redacted network failure', async () => {
  const runner = textRunner(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":'))
              controller.error(
                new DOMException('This operation was aborted private-key', 'AbortError')
              )
            }
          })
        )
    )
  )
  const error = await runner.run(request).catch((error: unknown) => error)
  expect(request.signal.aborted).toBe(false)
  expect(providerTextGenerationFailure(error)).toEqual({ kind: 'network' })
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('[provider-text-generation:network-error]')
  expect((error as Error).message).not.toContain('private-key')
})

it('preserves caller cancellation during response-body reading without classifying it as network failure', async () => {
  const controller = new AbortController()
  const reason = new DOMException('This operation was aborted', 'AbortError')
  const runner = textRunner(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort(reason)
              stream.error(reason)
            }
          })
        )
    )
  )
  await expect(runner.run({ ...request, signal: controller.signal })).rejects.toBe(reason)
})

it.each([
  {
    model: 'claude-opus-5',
    vendorId: 'anthropic' as const,
    effort: 'low' as const,
    fields: { thinking: { type: 'disabled' } }
  },
  {
    model: 'claude-fable-5-1',
    vendorId: 'anthropic' as const,
    effort: 'low' as const,
    fields: { output_config: { effort: 'low' } }
  },
  {
    model: 'claude-sonnet-5',
    vendorId: 'anthropic' as const,
    effort: 'high' as const,
    fields: { output_config: { effort: 'high' } }
  },
  {
    model: 'MiniMax-M3',
    vendorId: 'minimax' as const,
    effort: 'none' as const,
    fields: { thinking: { type: 'disabled' } }
  },
  {
    model: 'MiniMax-M3',
    vendorId: 'minimax' as const,
    effort: 'high' as const,
    fields: { thinking: { type: 'adaptive' } }
  }
])('maps Messages thinking for $model / $effort', async ({ model, vendorId, effort, fields }) => {
  const fetchImpl = vi.fn(async () =>
    Response.json({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '', signature: 'opaque' },
        { type: 'text', text: 'cell' }
      ]
    })
  )
  await expect(
    textRunner(fetchImpl).run({
      ...request,
      target: {
        ...target,
        model,
        reasoningEffort: effort,
        vendorId,
        protocol: 'messages',
        url: protocolUrls['messages']
      }
    })
  ).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
  const body = JSON.parse(
    String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
  )
  expect(body).toMatchObject(fields)
  expect(body).not.toHaveProperty('reasoning_effort')
})

it('uses a custom gateway’s explicitly configured thinking transport without guessing from its model name', async () => {
  for (const reasoningEffortTransport of ['minimax', 'deepseek', 'reasoning-effort'] as const) {
    const fetchImpl = vi.fn(async () => Response.json(completion))
    await textRunner(fetchImpl).run({
      ...request,
      target: { ...target, reasoningEffort: 'none', reasoningEffortTransport }
    })
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    expect(body).toMatchObject(
      reasoningEffortTransport === 'reasoning-effort'
        ? { reasoning_effort: 'none', max_completion_tokens: 8192 }
        : { thinking: { type: 'disabled' }, max_tokens: 8192 }
    )
  }
})

it.each(['chat-completions', 'messages', 'responses'] as const)(
  'round-trips %s through a real local HTTP endpoint without a framework',
  async (protocol) => {
    const received: Array<{ url?: string; body: Record<string, unknown> }> = []
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      received.push({ url: req.url, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          protocol === 'chat-completions'
            ? completion
            : protocol === 'responses'
              ? responsesCompletion
              : {
                  stop_reason: 'end_turn',
                  content: [
                    { type: 'redacted_thinking', data: 'opaque' },
                    { type: 'text', text: 'cell' }
                  ]
                }
        )
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      const runner = textRunner(fetch)
      await expect(
        runner.run({
          ...request,
          target: {
            ...target,
            key: undefined,
            protocol: protocol,
            url: `http://127.0.0.1:${port}/gateway/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol === 'messages' ? 'messages' : 'responses'}`
          }
        })
      ).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe(
        `/gateway/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol === 'messages' ? 'messages' : 'responses'}`
      )
      expect(received[0].body).not.toHaveProperty('tools')
      expect(received[0].body).not.toHaveProperty('previous_response_id')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)

it.each(['chat-completions', 'messages', 'responses'] as const)(
  'bounds %s responses and retains complete billing when cancelled after receipt',
  async (protocol) => {
    const apiTarget = { ...target, protocol: protocol, url: protocolUrls[protocol] }
    const controller = new AbortController()
    const onUsage = vi.fn()
    const payload =
      protocol === 'chat-completions'
        ? { ...completion, usage: { prompt_tokens: 100, completion_tokens: 12 } }
        : protocol === 'responses'
          ? responsesCompletion
          : {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'cell' }],
              usage: { input_tokens: 100, output_tokens: 12 }
            }
    const runner = textRunner(
      vi.fn(async () => {
        controller.abort()
        return Response.json(payload)
      })
    )
    await expect(
      runner.run({ ...request, target: apiTarget, signal: controller.signal, onUsage })
    ).rejects.toThrow()
    expect(onUsage).toHaveBeenCalledOnce()
    await expect(
      textRunner(vi.fn(async () => Response.json(payload))).run({
        ...request,
        target: apiTarget,
        outputLimitBytes: 10
      })
    ).rejects.toThrow('exceeded')
  }
)

it.each(
  readFileSync(resolve(__dirname, '../../test/provider-error-diagnostics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as {
    name: string
    status: number
    kind: string
    providerCode?: string
  }[]
)(
  '$name: exposes redacted provider details across Electron serialization',
  async ({ status, kind, providerCode }) => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: providerCode,
            message: 'Synthetic provider diagnostic; private-key',
            authorization: 'Bearer secret-value'
          }
        },
        { status }
      )
    )
    const error = await textRunner(fetchImpl)
      .run(request)
      .catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    const wire = new Error(`Error invoking remote method: ${(error as Error).message}`)
    expect(providerTextGenerationFailure(wire)).toEqual({ kind, status })
    expect(wire.message).toContain('Synthetic provider diagnostic')
    expect(wire.message).not.toContain('private-key')
    expect(wire.message).not.toContain('secret-value')
    expect(fetchImpl).toHaveBeenCalledOnce()
  }
)
it('preserves network diagnostics without leaking the configured credential', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('ECONNRESET private-key')
  })
  const error = await textRunner(fetchImpl)
    .run(request)
    .catch((error: Error) => error)
  expect(providerTextGenerationFailure(error)).toEqual({ kind: 'network' })
  expect((error as Error).message).toContain('ECONNRESET')
  expect((error as Error).message).not.toContain('private-key')
})

it.each([
  { input_tokens: -1, output_tokens: 2 },
  { input_tokens: 1, output_tokens: 0.5 },
  {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: Number.MAX_SAFE_INTEGER,
    cache_creation_input_tokens: 1
  }
])(
  'rejects invalid or overflowing Anthropic usage while retaining valid answer text: %j',
  async (usage) => {
    const onUsage = vi.fn()
    const service = textRunner(async () =>
      Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }], usage })
    )
    await expect(
      service.run({
        ...request,
        target: { ...target, protocol: 'messages', url: protocolUrls['messages'] },
        onUsage
      })
    ).resolves.toEqual({ text: 'answer', stopReason: 'end_turn' })
    expect(onUsage).not.toHaveBeenCalled()
  }
)

describe.each(['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview'])(
  '%s direct text generation',
  (model) => {
    describe.each(['chat-completions', 'messages', 'responses'] as const)(
      '%s thinking controls',
      (protocol) => {
        it.each(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'default'] as const)(
          'maps %s effort without disabling thinking',
          async (effort) => {
            const fetchImpl = vi.fn(async () =>
              Response.json({
                ...completion,
                ...responsesCompletion,
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'cell' }]
              })
            )
            await expect(
              textRunner(fetchImpl).run({
                ...request,
                target: {
                  ...target,
                  model,
                  vendorId: 'minimax',
                  protocol,
                  url: protocolUrls[protocol],
                  reasoningEffort: effort
                }
              })
            ).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
            const body = JSON.parse(
              String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
            )
            if (effort === 'default') {
              for (const field of ['thinking', 'reasoning', 'reasoning_effort', 'output_config'])
                expect(body).not.toHaveProperty(field)
            } else {
              const expectedEffort = effort === 'none' ? 'low' : effort
              const fields =
                protocol === 'messages'
                  ? { thinking: { type: 'adaptive' }, output_config: { effort: expectedEffort } }
                  : protocol === 'responses'
                    ? { reasoning: { effort: expectedEffort } }
                    : { thinking: { type: 'adaptive' }, reasoning_effort: expectedEffort }
              expect(body).toMatchObject({ model, ...fields })
            }
            expect(fetchImpl).toHaveBeenCalledOnce()
          }
        )
      }
    )
  }
)
