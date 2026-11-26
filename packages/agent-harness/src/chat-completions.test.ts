import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createChatCompletionsModel } from './chat-completions'
import type { ChatCompletionsOptions } from './chat-completions'
import type { ModelEvent, ModelRequest } from './session-types'

const request = (): ModelRequest => ({
  requestId: 'request',
  instructions: 'system',
  messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  maxOutputTokens: 100
})
const chunk = (delta: object, finish_reason: string | null = null): object => ({
  choices: [{ index: 0, delta, finish_reason }]
})
const encode = (events: unknown[], done = true): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') +
  (done ? 'data: [DONE]\r\n\r\n' : '')
function response(text: string, cancel = vi.fn()): Response {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, ++offset))
      },
      cancel
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  )
}
const adapter = (
  fetch: typeof globalThis.fetch,
  options: Partial<ChatCompletionsOptions> = {}
): ReturnType<typeof createChatCompletionsModel> =>
  createChatCompletionsModel({
    endpoint: 'https://model.example/v1/chat/completions',
    model: 'fixture',
    apiKey: () => 'test-key',
    fetch,
    ...options
  })
async function collect(
  model: ReturnType<typeof adapter>,
  input = request(),
  signal = new AbortController().signal
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of model.stream(input, signal)) events.push(event)
  return events
}

