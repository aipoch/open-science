import { describe, expect, it } from 'vitest'
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
})
