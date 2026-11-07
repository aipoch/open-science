import { describe, expect, it, vi } from 'vitest'
import { createMessagesModel } from './messages'
import { createResponsesModel } from './responses'
import { createChatCompletionsModel } from './chat-completions'
import type { ModelRequest } from './session-types'
const request: ModelRequest = {
  requestId: 'r',
  instructions: 'system',
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{ name: 'sum', version: '1', description: 'add', parameters: { type: 'object' } }],
  maxOutputTokens: 64
}
const response = (
  wire: string,
  headers: Record<string, string> = { 'content-type': 'text/event-stream' }
): Response => new Response(wire, { headers })
const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
async function finish(
  model: { stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> },
  input = request
): Promise<AdapterEvent> {
  let last
  for await (const event of model.stream(input, new AbortController().signal)) last = event
  if (!last) throw new Error('missing finish event')
  return last
}
type AdapterEvent = { type: string; [key: string]: unknown }
describe('independent protocol adapter subpaths', () => {
  it('maps Responses SSE text and function output items', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          { type: 'response.created', response: { id: 'resp' } },
          { type: 'response.output_text.delta', delta: 'answer' },
          {
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'fc_1', call_id: 'c', name: 'sum' }
          },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":2}' },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', id: 'fc_1', call_id: 'c', name: 'sum' }
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 3 }
              }
            }
          }
        ])
      )
    )
    const model = createResponsesModel({
      endpoint: 'https://fixture.example/responses',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    expect(await finish(model)).toMatchObject({
      type: 'finish',
      reason: 'tools',
      calls: [{ id: 'c', name: 'sum', arguments: { x: 2 } }],
      content: [{ text: 'answer' }],
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 }
    })
  })
  it('maps Anthropic Messages SSE thinking, tool use and stop reason', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 4,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 1
              }
            }
          },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'c', name: 'sum', input: {} }
          },
          {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"x":2}' }
          },
          { type: 'content_block_stop' },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 3 }
          },
          { type: 'message_stop' }
        ])
      )
    )
    const model = createMessagesModel({
      endpoint: 'https://fixture.example/messages',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    expect(await finish(model)).toMatchObject({
      type: 'finish',
      reason: 'tools',
      calls: [{ id: 'c', name: 'sum', arguments: { x: 2 } }],
      usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 3, cacheWriteTokens: 1 }
    })
  })
  it('drops incomplete Responses tool arguments when output is truncated', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          {
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'fc_1', call_id: 'c', name: 'sum' }
          },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":' },
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } }
          }
        ])
      )
    )
    const model = createResponsesModel({
      endpoint: 'https://fixture.example/responses',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    const result = await finish(model)
    expect(result).toMatchObject({ type: 'finish', reason: 'length' })
    expect(result).not.toHaveProperty('calls')
  })
  it('rejects Responses content filtering instead of persisting partial output', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'content_filter' } }
          }
        ])
      )
    )
    const model = createResponsesModel({
      endpoint: 'https://fixture.example/responses',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    await expect(finish(model)).rejects.toMatchObject({ code: 'limit' })
  })
  it('drops incomplete Messages tool arguments when output is truncated', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'c', name: 'sum', input: {} }
          },
          {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"x":' }
          },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
          { type: 'message_stop' }
        ])
      )
    )
    const model = createMessagesModel({
      endpoint: 'https://fixture.example/messages',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    const result = await finish(model)
    expect(result).toMatchObject({ type: 'finish', reason: 'length' })
    expect(result).not.toHaveProperty('calls')
  })
  it('replays Messages thinking only for the same adapter identity', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 }
          },
          { type: 'message_stop' }
        ])
      )
    )
    const model = createMessagesModel({
      endpoint: 'https://fixture.example/messages',
      model: 'fixture',
      id: 'messages-fixture',
      apiKey: () => 'key',
      fetch
    })
    const input: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          id: 'a',
          role: 'assistant',
          content: [{ type: 'text', text: 'calling' }],
          calls: [{ id: 'c', name: 'sum', arguments: { x: 2 } }],
          providerState: {
            adapterId: model.id,
            value: {
              thinking_blocks: [
                { type: 'thinking', thinking: 'private thought', signature: 'signed' }
              ]
            }
          }
        }
      ]
    }
    await finish(model, input)
    const body = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)
    ) as {
      messages: Array<{ content: unknown[] }>
    }
    expect(body.messages.at(-1)!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'private thought',
      signature: 'signed'
    })
  })
  it('maps image content through Chat Completions without enabling files', async () => {
    const fetch = vi.fn(async () =>
      response(
        sse([
          { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }
        ])
      )
    )
    const model = createChatCompletionsModel({
      endpoint: 'https://fixture.example/chat',
      model: 'fixture',
      apiKey: () => 'key',
      fetch
    })
    const input = {
      ...request,
      messages: [
        {
          id: 'i',
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'describe' },
            { type: 'image' as const, mimeType: 'image/png', source: 'data:image/png;base64,AA==' }
          ]
        }
      ]
    }
    expect((await finish(model, input)).reason).toBe('complete')
    expect(
      (
        JSON.parse(String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)) as {
          messages: Array<{ content: unknown[] }>
        }
      ).messages[1].content[1]
    ).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
    expect(model.capabilities).toEqual({
      tools: true,
      images: true,
      files: true,
      audio: true,
      video: false
    })
  })
})
