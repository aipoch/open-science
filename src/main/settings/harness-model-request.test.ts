import { describe, expect, it, vi } from 'vitest'
import { requestHarnessModel, type HarnessModelObservation } from './harness-model-request'

const model = Object.freeze({
  route: Object.freeze({
    id: 'route-1',
    providerId: 'p1',
    configRevision: 4,
    model: 'bound-model',
    protocol: 'chat-completions' as const
  }),
  connection: Object.freeze({ baseUrl: 'http://127.0.0.1:1234', token: 'local-token' })
})
const response = (
  finish = 'stop',
  usage: unknown = {
    prompt_tokens: 20,
    completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 5 }
  }
): object => ({
  choices: [{ finish_reason: finish, message: { role: 'assistant', content: 'done' } }],
  usage
})
const invoke = (
  fetchImpl: typeof fetch,
  options: Partial<Parameters<typeof requestHarnessModel>[0]> = {}
): ReturnType<typeof requestHarnessModel> =>
  requestHarnessModel(
    {
      model,
      turnId: 'turn-1',
      step: 2,
      body: { messages: [] },
      signal: new AbortController().signal,
      observe: async () => undefined,
      ...options
    },
    fetchImpl
  )

describe('harness model requests', () => {
  it('pins model identity, snapshots input and records normalized usage after a started receipt', async () => {
    const events: HarnessModelObservation[] = []
    const body = { model: 'override', messages: [{ role: 'user', content: 'before' }] }
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(events.map((event) => event.status)).toEqual(['started'])
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'bound-model',
        n: 1,
        stream: false,
        messages: [{ content: 'before' }]
      })
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-token')
      return Response.json(response())
    })
    const result = await invoke(fetchImpl, {
      body,
      observe: async (event) => {
        events.push(event)
        body.messages[0].content = 'after'
      }
    })
    expect(events.map((event) => event.status)).toEqual(['started', 'completed'])
    expect(events[1]).toMatchObject({
      requestId: events[0].requestId,
      turnId: 'turn-1',
      step: 2,
      route: model.route,
      usage: { inputTokens: 15, outputTokens: 3, cacheTokens: 5 }
    })
    expect(result.observation).toBe(events[1])
    expect(Object.isFrozen(events[1].usage)).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/local-token|before|after/)
  })

  it.each([undefined, { prompt_tokens: -1, completion_tokens: 3 }])(
    'leaves missing or invalid usage unknown: %j',
    async (usage) => {
      const result = await invoke(async () => Response.json({ ...response(), usage }))
      expect(result.observation).not.toHaveProperty('usage')
    }
  )

  it.each(['length', 'content_filter', null])(
    'rejects nonterminal %s while preserving available usage',
    async (finish) => {
      const observe = vi.fn(async () => undefined)
      await expect(
        invoke(
          async () =>
            Response.json({
              ...response(),
              choices: [
                {
                  finish_reason: finish,
                  message: { role: 'assistant', content: 'partial' }
                }
              ]
            }),
          { observe }
        )
      ).rejects.toThrow('Incomplete')
      expect(observe).toHaveBeenCalledTimes(2)
      expect(observe.mock.calls.at(-1)).toEqual([
        expect.objectContaining({ status: 'failed', usage: expect.any(Object) })
      ])
    }
  )

  it.each([
    {},
    { choices: [] },
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null } }] }
  ])('rejects malformed completions: %j', async (body) => {
    await expect(invoke(async () => Response.json(body))).rejects.toThrow('Incomplete')
  })

  it('does not send if the started observation cannot be recorded', async () => {
    const fetchImpl = vi.fn()
    await expect(
      invoke(fetchImpl, {
        observe: async () => {
          throw new Error('store unavailable')
        }
      })
    ).rejects.toThrow('store unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not expose malformed upstream text through parser errors', async () => {
    await expect(invoke(async () => new Response('private malformed content'))).rejects.toThrow(
      'Invalid harness model JSON'
    )
  })

  it('retains the completed observation if cancellation arrives while recording it', async () => {
    const controller = new AbortController()
    const observe = vi.fn(async (event: HarnessModelObservation) => {
      if (event.status === 'completed') controller.abort()
    })
    await expect(
      invoke(async () => Response.json(response()), { signal: controller.signal, observe })
    ).rejects.toThrow()
    expect(observe.mock.calls.map(([event]) => event.status)).toEqual(['started', 'completed'])
    expect(observe.mock.calls[1][0].usage).toBeDefined()
  })

  it('does not resend or emit a second terminal event when completion recording fails', async () => {
    const fetchImpl = vi.fn(async () => Response.json(response()))
    const observe = vi.fn(async (event: HarnessModelObservation) => {
      if (event.status === 'completed') throw new Error('completion write failed')
    })
    await expect(invoke(fetchImpl, { observe })).rejects.toThrow('completion write failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('retains network and observation failures without exposing upstream content', async () => {
    const observe = vi.fn(async (event: HarnessModelObservation) => {
      if (event.status === 'failed') throw new Error('write failed')
    })
    const fetchImpl = vi.fn(async () => new Response('private upstream content', { status: 503 }))
    await expect(invoke(fetchImpl, { observe })).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'Harness provider HTTP 503' }),
        expect.objectContaining({ message: 'write failed' })
      ]
    })
    expect(JSON.stringify(observe.mock.calls)).not.toContain('private upstream content')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('records interruption before sending if cancellation arrives during started observation', async () => {
    const controller = new AbortController()
    const observe = vi.fn(async (event: HarnessModelObservation) => {
      if (event.status === 'started') controller.abort()
    })
    const fetchImpl = vi.fn()
    await expect(invoke(fetchImpl, { signal: controller.signal, observe })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ status: 'interrupted' })])
  })

  it('cancels a response body while it is being read', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const observe = vi.fn(async () => undefined)
    await expect(
      invoke(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                controller.abort()
              },
              cancel
            })
          ),
        { signal: controller.signal, observe }
      )
    ).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ status: 'interrupted' })])
  })

  it.each([{ messages: [], stream: true }, { messages: [], n: 2 }, { input: 'wrong protocol' }])(
    'rejects unsupported request shape before observation: %j',
    async (body) => {
      const fetchImpl = vi.fn(),
        observe = vi.fn()
      await expect(invoke(fetchImpl, { body, observe })).rejects.toThrow('non-streaming')
      expect(observe).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('bounds the response before accepting a completion', async () => {
    const cancel = vi.fn()
    const observe = vi.fn(async () => undefined)
    await expect(
      invoke(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { 'content-length': String(65 * 1024 * 1024) }
          }),
        { observe }
      )
    ).rejects.toThrow('exceeded')
    expect(cancel).toHaveBeenCalled()
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ status: 'failed' })])
  })
})

it.each(['messages', 'responses'] as const)(
  'keeps legacy step requests usable over native %s leases',
  async (protocol) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        protocol === 'messages'
          ? {
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'bound-model',
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 20, output_tokens: 3 }
            }
          : {
              id: 'r',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
              usage: { input_tokens: 20, output_tokens: 3 }
            }
      )
    )
    const result = await invoke(fetchImpl, {
      model: { ...model, route: { ...model.route, protocol } },
      body: { messages: [{ role: 'user', content: 'hello' }] }
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1234/v1/${protocol}`)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toHaveProperty(
      protocol === 'messages' ? 'messages' : 'input'
    )
    expect(result.response.choices[0].message.content).toBe('done')
  }
)