describe('independent Chat Completions wire adapter', () => {
  it.each([
    ['repeated-stop', 'complete', 46, 4, 0],
    ['repeated-tool-calls', 'tools', 223, 13, 192],
    ['empty-choices', 'complete', 35, 5, 0]
  ] as const)(
    'accepts the captured %s stream with one final event',
    async (name, reason, inputTokens, outputTokens, cacheReadTokens) => {
      const wire = await readFile(
        new URL(`./fixtures/chat-completions/${name}.sse`, import.meta.url),
        'utf8'
      )
      const events = await collect(adapter(async () => response(wire)))
      expect(events.filter((event) => event.type === 'finish')).toEqual([
        expect.objectContaining({
          reason,
          content: reason === 'tools' ? [] : [{ type: 'text', text: 'PROBE_OK' }],
          usage: { inputTokens, outputTokens, cacheReadTokens },
          ...(reason === 'tools'
            ? {
                calls: [{ id: 'probe-id-007', name: 'protocol_probe', arguments: { value: 'OK' } }]
              }
            : {})
        })
      ])
    }
  )

  it.each([
    [{}, undefined],
    [{ content: null, reasoning_content: null, role: null }, null],
    [{ content: '', reasoning_content: '', role: '' }, ''],
    [{ role: 'assistant', tool_calls: [], reasoning_details: [], function_call: null }, 'stop'],
    [{ audio: null, video: '', image: null, extension: '' }, 'stop']
  ])('accepts empty terminal deltas %j with finish %s', async (delta, finish_reason) => {
    const usage = { prompt_tokens: 12, completion_tokens: 3 }
    const events = await collect(
      adapter(async () =>
        response(
          encode([
            chunk({ content: 'done', reasoning_content: 'thinking' }, 'stop'),
            { choices: [{ index: 0, delta, finish_reason }], usage },
            { choices: [{ index: 0, delta: {}, finish_reason }], usage },
            { choices: [{ index: 0, delta: {} }] }
          ])
        )
      )
    )
    expect(events).toEqual([
      { type: 'text-delta', text: 'done' },
      { type: 'reasoning-delta', text: 'thinking' },
      {
        type: 'finish',
        reason: 'complete',
        content: [{ type: 'text', text: 'done' }],
        providerState: { reasoning_content: 'thinking' },
        usage: { inputTokens: 12, outputTokens: 3 }
      }
    ])
  })

  it.each([
    ['new text', { delta: { content: 'late' } }],
    ['whitespace', { delta: { content: ' ' } }],
    ['new reasoning', { delta: { reasoning_content: '\n' } }],
    ['wrong text type', { delta: { content: [] } }],
    ['wrong reasoning type', { delta: { reasoning_content: 0 } }],
    ['role change', { delta: { role: 'user' } }],
    ['reasoning signature', { delta: { reasoning_details: [{ signature: 's' }] } }],
    ['wrong reasoning details type', { delta: { reasoning_details: '' } }],
    ['tool index', { delta: { tool_calls: [{ index: 0 }] } }],
    [
      'empty tool arguments',
      { delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }
    ],
    ['wrong tools type', { delta: { tool_calls: '' } }],
    ['legacy function call', { delta: { function_call: {} } }],
    ['empty legacy function call', { delta: { function_call: '' } }],
    ['audio payload', { delta: { audio: { data: 'audio' } } }],
    ['image payload', { delta: { image: 'image' } }],
    ['unknown object', { delta: { extension: {} } }],
    ['unknown array', { delta: { extension: [] } }],
    ['unknown number', { delta: { extension: 0 } }],
    ['unknown boolean', { delta: { extension: false } }],
    ['conflicting finish', { finish_reason: 'length' }],
    ['wrong finish type', { finish_reason: 0 }],
    ['non-main choice', { index: 1 }],
    ['missing index', { index: undefined }],
    ['missing delta', { delta: undefined }],
    ['null delta', { delta: null }],
    ['array delta', { delta: [] }]
  ])(
    'rejects terminal trailer with %s, including after a valid choice in the same event',
    async (_, invalid) => {
      const events: ModelEvent[] = []
      const model = adapter(async () =>
        response(
          encode([
            chunk({ content: 'done' }, 'stop'),
            {
              choices: [
                { index: 0, delta: {}, finish_reason: 'stop' },
                { index: 0, delta: {}, finish_reason: 'stop', ...invalid }
              ],
              usage: { prompt_tokens: 12, completion_tokens: 3 }
            }
          ])
        )
      )
      const run = async (): Promise<void> => {
        for await (const event of model.stream(request(), new AbortController().signal))
          events.push(event)
      }
      await expect(run()).rejects.toMatchObject({
        code: 'protocol',
        diagnostics: {
          phase: 'choice',
          finishReason: 'stop',
          eventCount: 2,
          receivedDone: false,
          usage: { inputTokens: 12, outputTokens: 3 }
        }
      })
      expect(events).toEqual([{ type: 'text-delta', text: 'done' }])
    }
  )

  it('retains the latest usage and length outcome after repeated terminal choices', async () => {
    const events = await collect(
      adapter(async () =>
        response(
          encode([
            chunk(
              { tool_calls: [{ index: 0, id: 'a', function: { name: 'sum', arguments: '{' } }] },
              'length'
            ),
            { ...chunk({}, 'length'), usage: { prompt_tokens: 1, completion_tokens: 1 } },
            {
              ...chunk({ role: 'assistant', content: '' }, 'length'),
              usage: { prompt_tokens: 12, completion_tokens: 3 }
            }
          ])
        )
      )
    )
    expect(events.filter((event) => event.type === 'finish')).toEqual([
      { type: 'finish', reason: 'length', content: [], usage: { inputTokens: 12, outputTokens: 3 } }
    ])
    const unknown = await collect(
      adapter(async () => response(encode([chunk({}, 'stop'), chunk({}, 'stop')])))
    )
    expect(unknown.at(-1)).toEqual({ type: 'finish', reason: 'complete', content: [] })
  })

  it.each([
    ['missing DONE', encode([chunk({}, 'stop'), chunk({}, 'stop')], false), 'missing-done'],
    ['invalid first finish', encode([chunk({}, '')]), 'choice'],
    [
      'invalid usage on trailer',
      encode([
        chunk({}, 'stop'),
        { ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: -1 } }
      ]),
      'usage'
    ],
    [
      'missing tool arguments',
      encode([
        chunk(
          { tool_calls: [{ index: 0, id: 'a', function: { name: 'sum', arguments: '{' } }] },
          'tool_calls'
        ),
        chunk({}, 'tool_calls')
      ]),
      'tool-arguments'
    ]
  ])('keeps %s strict after trailer compatibility', async (_, wire, phase) => {
    await expect(collect(adapter(async () => response(wire)))).rejects.toMatchObject({
      code: 'protocol',
      diagnostics: { phase }
    })
  })

  it('does not commit a terminal trailer on stream interruption or cancellation', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController()
      const events: ModelEvent[] = []
      const model = adapter(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(
                  new TextEncoder().encode(
                    encode([chunk({ content: 'done' }, 'stop'), chunk({}, 'stop')], false)
                  )
                )
              },
              pull(stream) {
                if (cancel) controller.abort()
                else stream.error(new Error('private transport failure'))
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
      )
      const run = async (): Promise<void> => {
        for await (const event of model.stream(request(), controller.signal)) events.push(event)
      }
      await expect(run()).rejects.toMatchObject(
        cancel
          ? { name: 'AbortError' }
          : {
              code: 'network',
              diagnostics: { phase: 'stream', finishReason: 'stop', eventCount: 2 }
            }
      )
      expect(events.filter((event) => event.type === 'finish')).toEqual([])
    }
  })

  it('assembles byte-split UTF-8, CRLF, reasoning, tools and usage after finish', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () =>
      response(
        encode([
          chunk({ reasoning_content: '想一想' }),
          chunk({ content: '你好' }),
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'original-call',
                type: 'function',
                function: { name: 'sum', arguments: '{"x":' }
              }
            ]
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, 'tool_calls'),
          {
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 3 }
          }
        ]),
        cancel
      )
    )
    const model = adapter(fetch)
    const events = await collect(model)
    expect(events.at(-1)).toEqual({
      type: 'finish',
      reason: 'tools',
      content: [{ type: 'text', text: '你好' }],
      calls: [{ id: 'original-call', name: 'sum', arguments: { x: 2 } }],
      providerState: { reasoning_content: '想一想' },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const [, init] = fetch.mock.calls[0] as unknown as Parameters<typeof globalThis.fetch>
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' })
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'fixture',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100
    })
    const replay = request()
    replay.messages.push(
      {
        id: 'assistant',
        role: 'assistant',
        content: [],
        calls: [{ id: 'original-call', name: 'sum', arguments: { x: 2 } }],
        providerState: { adapterId: model.id, value: { reasoning_content: '想一想' } }
      },
      {
        id: 'result',
        role: 'tool',
        invocationId: 'assistant/original-call',
        content: [{ type: 'text', text: '2' }]
      }
    )
    await collect(model, replay)
    const body = JSON.parse(
      (fetch.mock.calls[1] as unknown as Parameters<typeof globalThis.fetch>)[1]!.body as string
    )
    expect(body.messages[2]).toMatchObject({
      reasoning_content: '想一想',
      tool_calls: [{ id: 'original-call' }]
    })
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'original-call' })
  })

  it('does not replay foreign private reasoning or treat summaries as system instructions', async () => {
    const fetch = vi.fn(async () => response(encode([chunk({ content: 'ok' }, 'stop')])))
    const input = request()
    input.messages = [
      { id: 's', role: 'summary', content: [{ type: 'text', text: 'evidence' }] },
      {
        id: 'a',
        role: 'assistant',
        content: [],
        providerState: { adapterId: 'other', value: { reasoning_content: 'private' } }
      }
    ]
    await collect(adapter(fetch), input)
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as Parameters<typeof globalThis.fetch>)[1]!.body as string
    )
    expect(body.messages[1].role).toBe('user')
    expect(body.messages[2]).not.toHaveProperty('reasoning_content')
  })

  it.each([
    ['missing DONE', encode([chunk({ content: 'partial' }, 'stop')], false), 'missing-done'],
    ['missing finish', encode([chunk({ content: 'partial' })]), 'missing-finish'],
    ['invalid JSON', 'data: secret-invalid-json\n\ndata: [DONE]\n\n', 'event-json'],
    ['unterminated event', 'data: {"secret":"private"}', 'stream'],
    [
      'bad tool arguments',
      encode([
        chunk(
          { tool_calls: [{ index: 0, id: 'a', function: { name: 'sum', arguments: 'not JSON' } }] },
          'tool_calls'
        )
      ]),
      'tool-arguments'
    ],
    [
      'null initial tool id',
      encode([chunk({ tool_calls: [{ index: 0, id: null, function: { name: 'sum' } }] })]),
      'tool-delta'
    ],
    [
      'null initial tool name',
      encode([chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: null } }] })]),
      'tool-delta'
    ],
    ['upstream error', encode([{ error: { message: 'secret-upstream' } }]), 'provider'],
    [
      'provider status error',
      encode([{ base_resp: { status_code: 1000, status_msg: 'secret' } }]),
      'provider'
    ],
    ['after finish', encode([chunk({}, 'stop'), chunk({ content: 'late' })]), 'choice'],
    [
      'invalid usage',
      encode([
        chunk({}, 'stop'),
        { choices: [], usage: { prompt_tokens: -1, completion_tokens: 1 } }
      ]),
      'usage'
    ]
  ])(
    'rejects %s without yielding a finish or retaining non-error payloads',
    async (scenario, wire, phase) => {
      const events: ModelEvent[] = []
      const fetch = vi.fn(async () => response(wire))
      const run = async (): Promise<void> => {
        for await (const event of adapter(fetch).stream(request(), new AbortController().signal))
          events.push(event)
      }
      const error = await run().catch((error: unknown) => error)
      expect(error).toMatchObject({
        code: 'protocol',
        ...(scenario === 'upstream error' || scenario === 'provider status error'
          ? { status: 200 }
          : { message: 'Chat Completions protocol error' }),
        diagnostics: { phase }
      })
      expect(JSON.stringify(error)).not.toMatch(/secret|private|late/)
      expect(events.some((event) => event.type === 'finish')).toBe(false)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it('keeps observed usage separate from completion on failure without retaining raw values', async () => {
    const model = adapter(async () =>
      response(
        encode(
          [
            chunk({}, 'stop'),
            {
              choices: [],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                prompt_tokens_details: { cached_tokens: 8 },
                private_field: 'secret'
              }
            }
          ],
          false
        )
      )
    )
    const error = await collect(model).catch((error) => error)
    expect(error.diagnostics).toEqual({
      httpStatus: 200,
      phase: 'missing-done',
      eventCount: 2,
      receivedDone: false,
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 }
    })
    expect(Object.isFrozen(error.diagnostics)).toBe(true)
    expect(Object.isFrozen(error.diagnostics.usage)).toBe(true)
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(error.cause).toBeUndefined()
  })

  it('diagnoses wrong content type and stream limits without accepting the response', async () => {
    await expect(collect(adapter(async () => new Response('secret')))).rejects.toMatchObject({
      code: 'protocol',
      diagnostics: { httpStatus: 200, phase: 'response', eventCount: 0, receivedDone: false }
    })
    await expect(
      collect(
        adapter(async () => response(encode([chunk({}, 'stop')])), {
          maxResponseBytes: 1
        })
      )
    ).rejects.toMatchObject({
      code: 'limit',
      diagnostics: { phase: 'stream', eventCount: 0, receivedDone: false }
    })
  })

  it('reports length without executing a partial tool and preserves unknown usage', async () => {
    const events = await collect(
      adapter(async () =>
        response(
          encode([
            chunk(
              { tool_calls: [{ index: 0, id: 'a', function: { name: 'sum', arguments: '{' } }] },
              'length'
            )
          ])
        )
      )
    )
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length', content: [] })
  })

  it('bounds the stream and redacts HTTP/network failures without retrying', async () => {
    await expect(
      collect(
        adapter(async () => response(encode([chunk({ content: 'large' }, 'stop')])), {
          maxResponseBytes: 8
        })
      )
    ).rejects.toMatchObject({ code: 'limit' })
    const failed = vi.fn(async () => new Response('private upstream body', { status: 401 }))
    await expect(collect(adapter(failed))).rejects.toMatchObject({
      code: 'http',
      status: 401,
      message: 'Chat Completions HTTP 401'
    })
    expect(failed).toHaveBeenCalledOnce()
    await expect(
      collect(
        adapter(async () => {
          throw new Error('secret endpoint')
        })
      )
    ).rejects.toThrow('Chat Completions network error')
  })

  it('closes the reader when cancelled or when a consumer stops reading deltas', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(encode([chunk({ content: 'partial' })], false)))
      },
      cancel
    })
    const model = adapter(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    )
    const stream = model.stream(request(), controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'text-delta' })
    const waiting = stream.next()
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    const stop = vi.fn()
    for await (const event of adapter(async () =>
      response(encode([chunk({ content: 'first' }), chunk({}, 'stop')]), stop)
    ).stream(request(), new AbortController().signal)) {
      expect(event.type).toBe('text-delta')
      break
    }
    expect(stop).toHaveBeenCalledOnce()
  })

  it('refreshes credentials per call, maps images and rejects reserved tuning fields', async () => {
    let revision = 0
    const fetch = vi.fn(async () => response(encode([chunk({}, 'stop')])))
    const model = adapter(fetch, { apiKey: () => `key-${++revision}` })
    await collect(model)
    await collect(model)
    const auth = fetch.mock.calls.map(
      (args) =>
        (
          (args as unknown as Parameters<typeof globalThis.fetch>)[1]!.headers as Record<
            string,
            string
          >
        ).authorization
    )
    expect(auth).toEqual(['Bearer key-1', 'Bearer key-2'])
    expect(() => adapter(fetch, { parameters: { messages: [] } })).toThrow('Reserved')
    expect(() => adapter(fetch, { endpoint: 'https://key@example.com/chat/completions' })).toThrow(
      'endpoint'
    )
    const input = request()
    input.messages[0].content = [
      { type: 'image', mimeType: 'image/png', source: 'https://image.example' }
    ]
    await collect(model, input)
    expect(fetch).toHaveBeenCalledTimes(3)
    const body = JSON.parse(
      String((fetch.mock.calls[2] as unknown as [unknown, RequestInit])[1].body)
    ) as {
      messages: Array<{ content: unknown[] }>
    }
    expect((body.messages[1].content as unknown[])[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://image.example' }
    })
  })
})

