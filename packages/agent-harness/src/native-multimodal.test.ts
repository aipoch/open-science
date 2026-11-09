import { describe, expect, it, vi } from 'vitest'
import { createMessagesModel } from './messages'
import { createResponsesModel } from './responses'
import type { AgentModel, Json, ModelEvent, ModelRequest } from './session-types'

const request: ModelRequest = {
  requestId: 'r',
  instructions: 'system',
  tools: [],
  maxOutputTokens: 128,
  messages: [
    {
      id: 'u',
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', source: 'data:image/png;base64,AA==' }]
    }
  ]
}
const sse = (events: unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
const complete = async (
  model: AgentModel,
  input = request
): Promise<Extract<ModelEvent, { type: 'finish' }>> => {
  for await (const event of model.stream(input, new AbortController().signal))
    if (event.type === 'finish') return event
  throw new Error('No finish')
}
const continuation = (model: AgentModel, state?: Json): ModelRequest => ({
  ...request,
  messages: [
    ...request.messages,
    {
      id: 'assistant/long-id',
      role: 'assistant',
      content: [],
      calls: [{ id: 'tool_123', name: 'view', arguments: {} }],
      ...(state ? { providerState: { adapterId: model.id, value: state } } : {})
    },
    {
      id: 't',
      role: 'tool',
      invocationId: 'assistant/long-id/tool_123',
      content: request.messages[0].content,
      isError: true
    }
  ]
})

describe('native image and reasoning replay', () => {
  it('keeps Messages images inside tool results, signed/redacted thinking and native call ids', async () => {
    const thinking = { type: 'thinking', thinking: 'inspect', signature: 'signature_123' }
    const redacted = { type: 'redacted_thinking', data: 'opaque' }
    const transport = vi.fn<typeof fetch>(async () =>
      sse([
        { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'inspect' } },
        {
          type: 'content_block_delta',
          delta: { type: 'signature_delta', signature: 'signature_123' }
        },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: redacted },
        { type: 'content_block_stop' },
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool_123', name: 'view', input: {} }
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"path":' }
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '"plot.png"}' }
        },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' }
      ])
    )
    const model = createMessagesModel({
      endpoint: 'https://example.test/v1/messages',
      model: 'vision',
      apiKey: () => 'secret',
      fetch: transport
    })
    const result = await complete(model)
    expect(result.calls?.[0].arguments).toEqual({ path: 'plot.png' })
    expect(result.providerState).toEqual({ thinking_blocks: [thinking, redacted] })
    const input = continuation(model, result.providerState)
    await complete(model, input)
    const body = JSON.parse(String(transport.mock.calls[1][1]?.body))
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AA==' }
    }
    expect(body.messages[0].content).toEqual([image])
    expect(body.messages[1].content).toEqual([
      thinking,
      redacted,
      { type: 'tool_use', id: 'tool_123', name: 'view', input: {} }
    ])
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool_123', content: [image], is_error: true }
    ])
    input.messages[1].providerState!.adapterId = 'another-provider'
    await complete(model, input)
    expect(JSON.parse(String(transport.mock.calls[2][1]?.body)).messages[1].content).toHaveLength(1)
  })

  it('keeps Responses image outputs and encrypted reasoning in stateless tool continuation', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }
    const transport = vi.fn<typeof fetch>(async () =>
      sse([
        { type: 'response.output_item.done', item: reasoning },
        { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2 } } }
      ])
    )
    const model = createResponsesModel({
      endpoint: 'https://example.test/v1/responses',
      model: 'vision',
      apiKey: () => 'secret',
      fetch: transport
    })
    const result = await complete(model)
    const input = continuation(model, result.providerState)
    await complete(model, input)
    const body = JSON.parse(String(transport.mock.calls[1][1]?.body))
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
    expect(body.store).toBe(false)
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(body.input).toEqual([
      { role: 'user', content: [image] },
      reasoning,
      { type: 'function_call', call_id: 'tool_123', name: 'view', arguments: '{}' },
      { type: 'function_call_output', call_id: 'tool_123', output: [image] }
    ])
    input.messages[1].providerState!.adapterId = 'another-provider'
    await complete(model, input)
    expect(JSON.parse(String(transport.mock.calls[2][1]?.body)).input).toHaveLength(3)
  })

  it('recognizes Responses output exhaustion from incomplete_details', async () => {
    const model = createResponsesModel({
      endpoint: 'https://example.test/v1/responses',
      model: 'vision',
      apiKey: () => 'secret',
      fetch: async () =>
        sse([
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } }
          }
        ])
    })
    expect((await complete(model)).reason).toBe('length')
  })

  it('combines parallel Messages results and keeps tool ids stable after older history is removed', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      sse([
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ])
    )
    const model = createMessagesModel({
      endpoint: 'https://example.test/v1/messages',
      model: 'vision',
      apiKey: () => 'secret',
      fetch: transport
    })
    const input = continuation(model)
    input.messages[1].calls!.push({ id: 'tool_456', name: 'view', arguments: {} })
    input.messages.push({
      ...input.messages[2],
      id: 't2',
      invocationId: 'assistant/long-id/tool_456'
    })
    await complete(model, input)
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body))
    expect(body.messages).toHaveLength(3)
    expect(body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual([
      'tool_123',
      'tool_456'
    ])
    input.messages.shift()
    await complete(model, input)
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body)).messages[0]).toEqual(
      body.messages[1]
    )
  })
})

it.each([createMessagesModel, createResponsesModel])(
  'rejects native parameters that could replace the authorized tool set',
  (factory) => {
    expect(() =>
      factory({
        endpoint: 'https://example.test/native',
        model: 'm',
        apiKey: () => 'key',
        parameters: { tools: [] }
      })
    ).toThrow('Reserved')
    expect(() =>
      factory({
        endpoint: 'https://example.test/native',
        model: 'm',
        apiKey: () => 'key',
        maxResponseBytes: 0
      })
    ).toThrow('Invalid response limit')
  }
)

it('normalizes final Messages input/cache usage without inventing missing counts', async () => {
  const model = createMessagesModel({
    endpoint: 'https://example.test/messages',
    model: 'm',
    apiKey: () => 'key',
    fetch: async () =>
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 3
          }
        },
        { type: 'message_stop' }
      ])
  })
  expect((await complete(model)).usage).toEqual({
    inputTokens: 18,
    outputTokens: 2,
    cacheReadTokens: 10,
    cacheWriteTokens: 3
  })
  const missing = createMessagesModel({
    endpoint: 'https://example.test/messages',
    model: 'm',
    apiKey: () => 'key',
    fetch: async () =>
      sse([
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' }
      ])
  })
  expect((await complete(missing)).usage).toBeUndefined()
})
