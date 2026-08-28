import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatProviderCompatibilityBridge } from './chat-provider-compatibility'

const bridges: ChatProviderCompatibilityBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

describe('ChatProviderCompatibilityBridge', () => {
  it('adapts Chat Completions tool calls to a Responses-only provider', async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'resp_1',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' }
        ],
        usage: { input_tokens: 7, output_tokens: 3 }
      })
    )
    const bridge = new ChatProviderCompatibilityBridge(
      {
        wire: 'responses',
        endpoint: 'https://provider.example/v1/responses',
        key: 'provider-key',
        model: 'upstream-model'
      },
      upstream
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'client-model',
        messages: [{ role: 'user', content: 'find it' }],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object', properties: {} } }
          }
        ]
      })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      model: 'client-model',
      choices: [
        {
          message: {
            content: 'done',
            tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"id":1}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
    })
    const request = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))
    expect(request).toMatchObject({ model: 'upstream-model', input: [{ role: 'user' }] })
    expect(upstream.mock.calls[0]?.[0]).toBe('https://provider.example/v1/responses')
  })

  it('adapts Chat Completions streaming to a Messages-only provider', async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'ready' },
          { type: 'tool_use', id: 'call_2', name: 'search', input: { query: 'term' } }
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 5 }
      })
    )
    const bridge = new ChatProviderCompatibilityBridge(
      {
        wire: 'anthropic',
        endpoint: 'https://provider.example/v1/messages',
        model: 'upstream-model'
      },
      upstream
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'client-model',
        stream: true,
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'search' }
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'search', parameters: { type: 'object', properties: {} } }
          }
        ],
        tool_choice: 'required'
      })
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"content":"ready"')
    expect(body).toContain('"name":"search"')
    expect(body).toContain('"prompt_tokens":11')
    expect(body).toContain('data: [DONE]')
    const request = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))
    expect(request).toMatchObject({
      model: 'upstream-model',
      stream: false,
      system: 'be concise',
      tool_choice: { type: 'any' }
    })
    expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({
      'anthropic-version': '2023-06-01'
    })
  })
})