it('accepts an explicit successful MiniMax trailer but never an unacknowledged EOF', async () => {
  const trailer = {
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 2 },
    base_resp: { status_code: 0 }
  }
  const events = await collect(
    adapter(async () => response(encode([chunk({ content: 'done' }, 'stop'), trailer], false)))
  )
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    reason: 'complete',
    usage: { inputTokens: 8, outputTokens: 2 }
  })
  for (const wire of [
    encode([chunk({ content: 'partial' }), trailer], false),
    encode([chunk({ content: 'partial' }, 'stop')], false),
    encode(
      [chunk({ content: 'partial' }, 'stop'), { ...trailer, base_resp: { status_code: 1000 } }],
      false
    )
  ])
    await expect(collect(adapter(async () => response(wire)))).rejects.toThrow()
})

it('projects tool images after the complete parallel tool batch with explicit provenance', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    response(encode([chunk({ content: 'done' }, 'stop')]))
  )
  const model = adapter(transport)
  const input = request()
  input.messages.push(
    {
      id: 'a',
      role: 'assistant',
      content: [],
      calls: [
        { id: 'c1', name: 'view', arguments: {} },
        { id: 'c2', name: 'read', arguments: {} }
      ]
    },
    {
      id: 't1',
      role: 'tool',
      invocationId: 'a/c1',
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', mimeType: 'image/png', source: 'data:image/png;base64,AA==' }
      ]
    },
    { id: 't2', role: 'tool', invocationId: 'a/c2', content: [{ type: 'text', text: 'receipt' }] }
  )
  const original = structuredClone(input)
  await collect(model, input)
  expect(input).toEqual(original)
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body))
  expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool',
    'tool',
    'user'
  ])
  expect(body.messages[3]).toMatchObject({
    tool_call_id: 'c1',
    content: expect.stringContaining('caption')
  })
  expect(body.messages[4]).toMatchObject({ tool_call_id: 'c2', content: 'receipt' })
  expect(body.messages[5].content).toEqual([
    { type: 'text', text: expect.stringContaining('untrusted tool output') },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
  ])
})

