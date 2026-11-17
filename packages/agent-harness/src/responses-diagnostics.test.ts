import { describe, expect, it, vi } from 'vitest'
import { createResponsesModel } from './responses'
import type { ModelRequest } from './session-types'

const request: ModelRequest = {
  requestId: 'reproduction',
  instructions: 'test',
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  maxOutputTokens: 64
}
const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
async function run(response: Response): Promise<void> {
  const model = createResponsesModel({
    endpoint: 'https://fixture.example/responses',
    model: 'fixture',
    apiKey: () => 'private-key',
    fetch: async () => response
  })
  for await (const event of model.stream(request, new AbortController().signal)) void event
}

describe('Responses failure diagnostics', () => {
  it.each([500, 502, 529])(
    'retains HTTP %s without retaining the response body',
    async (status) => {
      const error = await run(new Response('private account details', { status })).catch(
        (error) => error
      )
      expect(error).toMatchObject({
        code: 'http',
        status,
        diagnostics: { phase: 'response', httpStatus: status, eventCount: 0 }
      })
      expect(JSON.stringify(error)).not.toMatch(/private/)
    }
  )
  it.each([
    [
      'missing-completion',
      sse([{ type: 'response.output_text.delta', delta: 'private answer' }]) + 'data: [DONE]\n\n',
      1,
      true
    ],
    ['stream', 'data: {"type":"response.completed","response":{}}', 0, false],
    ['event-json', 'data: {private malformed payload}\n\n', 1, false],
    [
      'provider',
      sse([
        {
          type: 'response.failed',
          response: { error: { code: 'private-code', message: 'private account' } }
        }
      ]),
      1,
      false
    ],
    ['event', sse([{ type: 'response.output_text.delta', delta: 42 }]), 1, false],
    [
      'tool-arguments',
      sse([
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'c', name: 'test', arguments: '{private' }
        },
        { type: 'response.completed', response: {} }
      ]),
      2,
      false
    ]
  ] as const)(
    'distinguishes %s from other generic protocol failures',
    async (phase, wire, eventCount, receivedDone) => {
      const error = await run(new Response(wire)).catch((error) => error)
      expect(error).toMatchObject({
        code: phase === 'provider' ? 'provider' : 'protocol',
        diagnostics: { phase, eventCount, receivedDone, httpStatus: 200 }
      })
      expect(JSON.stringify(error)).not.toMatch(/private/)
      expect(Object.isFrozen(error.diagnostics)).toBe(true)
    }
  )
  it('allows a completed response without a DONE sentinel', async () => {
    await expect(
      run(new Response(sse([{ type: 'response.completed', response: {} }])))
    ).resolves.toBeUndefined()
  })

  it.each([false, true])(
    'retains body-read failure evidence with provider provenance %s',
    async (provider) => {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller
            controller.enqueue(
              new TextEncoder().encode(
                sse([{ type: 'response.output_text.delta', delta: 'private answer' }])
              )
            )
          }
        }),
        {
          headers: {
            'x-open-science-request-id': 'request-123',
            ...(provider ? { 'x-open-science-response-source': 'provider' } : {})
          }
        }
      )
      const model = createResponsesModel({
        endpoint: 'https://fixture.example/responses',
        model: 'fixture',
        apiKey: () => 'private-key',
        fetch: async () => response
      })
      const stream = model.stream(request, new AbortController().signal)[Symbol.asyncIterator]()
      expect((await stream.next()).value).toMatchObject({ type: 'text-delta' })
      bodyController.error(new TypeError('private endpoint disconnected'))
      const error = await stream.next().catch((error: unknown) => error)
      expect(error).toMatchObject({
        code: 'network',
        diagnostics: {
          phase: 'stream',
          httpStatus: 200,
          requestId: 'request-123',
          eventCount: 1,
          receivedDone: false,
          receivedCompletion: false
        }
      })
      if (provider) expect(error).toHaveProperty('diagnostics.source', 'provider-transport')
      else expect(error).not.toHaveProperty('diagnostics.source')
      expect(JSON.stringify(error)).not.toMatch(/private/)
    }
  )

  it('preserves cancellation while waiting for the next provider event', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sse([{ type: 'response.output_text.delta', delta: 'partial' }])
            )
          )
        },
        cancel
      }),
      { headers: { 'x-open-science-response-source': 'provider' } }
    )
    const model = createResponsesModel({
      endpoint: 'https://fixture.example/responses',
      model: 'fixture',
      apiKey: () => 'private-key',
      fetch: async () => response
    })
    const abort = new AbortController()
    const stream = model.stream(request, abort.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'text-delta' })
    const waiting = stream.next()
    abort.abort()
    await expect(waiting).rejects.toBe(abort.signal.reason)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves application exceptions during credential resolution', async () => {
    const error = new TypeError('private application state')
    const model = createResponsesModel({
      endpoint: 'https://fixture.example/responses',
      model: 'fixture',
      apiKey: () => {
        throw error
      }
    })
    await expect(
      model.stream(request, new AbortController().signal)[Symbol.asyncIterator]().next()
    ).rejects.toBe(error)
  })

  it('keeps invalid UTF-8 distinct from a body-read transport failure', async () => {
    const response = new Response(new Uint8Array([0xff]), {
      headers: { 'x-open-science-response-source': 'provider' }
    })
    const error = await run(response).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toHaveProperty('code', 'network')
  })
})