it('assembles structured reasoning fragments and replays signatures only to their original adapter', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    response(
      encode([
        chunk({
          reasoning_details: [{ type: 'reasoning.text', index: 0, id: 'r', text: 'first ' }]
        }),
        chunk({
          reasoning_details: [
            { type: 'reasoning.text', index: 0, id: 'r', text: 'second', signature: 'signed' }
          ]
        }),
        chunk({ reasoning_details: [{ type: 'reasoning.encrypted', index: 1, data: 'opaque' }] }),
        chunk({ content: 'answer' }, 'stop')
      ])
    )
  )
  const model = adapter(transport)
  const events = await collect(model)
  const final = events.at(-1)!
  if (final.type !== 'finish') throw new Error('Missing finish')
  const details = [
    { type: 'reasoning.text', index: 0, id: 'r', text: 'first second', signature: 'signed' },
    { type: 'reasoning.encrypted', index: 1, data: 'opaque' }
  ]
  expect(final.providerState).toEqual({ reasoning_details: details })
  const input = request()
  input.messages.push({
    id: 'a',
    role: 'assistant',
    content: final.content,
    providerState: { adapterId: model.id, value: final.providerState! }
  })
  await collect(model, input)
  expect(
    JSON.parse(String(transport.mock.calls[1][1]?.body)).messages.at(-1).reasoning_details
  ).toEqual(details)
  input.messages[1].providerState!.adapterId = 'another-model'
  await collect(model, input)
  expect(JSON.parse(String(transport.mock.calls[2][1]?.body)).messages.at(-1)).not.toHaveProperty(
    'reasoning_details'
  )
})
