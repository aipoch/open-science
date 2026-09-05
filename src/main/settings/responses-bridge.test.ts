import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

import { ResponsesBridge } from './responses-bridge'
import { inputToMessages, responsesToChatRequest, toolsToChat } from './responses-request-adapter'
import { selectExplicitConnectorSkills } from './skill-selector-routing'

describe('Responses-compatible bridge conversion', () => {
  it('accepts a successful JSON response with a UTF-8 BOM', async () => {
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          `\uFEFF${JSON.stringify({
            id: 'chat-with-bom',
            model: 'model-a',
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
          })}`,
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'hello', stream: false })
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        id: 'chat-with-bom',
        output: [{ content: [{ text: 'ok' }] }]
      })
    } finally {
      await bridge.close()
    }
  })

  it('rejects an oversized successful JSON response before reading its body', async () => {
    let cancelBody: ReturnType<typeof vi.spyOn> | undefined
    const upstreamFetch = vi.fn(async () => {
      const upstream = Response.json(
        {
          id: 'chat-oversized',
          model: 'model-a',
          choices: [{ message: { role: 'assistant', content: 'too large' } }]
        },
        { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }
      )
      cancelBody = vi.spyOn(upstream.body!, 'cancel')
      return upstream
    })
    const { ResponsesBridge } = await import('./responses-bridge')
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'hello', stream: false })
      })

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({ error: { type: 'api_error' } })
      expect(cancelBody).toHaveBeenCalledOnce()
    } finally {
      await bridge.close()
    }
  })

  it('fails and cancels a streaming upstream that exceeds the limit after a stop frame', async () => {
    let cancelled = false
    const terminalFrame = new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: 'chat-oversized-stream',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }]
      })}\n\n`
    )
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(terminalFrame)
              controller.enqueue(new TextEncoder().encode('x'))
            },
            cancel() {
              cancelled = true
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch,
      { maxResponseBytes: terminalFrame.byteLength }
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'hello', stream: true })
      })
      const body = await response.text()

      expect(body).toContain('response.failed')
      expect(body).not.toContain('response.completed')
      expect(cancelled).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  const legacyReviewerMarker = '<open_science_reviewer_session>'
  it('maps instructions, messages, function calls, and tool results to Chat Completions', () => {
    const request = responsesToChatRequest({
      model: 'model-a',
      instructions: 'Be concise.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'lookup',
          arguments: '{"id":1}'
        },
        { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' }
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up an item',
          parameters: { type: 'object' },
          strict: true
        }
      ],
      stream: true
    })

    expect(request).toMatchObject({
      model: 'model-a',
      stream: true,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"id":1}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up an item',
            parameters: { type: 'object' },
            strict: true
          }
        }
      ]
    })
  })

  it('validates and preserves Responses image URLs when converting image content', () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    expect(
      responsesToChatRequest({
        model: 'vision-model',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Compare these images.' },
              { type: 'input_image', image_url: dataUrl, detail: 'high' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.test/image.jpg', detail: 'low' }
              }
            ]
          }
        ]
      })
    ).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these images.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/image.jpg', detail: 'low' }
            }
          ]
        }
      ]
    })
  })

  it('rejects malformed or unsupported Responses image content before calling upstream', () => {
    const convertImage = (part: Record<string, unknown>): unknown =>
      responsesToChatRequest({
        input: [{ type: 'message', role: 'user', content: [part] }]
      })

    expect(() => convertImage({ type: 'input_image' })).toThrow(/non-empty string/)
    expect(() =>
      convertImage({ type: 'input_image', image_url: 'data:text/plain;base64,aGVsbG8=' })
    ).toThrow(/valid base64 image data/)
    expect(() =>
      convertImage({ type: 'input_image', image_url: 'data:image/png;base64,not base64' })
    ).toThrow(/valid base64 image data/)
    expect(() => convertImage({ type: 'image_url', image_url: 'file:///tmp/image.png' })).toThrow(
      /HTTP\(S\)/
    )
    expect(() =>
      convertImage({ type: 'input_image', image_url: 'https://example.test/a.png', detail: 'full' })
    ).toThrow(/image detail/)
    expect(() => convertImage({ type: 'input_image', file_id: 'file-1' })).toThrow(/file_id/)
    expect(() =>
      responsesToChatRequest({
        input: [{ type: 'message', role: 'user', content: ['not-an-object'] }]
      })
    ).toThrow(/content parts must be objects/)
  })

  it('coalesces parallel tool calls into one assistant message so each tool result pairs correctly', () => {
    expect(
      inputToMessages({
        input: [
          { type: 'function_call', call_id: 'a', name: 'list_a', arguments: '{}' },
          { type: 'function_call', call_id: 'b', name: 'list_b', arguments: '{}' },
          { type: 'function_call_output', call_id: 'a', output: 'ra' },
          { type: 'function_call_output', call_id: 'b', output: 'rb' }
        ]
      })
    ).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'list_a', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'list_b', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'a', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', content: 'rb' }
    ])
  })

  it('replays namespaced MCP calls with the same Chat Completions alias', () => {
    expect(
      inputToMessages(
        {
          input: [
            {
              type: 'function_call',
              call_id: 'notebook-1',
              namespace: 'mcp__open_science_notebook',
              name: 'notebook_execute',
              arguments: '{"code":"print(1)"}'
            },
            { type: 'function_call_output', call_id: 'notebook-1', output: '1' }
          ]
        },
        undefined,
        [
          {
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            parameters: { type: 'object' }
          }
        ]
      )
    ).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'notebook-1',
            type: 'function',
            function: {
              name: 'mcp__open_science_notebook__notebook_execute',
              arguments: '{"code":"print(1)"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'notebook-1', content: '1' }
    ])
  })

  it('re-attaches cached reasoning to a replayed assistant tool-call for thinking-mode providers', () => {
    const reasoningByCallId = new Map([['call-1', 'let me look that up']])
    expect(
      inputToMessages(
        {
          input: [
            { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
          ]
        },
        reasoningByCallId
      )
    ).toEqual([
      {
        role: 'assistant',
        reasoning_content: 'let me look that up',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' }
    ])
    // Without a cache entry the assistant message carries no reasoning_content.
    expect(
      inputToMessages({
        input: [{ type: 'function_call', call_id: 'call-9', name: 'lookup', arguments: '{}' }]
      })[0]
    ).not.toHaveProperty('reasoning_content')
  })

  it('maps Responses developer messages to the broadly supported system role', () => {
    expect(
      inputToMessages({
        input: [{ type: 'message', role: 'developer', content: 'Follow the policy.' }]
      })
    ).toEqual([{ role: 'system', content: 'Follow the policy.' }])
  })

  it('rejects stateful features and filters non-translatable Codex tools', () => {
    expect(() =>
      responsesToChatRequest({ input: 'hello', previous_response_id: 'resp-1' })
    ).toThrow(/previous_response_id/)
    // Known built-in types (namespace, web_search, custom, tool_search) are dropped; only function
    // tools cross the bridge.
    const converted = toolsToChat([
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      { type: 'namespace', name: 'mcp' },
      { type: 'web_search' },
      { type: 'tool_search' },
      { type: 'custom', name: 'apply_patch' }
    ])
    expect(converted).toEqual([
      {
        type: 'function',
        function: { name: 'lookup', description: undefined, parameters: { type: 'object' } }
      }
    ])
    // A genuinely unknown tool type is rejected, not silently dropped.
    expect(() => toolsToChat([{ type: 'unverified_custom_tool' }])).toThrow(
      /Unsupported Responses tool type/
    )
    // Known built-in history items (tool mechanics, reasoning, compaction) are skipped, but an unknown
    // item type hard-errors so history is never silently discarded behind a "successful" answer.
    expect(inputToMessages({ input: [{ type: 'tool_search_call' }] })).toEqual([])
    expect(() => inputToMessages({ input: [{ type: 'computer_call' }] })).toThrow(
      /Unsupported Responses input item/
    )
    expect(
      inputToMessages({
        input: [
          { type: 'additional_tools', id: 'at-1', tools: [{ type: 'function', name: 'lookup' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      })
    ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(
      responsesToChatRequest({
        input: 'hello',
        reasoning: { effort: 'low', summary: 'auto' }
      })
    ).not.toHaveProperty('reasoning')

    const noConvertibleTools = responsesToChatRequest({
      input: 'hello',
      tools: [{ type: 'namespace', name: 'mcp' }, { type: 'web_search' }],
      tool_choice: 'auto',
      parallel_tool_calls: true
    })
    expect(noConvertibleTools).not.toHaveProperty('tools')
    expect(noConvertibleTools).not.toHaveProperty('tool_choice')
    expect(noConvertibleTools).not.toHaveProperty('parallel_tool_calls')
  })

  it('merges instructions and developer messages into one leading system message', () => {
    expect(
      inputToMessages({
        instructions: 'Global instructions.',
        input: [{ type: 'message', role: 'developer', content: 'Turn instructions.' }]
      })
    ).toEqual([{ role: 'system', content: 'Global instructions.\n\nTurn instructions.' }])
  })

  it('allows only the known Codex include and reasoning preferences', () => {
    expect(
      responsesToChatRequest({
        input: 'hello',
        include: ['reasoning.encrypted_content']
      })
    ).not.toHaveProperty('include')
    expect(() => responsesToChatRequest({ input: 'hello', include: 'invalid' })).toThrow(
      /include must be an array/
    )
    expect(() =>
      responsesToChatRequest({ input: 'hello', include: ['message.output_text.logprobs'] })
    ).toThrow(/include value is not supported/)
    expect(() => responsesToChatRequest({ input: 'hello', reasoning: 'low' })).toThrow(
      /reasoning must be an object/
    )
    expect(() =>
      responsesToChatRequest({ input: 'hello', reasoning: { effort: 'turbo' } })
    ).toThrow(/reasoning effort/)
    expect(() =>
      responsesToChatRequest({ input: 'hello', reasoning: { effort: 'max' } })
    ).not.toThrow()
    expect(() =>
      responsesToChatRequest({ input: 'hello', reasoning: { effort: 'ultra' } })
    ).not.toThrow()
    expect(() =>
      responsesToChatRequest({ input: 'hello', reasoning: { summary: 'verbose' } })
    ).toThrow(/reasoning summary/)
    expect(() =>
      responsesToChatRequest({ input: 'hello', reasoning: { encrypted_content: true } })
    ).toThrow(/reasoning field is not supported/)
  })

  it('translates Responses tool choice and output limits', () => {
    expect(
      responsesToChatRequest({
        input: 'hello',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'lookup' },
        max_output_tokens: 128,
        prompt_cache_key: 'codex-cache-key'
      })
    ).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      max_tokens: 128
    })
    expect(
      responsesToChatRequest({
        input: 'hello',
        prompt_cache_key: 'codex-cache-key'
      })
    ).not.toHaveProperty('prompt_cache_key')
    expect(() =>
      responsesToChatRequest({ input: 'hello', tool_choice: { type: 'web_search' } })
    ).toThrow(/tool_choice/)
  })

  it('keeps the Codex metadata model separate from the upstream model', () => {
    expect(
      responsesToChatRequest({ model: 'gpt-5-codex', input: 'hello' }, 'deepseek-v4-flash')
    ).toMatchObject({ model: 'deepseek-v4-flash' })
  })

  it('uses the model-resolved effort override instead of Codex\u2019s request value', () => {
    expect(
      responsesToChatRequest(
        { model: 'model-a', input: 'hi', reasoning: { effort: 'high' } },
        undefined,
        undefined,
        [],
        { reasoningEffortOverride: 'max' }
      )
    ).toMatchObject({ reasoning_effort: 'max' })
  })

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'transports the model-resolved %s effort without protocol-level clamping',
    (effort) => {
      expect(
        responsesToChatRequest(
          { model: 'model-a', input: 'hi', reasoning: { effort: 'high' } },
          undefined,
          undefined,
          [],
          { reasoningEffortOverride: effort }
        )
      ).toMatchObject({ reasoning_effort: effort })
    }
  )

  it('uses provider-native Chat controls when none is not a reasoning_effort literal', () => {
    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'deepseek-v4-pro', undefined, [], {
        reasoningEffortOverride: 'none',
        vendorId: 'deepseek'
      })
    ).toMatchObject({ thinking: { type: 'disabled' } })
    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'deepseek-v4-pro', undefined, [], {
        reasoningEffortOverride: 'none',
        vendorId: 'deepseek'
      })
    ).not.toHaveProperty('reasoning_effort')

    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'mimo-v2.5-pro', undefined, [], {
        reasoningEffortOverride: 'high',
        vendorId: 'xiaomimimo'
      })
    ).toMatchObject({ thinking: { type: 'enabled' } })

    const apodexRequest = responsesToChatRequest(
      { model: 'catalog', input: 'hi' },
      'apodex-1.1',
      undefined,
      [],
      {
        reasoningEffortOverride: 'high',
        vendorId: 'apodex'
      }
    )
    expect(apodexRequest).not.toHaveProperty('thinking')
    expect(apodexRequest).not.toHaveProperty('reasoning_effort')

    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'qwen/qwen3.7-max', undefined, [], {
        reasoningEffortOverride: 'none',
        vendorId: 'openrouter'
      })
    ).toMatchObject({ reasoning: { enabled: false } })
  })

  it('uses the selected native transport for a custom gateway', () => {
    const request = responsesToChatRequest(
      { model: 'catalog', input: 'hi' },
      'private-model',
      undefined,
      [],
      {
        reasoningEffortOverride: 'none',
        reasoningEffortTransport: 'minimax'
      }
    )

    expect(request).toMatchObject({ thinking: { type: 'disabled' } })
    expect(request).not.toHaveProperty('reasoning_effort')
  })

  it('does not infer the built-in OpenRouter Qwen toggle for a custom gateway', () => {
    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'qwen/qwen3.7-max', undefined, [], {
        reasoningEffortOverride: 'high',
        reasoningEffortTransport: 'openrouter'
      })
    ).toMatchObject({ reasoning: { effort: 'high' } })
  })

  it('uses OpenRouter reasoning objects and keeps GLM none as a literal effort', () => {
    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'openai/gpt-5.5', undefined, [], {
        reasoningEffortOverride: 'xhigh',
        vendorId: 'openrouter'
      })
    ).toMatchObject({ reasoning: { effort: 'xhigh' } })

    expect(
      responsesToChatRequest({ model: 'catalog', input: 'hi' }, 'glm-5.2', undefined, [], {
        reasoningEffortOverride: 'none',
        vendorId: 'zhipu'
      })
    ).toMatchObject({ reasoning_effort: 'none' })
  })

  it('strips the reasoning effort unless the user explicitly chose a level', () => {
    // Codex emits its own default effort even when the app never configured one; forwarding that
    // would change what existing bridged users send to gateways that may reject unknown params.
    expect(
      responsesToChatRequest({ model: 'model-a', input: 'hi', reasoning: { effort: 'high' } })
    ).not.toHaveProperty('reasoning_effort')
  })

  it('requests streaming usage without forwarding Responses-only stream options', () => {
    expect(
      responsesToChatRequest({
        model: 'model-a',
        input: 'hi',
        stream: true,
        stream_options: { include_obfuscation: true }
      })
    ).toMatchObject({ stream_options: { include_usage: true } })
  })

  it('serves an authenticated Responses SSE stream from a Chat Completions upstream', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-1',
                model: 'model-a',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'bridge-ok' } }]
              }),
            '',
            'data: ' +
              JSON.stringify({
                id: 'chat-1',
                model: 'model-a',
                choices: [],
                usage: {
                  prompt_tokens: 3,
                  prompt_tokens_details: { cached_tokens: 1 },
                  completion_tokens: 2,
                  completion_tokens_details: { reasoning_tokens: 1 },
                  total_tokens: 5
                }
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const { ResponsesBridge } = await import('./responses-bridge')
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'upstream-key' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      expect(connection.continuityToken).toMatch(/^[0-9a-f]{32}$/)
      expect((await bridge.start()).continuityToken).toBe(connection.continuityToken)
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          instructions: 'Be brief.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: true
        })
      })
      const output = await response.text()

      expect(response.status).toBe(200)
      expect(upstreamFetch).toHaveBeenCalledWith(
        'https://vendor.example/v1/chat/completions',
        expect.objectContaining({
          headers: { authorization: 'Bearer upstream-key', 'content-type': 'application/json' }
        })
      )
      expect(upstreamRequest).toMatchObject({
        model: 'model-a',
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        ]
      })
      expect(output).toContain('response.output_text.delta')
      expect(output).toContain('bridge-ok')
      expect(output).toContain('response.completed')
      const completed = output
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
        .find((event) => event.type === 'response.completed') as {
        response: { usage: Record<string, unknown> }
      }
      expect(completed.response.usage).toEqual({
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 5
      })
    } finally {
      await bridge.close()
    }
  })

  it('replays an identical deterministic provider error without a second upstream request', async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Incorrect API key provided' } },
        { status: 401 }
      )
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'wrong-key', model: 'model-a' },
      upstreamFetch
    )
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello', stream: true })
      })

    try {
      const first = await send()
      const second = await send()

      expect(first.status).toBe(400)
      expect(second.status).toBe(400)
      await expect(second.json()).resolves.toMatchObject({
        error: {
          type: 'upstream_error',
          message: 'Incorrect API key provided',
          status: 401
        }
      })
      expect(upstreamFetch).toHaveBeenCalledOnce()
    } finally {
      await bridge.close()
    }
  })

  it('overrides Codex\u2019s effort with the model-resolved value at the upstream gateway', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-effort-1',
                model: 'model-a',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'upstream-key', reasoningEffort: 'max' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'hi',
          reasoning: { effort: 'xhigh' },
          stream: true
        })
      })
      await response.text()

      expect(response.status).toBe(200)
      expect(upstreamRequest).toMatchObject({ reasoning_effort: 'max' })
    } finally {
      await bridge.close()
    }
  })

  it('strips the reasoning effort when the user never chose a level', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-effort-2',
                model: 'model-a',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    // No resolved override: Codex's own default effort must not change what existing bridged users
    // send upstream.
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'upstream-key' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'hi',
          reasoning: { effort: 'high' },
          stream: true
        })
      })
      await response.text()

      expect(response.status).toBe(200)
      expect(upstreamRequest).not.toHaveProperty('reasoning_effort')
    } finally {
      await bridge.close()
    }
  })

  it('flips effort forwarding on a live bridge without replacing its target', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-effort-flip',
                model: 'model-a',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'upstream-key' },
      upstreamFetch
    )
    const connection = await bridge.start()
    const post = (): Promise<string> =>
      fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'hi',
          reasoning: { effort: 'high' },
          stream: true
        })
      }).then((response) => response.text())

    try {
      await post()
      expect(upstreamRequest).not.toHaveProperty('reasoning_effort')

      // The model profile resolves a concrete level (Codex applies it live over ACP — the bridge
      // never reconnects).
      bridge.setReasoningEffort('max')
      await post()
      expect(upstreamRequest).toMatchObject({ reasoning_effort: 'max' })

      // Back to default: stripping restored on the same live bridge.
      bridge.setReasoningEffort(undefined)
      await post()
      expect(upstreamRequest).not.toHaveProperty('reasoning_effort')
    } finally {
      await bridge.close()
    }
  })

  it('restores a namespaced MCP call when its Chat id, name, and arguments are fragmented', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-mcp-1',
                model: 'model-a',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-note',
                          type: 'function',
                          function: {
                            name: 'mcp__open_science_',
                            arguments: ''
                          }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }),
            '',
            'data: ' +
              JSON.stringify({
                id: 'chat-mcp-1',
                model: 'model-a',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'book-1',
                          function: {
                            name: 'notebook__notebook_execute',
                            arguments: '{"code":'
                          }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }),
            '',
            'data: ' +
              JSON.stringify({
                id: 'chat-mcp-1',
                model: 'model-a',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: '"print(1)"}' } }]
                    },
                    finish_reason: null
                  }
                ]
              }),
            '',
            'data: ' +
              JSON.stringify({
                id: 'chat-mcp-1',
                model: 'model-a',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://vendor.example/v1',
        key: 'upstream-key',
        namespacedTools: [
          {
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            description: 'Execute notebook code.',
            parameters: {
              type: 'object',
              properties: { code: { type: 'string' } },
              required: ['code']
            }
          }
        ]
      },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: [{ type: 'message', role: 'user', content: 'Use PubMed to find cancer papers' }],
          tools: [
            { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
            { type: 'function', name: 'list_mcp_resources', parameters: { type: 'object' } },
            {
              type: 'function',
              name: 'list_mcp_resource_templates',
              parameters: { type: 'object' }
            },
            { type: 'function', name: 'read_mcp_resource', parameters: { type: 'object' } }
          ],
          stream: true
        })
      })
      const output = await response.text()

      expect(upstreamRequest).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'mcp__open_science_notebook__notebook_execute',
              parameters: expect.objectContaining({ required: ['code'] })
            })
          })
        ])
      })
      const chatTools = (upstreamRequest?.tools ?? []) as Array<{
        function?: { name?: string }
      }>
      expect(chatTools.map((tool) => tool.function?.name)).toEqual([
        'exec_command',
        'mcp__open_science_notebook__notebook_execute'
      ])
      expect(output).toContain('"type":"function_call"')
      expect(output).toContain('"namespace":"mcp__open_science_notebook"')
      expect(output).toContain('"name":"notebook_execute"')
      expect(output).toContain('"call_id":"call-notebook-1"')
      expect(output).not.toContain('"name":"mcp__open_science_notebook__notebook_execute"')
    } finally {
      await bridge.close()
    }
  })

  it('carries DeepSeek reviewer tool calls only for a trusted registered session key', async () => {
    const upstreamRequests: Array<Record<string, unknown>> = []
    const upstreamUrls: string[] = []
    const upstreamFetch = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>
        const reviewer = upstreamRequests.length === 1
        upstreamUrls.push(String(url))
        upstreamRequests.push(request)
        return new Response(
          [
            `data: ${JSON.stringify({
              id: 'chat-reviewer-scope',
              model: 'deepseek-v4-pro',
              choices: [
                {
                  index: 0,
                  delta: reviewer
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call-deepseek-reviewer',
                            type: 'function',
                            function: {
                              name: 'mcp__open_science_reviewer__submit_findings',
                              arguments: '{"checks":[]}'
                            }
                          }
                        ]
                      }
                    : {},
                  finish_reason: reviewer ? 'tool_calls' : 'stop'
                }
              ]
            })}`,
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://api.deepseek.com/v1',
        namespacedTools: [
          {
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            parameters: { type: 'object' }
          }
        ],
        reviewerScope: {
          namespacedTools: [
            {
              namespace: 'mcp__open_science_reviewer',
              name: 'read_turn',
              parameters: { type: 'object' }
            },
            {
              namespace: 'mcp__open_science_reviewer',
              name: 'submit_findings',
              parameters: { type: 'object' }
            }
          ]
        }
      },
      upstreamFetch
    )
    const connection = await bridge.start()
    const post = async (input: string, promptCacheKey: string): Promise<string> => {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          input,
          prompt_cache_key: promptCacheKey,
          stream: true,
          tools: [
            { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
            { type: 'local_shell' },
            { type: 'tool_search' }
          ],
          tool_choice: { type: 'function', name: 'exec_command' }
        })
      })
      return response.text()
    }

    try {
      bridge.registerReviewerSession('never-observed-reviewer-session')
      expect(bridge.unregisterReviewerSession('never-observed-reviewer-session')).toBe(false)

      await post(`${legacyReviewerMarker} normal user content`, 'normal-session')
      bridge.registerReviewerSession('reviewer-session')
      const reviewerOutput = await post(
        'review this turn without a model-visible routing marker',
        'reviewer-session'
      )
      expect(bridge.unregisterReviewerSession('reviewer-session')).toBe(true)

      const toolNames = upstreamRequests.map((request) =>
        ((request.tools ?? []) as Array<{ function?: { name?: string } }>).map(
          (tool) => tool.function?.name
        )
      )
      expect(toolNames[0]).toEqual(['exec_command', 'mcp__open_science_notebook__notebook_execute'])
      expect(toolNames[1]).toEqual([
        'mcp__open_science_reviewer__read_turn',
        'mcp__open_science_reviewer__submit_findings'
      ])
      expect(upstreamRequests[0]?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'exec_command' }
      })
      expect(upstreamRequests[1]?.tool_choice).toBe('auto')
      expect(upstreamUrls).toEqual([
        'https://api.deepseek.com/v1/chat/completions',
        'https://api.deepseek.com/v1/chat/completions'
      ])
      expect(reviewerOutput).toContain('"type":"function_call"')
      expect(reviewerOutput).toContain('"namespace":"mcp__open_science_reviewer"')
      expect(reviewerOutput).toContain('"name":"submit_findings"')
      expect(reviewerOutput).toContain('"call_id":"call-deepseek-reviewer"')
    } finally {
      await bridge.close()
    }
  })

  it('removes all tool declarations for a registered one-shot session key', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'chat-tool-less',
          model: 'model-a',
          choices: [{ message: { role: 'assistant', content: 'print(1)' } }]
        })
      }
    )
    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://vendor.example/v1',
        model: 'model-a',
        namespacedTools: [
          {
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            parameters: { type: 'object' }
          }
        ]
      },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      bridge.registerToolLessSession('reconstruction-session')
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'reconstruct',
          prompt_cache_key: 'reconstruction-session',
          stream: false,
          tools: [
            { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
            { type: 'local_shell' }
          ],
          tool_choice: { type: 'function', name: 'exec_command' }
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequest).not.toHaveProperty('tools')
      expect(JSON.stringify(upstreamRequest)).not.toContain('exec_command')
      expect(JSON.stringify(upstreamRequest)).not.toContain('notebook_execute')
      expect(bridge.unregisterToolLessSession('reconstruction-session')).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('replaces Codex declarations with the registered host-message-only scope', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      vi.fn(async (_url, init) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'chat-host-message',
          model: 'model-a',
          choices: [{ message: { role: 'assistant', content: 'queued' } }]
        })
      })
    )
    const connection = await bridge.start()
    const scope = [
      {
        namespace: 'mcp__open_science_host_message',
        name: 'send_message',
        parameters: { type: 'object' }
      }
    ]

    try {
      bridge.registerHostMessageSession('side-session', scope)
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'send it',
          prompt_cache_key: 'side-session',
          stream: false,
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequest).toMatchObject({
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            function: { name: 'mcp__open_science_host_message__send_message' }
          }
        ]
      })
      expect(JSON.stringify(upstreamRequest)).not.toContain('exec_command')

      const ordinaryResponse = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'ordinary turn',
          prompt_cache_key: 'ordinary-session',
          stream: false,
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
        })
      })
      expect(ordinaryResponse.ok).toBe(true)
      expect(JSON.stringify(upstreamRequest)).toContain('exec_command')
      expect(bridge.unregisterHostMessageSession('side-session')).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('removes every tool when a strict host-message boundary sees an unexpected Session key', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      vi.fn(async (_url, init) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'chat-host-message-mismatch',
          model: 'model-a',
          choices: [{ message: { role: 'assistant', content: 'safe' } }]
        })
      })
    )
    const connection = await bridge.start()
    try {
      bridge.registerHostMessageSession(
        'expected-side-session',
        [
          {
            namespace: 'mcp__open_science_host_message',
            name: 'send_message',
            parameters: { type: 'object' }
          }
        ],
        { failClosedUnknownKeys: true }
      )
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: 'send it',
          prompt_cache_key: 'unexpected-session',
          stream: false,
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequest).not.toHaveProperty('tools')
      expect(upstreamRequest).not.toHaveProperty('tool_choice')
      expect(JSON.stringify(upstreamRequest)).not.toContain('exec_command')
      expect(JSON.stringify(upstreamRequest)).not.toContain('send_message')
      expect(bridge.unregisterHostMessageSession('expected-side-session')).toBe(false)
    } finally {
      await bridge.close()
    }
  })

  it('streams a clean, fully-readable body when the upstream emits reasoning_content', async () => {
    // Regression: a reasoning-model upstream interleaves reasoning_content deltas. The bridge must
    // drop them and finish the SSE stream instead of resetting the socket (which reaches the agent
    // as "error decoding response body" / stream disconnected before completion).
    const upstreamFetch = vi.fn(async () => {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): string =>
        'data: ' +
        JSON.stringify({
          id: 'c1',
          model: 'model-a',
          choices: [{ index: 0, delta, finish_reason }]
        })
      return new Response(
        [
          chunk({ role: 'assistant', content: '1' }),
          '',
          chunk({ reasoning_content: 'thinking about the number' }),
          '',
          chunk({ content: '1' }),
          '',
          chunk({}, 'stop'),
          '',
          'data: [DONE]',
          ''
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const { ResponsesBridge } = await import('./responses-bridge')
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '11' }] }],
          stream: true
        })
      })
      // A reset socket makes reading the body throw; a clean stream reads to completion.
      const output = await response.text()

      expect(response.status).toBe(200)
      expect(output).toContain('response.completed')
      expect(output).not.toContain('thinking about the number')
      expect(output).toContain('response.output_text.done')
    } finally {
      await bridge.close()
    }
  })

  it('keeps cached reasoning isolated when Sessions reuse the same provider call id', async () => {
    const upstreamRequests: Array<Record<string, unknown>> = []
    const upstreamResponses = [
      {
        id: 'session-a-call',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'session-a reasoning',
              tool_calls: [
                {
                  id: 'reused-call-id',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"session":"a"}' }
                }
              ]
            }
          }
        ]
      },
      {
        id: 'session-b-call',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'session-b reasoning',
              tool_calls: [
                {
                  id: 'reused-call-id',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"session":"b"}' }
                }
              ]
            }
          }
        ]
      },
      {
        id: 'session-a-complete',
        model: 'model-a',
        choices: [{ message: { role: 'assistant', content: 'done' } }]
      }
    ]
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json(upstreamResponses[upstreamRequests.length - 1])
      }
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()
    const post = async (promptCacheKey: string, input: unknown): Promise<void> => {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: promptCacheKey,
          input,
          stream: false
        })
      })
      expect(response.ok).toBe(true)
      await response.json()
    }

    try {
      await post('session-a', 'start a')
      await post('session-b', 'start b')
      const invalidResponse = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: 'session-a',
          previous_response_id: 'unsupported',
          input: 'invalid retry',
          stream: false
        })
      })
      expect(invalidResponse.status).toBe(400)
      await post('session-a', [
        {
          type: 'function_call',
          call_id: 'reused-call-id',
          name: 'lookup',
          arguments: '{"session":"a"}'
        },
        { type: 'function_call_output', call_id: 'reused-call-id', output: 'a-result' }
      ])

      expect(upstreamRequests[2]?.messages).toEqual([
        {
          role: 'assistant',
          reasoning_content: 'session-a reasoning',
          tool_calls: [
            {
              id: 'reused-call-id',
              type: 'function',
              function: { name: 'lookup', arguments: '{"session":"a"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'reused-call-id', content: 'a-result' }
      ])
    } finally {
      await bridge.close()
    }
  })

  it('fails closed without a Session scope and bounds cached reasoning by LRU Session', () => {
    type ReasoningCacheHarness = {
      cacheReasoning: (
        promptCacheKey: string | undefined,
        reasoning: string,
        callIds: string[]
      ) => void
      reconcileReasoningForRequest: (promptCacheKey: string | undefined, input: unknown) => void
      reasoningByPromptCacheKey: Map<string, Map<string, string>>
      reasoningCacheEntryCount: number
      reasoningCacheCharacterCount: number
    }
    const harness = (options: {
      reasoningCacheMaxEntries: number
      reasoningCacheMaxCharacters: number
    }): ReasoningCacheHarness =>
      new ResponsesBridge(
        { baseUrl: 'https://vendor.example/v1' },
        fetch,
        options
      ) as unknown as ReasoningCacheHarness
    const fill = (cache: ReasoningCacheHarness): void => {
      cache.cacheReasoning(undefined, 'unsafe', ['unscoped-call'])
      cache.cacheReasoning('session-a', 'aaa', ['call-a'])
      cache.cacheReasoning('session-b', 'bbb', ['call-b'])
      cache.cacheReasoning('session-c', 'ccc', ['call-c'])
    }

    const entryBounded = harness({
      reasoningCacheMaxEntries: 2,
      reasoningCacheMaxCharacters: 100
    })
    fill(entryBounded)
    expect([...entryBounded.reasoningByPromptCacheKey.keys()]).toEqual(['session-b', 'session-c'])
    expect(entryBounded.reasoningCacheEntryCount).toBe(2)

    const characterBounded = harness({
      reasoningCacheMaxEntries: 100,
      reasoningCacheMaxCharacters: 6
    })
    fill(characterBounded)
    expect([...characterBounded.reasoningByPromptCacheKey.keys()]).toEqual([
      'session-b',
      'session-c'
    ])
    expect(characterBounded.reasoningCacheCharacterCount).toBe(6)

    const reconciled = harness({
      reasoningCacheMaxEntries: 100,
      reasoningCacheMaxCharacters: 100
    })
    reconciled.cacheReasoning('session-a', 'aaa', ['retained-call', 'compacted-call'])
    reconciled.reconcileReasoningForRequest('session-a', [
      { type: 'function_call', call_id: 'retained-call' }
    ])
    expect(reconciled.reasoningByPromptCacheKey.get('session-a')).toEqual(
      new Map([['retained-call', 'aaa']])
    )
    expect(reconciled.reasoningCacheEntryCount).toBe(1)
    expect(reconciled.reasoningCacheCharacterCount).toBe(3)
  })

  it('reports streamed upstream image output as unsupported', async () => {
    const upstreamFetch = vi.fn(async () => {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): string =>
        'data: ' +
        JSON.stringify({
          id: 'chat-image-stream',
          model: 'model-a',
          choices: [{ index: 0, delta, finish_reason }]
        })
      return new Response(
        [
          chunk({
            role: 'assistant',
            images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }]
          }),
          '',
          chunk({}, 'stop'),
          '',
          'data: [DONE]',
          ''
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'draw', stream: true })
      })
      const output = await response.text()

      expect(response.status).toBe(200)
      expect(output).toContain('response.failed')
      expect(output).toContain('unsupported_upstream_output')
      expect(output).toContain('Upstream image output is not supported')
      expect(output).not.toContain('response.completed')
    } finally {
      await bridge.close()
    }
  })

  it('returns a clear error for non-streaming upstream image output', async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        id: 'chat-image-json',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              images: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }]
            }
          }
        ]
      })
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'draw', stream: false })
      })
      const result = (await response.json()) as {
        error: { type: string; message: string }
      }

      expect(response.status).toBe(502)
      expect(result.error).toEqual({
        type: 'unsupported_upstream_output',
        message: 'Upstream image output is not supported by this gateway'
      })
    } finally {
      await bridge.close()
    }
  })

  it('aborts the upstream fetch when the incoming client connection closes', async () => {
    let signal: AbortSignal | undefined
    let markFetchStarted: (() => void) | undefined
    let markAborted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        signal = init?.signal ?? undefined
        markFetchStarted?.()
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              markAborted?.()
              reject(signal?.reason)
            },
            { once: true }
          )
        })
      }
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()
    const endpoint = new URL(`${connection.baseUrl}/responses`)
    const requestBody = JSON.stringify({ model: 'model-a', input: 'hello', stream: true })

    try {
      const clientRequest = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody)
        }
      })
      clientRequest.on('error', () => undefined)
      clientRequest.end(requestBody)

      await fetchStarted
      clientRequest.destroy()
      await aborted

      expect(signal?.aborted).toBe(true)
      expect(upstreamFetch).toHaveBeenCalledWith(
        'https://vendor.example/v1/chat/completions',
        expect.objectContaining({ signal })
      )
    } finally {
      await bridge.close()
    }
  })

  it('closes promptly when a client keeps an incomplete request connection open', async () => {
    const bridge = new ResponsesBridge({ baseUrl: 'https://vendor.example/v1', key: 'k' })
    const connection = await bridge.start()
    const endpoint = new URL(`${connection.baseUrl}/responses`)
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      [
        `POST ${endpoint.pathname} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${connection.token}`,
        'Content-Type: application/json',
        'Content-Length: 1000',
        '',
        '{'
      ].join('\r\n')
    )
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))

    await expect(
      Promise.race([
        bridge.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('bridge close timed out')), 500)
        )
      ])
    ).resolves.toBeUndefined()
    await socketClosed
    expect(socket.destroyed).toBe(true)
  })

  it('reports a truncated upstream stream as failed rather than completed', async () => {
    // The upstream yields content but its connection drops mid-stream: no finish_reason, no [DONE].
    // The bridge must not present this as a complete turn.
    const upstreamFetch = vi.fn(async () => {
      return new Response(
        [
          'data: ' +
            JSON.stringify({
              id: 'c1',
              model: 'model-a',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' } }]
            }),
          '',
          ''
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const { ResponsesBridge } = await import('./responses-bridge')
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: true
        })
      })
      const output = await response.text()

      expect(response.status).toBe(200)
      expect(output).toContain('response.failed')
      expect(output).toContain('upstream_incomplete')
      expect(output).not.toContain('response.completed')
    } finally {
      await bridge.close()
    }
  })

  it('reports a length-truncated stream as incomplete, not completed', async () => {
    const upstreamFetch = vi.fn(async () => {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): string =>
        'data: ' +
        JSON.stringify({
          id: 'c1',
          model: 'model-a',
          choices: [{ index: 0, delta, finish_reason }]
        })
      // CRLF framing + a final chunk whose finish_reason is `length` (token cap hit mid-answer).
      return new Response(
        [
          chunk({ role: 'assistant', content: 'partial' }),
          chunk({}, 'length'),
          'data: [DONE]',
          ''
        ].join('\r\n\r\n'),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const { ResponsesBridge } = await import('./responses-bridge')
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: true
        })
      })
      const output = await response.text()
      // [DONE] is present but the answer was cut off by length: incomplete wins over a clean complete.
      expect(output).toContain('response.incomplete')
      expect(output).toContain('length')
      expect(output).not.toContain('response.completed')
    } finally {
      await bridge.close()
    }
  })

  it('appends /chat/completions to a vendor-versioned base verbatim (GLM /api/paas/v4, not /v1)', async () => {
    // The bridge receives the ALREADY-RESOLVED OpenAI base as target.baseUrl and only appends
    // /chat/completions. A GLM base carries its own /api/paas/v4 version segment, which must survive —
    // a consumer that hard-coded /v1/chat/completions would break here.
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        id: 'c-glm',
        model: 'glm-5.2',
        choices: [{ message: { role: 'assistant', content: 'ok' } }]
      })
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://api.z.ai/api/paas/v4', key: 'k', model: 'glm-5.2' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'glm-5.2', input: 'hi', stream: false })
      })
      expect(response.status).toBe(200)
      expect(upstreamFetch).toHaveBeenCalledWith(
        'https://api.z.ai/api/paas/v4/chat/completions',
        expect.anything()
      )
    } finally {
      await bridge.close()
    }
  })

  it('appends /chat/completions to a custom-resolved <root>/v1 base', async () => {
    // A custom gateway is resolved upstream to `<root>/v1`; the bridge appends the endpoint onto that.
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        id: 'c-proxy',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'ok' } }]
      })
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://host/proxy/v1', key: 'k', model: 'm' },
      upstreamFetch
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'm', input: 'hi', stream: false })
      })
      expect(response.status).toBe(200)
      expect(upstreamFetch).toHaveBeenCalledWith(
        'https://host/proxy/v1/chat/completions',
        expect.anything()
      )
    } finally {
      await bridge.close()
    }
  })

  it('clears the reasoning cache only when the upstream target actually changes', () => {
    const bridge = new ResponsesBridge({ baseUrl: 'https://a.example/v1', model: 'm1', key: 'k1' })
    const cache = (
      bridge as unknown as {
        reasoningByPromptCacheKey: Map<string, Map<string, string>>
      }
    ).reasoningByPromptCacheKey
    cache.set('session-1', new Map([['call-1', 'thinking']]))
    // Same target (e.g. a skill-reload reconnect): cache is preserved so a resumed thinking session works.
    bridge.setTarget({ baseUrl: 'https://a.example/v1', model: 'm1', key: 'k1' })
    expect(cache.get('session-1')?.has('call-1')).toBe(true)
    // Real provider switch: cache is cleared so stale reasoning can't leak across providers.
    bridge.setTarget({ baseUrl: 'https://b.example/v1', model: 'm2', key: 'k2' })
    expect(cache.size).toBe(0)
  })

  it('retargets only model-owned fields and preserves the live endpoint credentials', () => {
    const bridge = new ResponsesBridge({
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'secret',
      vendorId: 'deepseek'
    })

    bridge.setModelTarget({
      model: 'model-b',
      vendorId: 'minimax',
      reasoningEffortTransport: 'minimax',
      reasoningEffort: 'high'
    })

    expect((bridge as unknown as { target: Record<string, unknown> }).target).toEqual({
      baseUrl: 'https://gateway.example/v1',
      key: 'secret',
      model: 'model-b',
      vendorId: 'minimax',
      reasoningEffortTransport: 'minimax',
      reasoningEffort: 'high'
    })
  })
})

describe('Responses bridge Skill selector', () => {
  const catalog = [
    {
      name: 'mcp-pubmed',
      description: 'Search biomedical literature.',
      path: '/private/pubmed/SKILL.md',
      source: 'connector' as const
    },
    {
      name: 'literature-review',
      description: 'Plan a systematic review.',
      path: '/private/review/SKILL.md'
    },
    { name: 'statistics', description: 'Analyze numerical data.', path: '/private/stats/SKILL.md' },
    { name: 'writing', description: 'Improve prose.', path: '/private/writing/SKILL.md' }
  ]

  it('fails open and cancels an oversized successful selector response', async () => {
    let cancelBody: ReturnType<typeof vi.spyOn> | undefined
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      vi.fn(async () => {
        const response = Response.json(
          {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: 'select_skills',
                        arguments: JSON.stringify({ skill_names: ['mcp-pubmed'] })
                      }
                    }
                  ]
                }
              }
            ]
          },
          { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }
        )
        cancelBody = vi.spyOn(response.body!, 'cancel')
        return response
      })
    )

    await expect(bridge.selectSkills('find biomedical papers', catalog)).resolves.toEqual([])
    expect(cancelBody).toHaveBeenCalledOnce()
  })

  it('sends only current text plus names and descriptions and returns canonical bounded results', async () => {
    let upstreamUrl = ''
    let upstreamHeaders: HeadersInit | undefined
    let upstreamBody: Record<string, unknown> = {}
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = String(input)
      upstreamHeaders = init?.headers
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: 'selector-call-1',
          usage: {
            prompt_tokens: 45,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens: 3
          },
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'select_skills',
                      arguments: JSON.stringify({
                        skill_names: [
                          'mcp-pubmed',
                          'unknown',
                          'mcp-pubmed',
                          'literature-review',
                          'statistics',
                          'writing'
                        ]
                      })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    })
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'secret-key', model: 'deepseek-v4-flash' },
      upstreamFetch
    )

    const observeUsage = vi.fn()
    const selected = await bridge.selectSkills(
      'Compare evidence sources for seasonal migration patterns.',
      catalog,
      undefined,
      observeUsage
    )

    expect(selected).toEqual(catalog.slice(0, 3).map(({ name, path }) => ({ name, path })))
    expect(observeUsage).toHaveBeenCalledWith({
      usage: {
        inputTokens: 40,
        cacheTokens: 5,
        cachedReadTokens: 5,
        cachedWriteTokens: 0,
        outputTokens: 3
      },
      sourceInvocationId: 'selector-call-1'
    })
    expect(upstreamUrl).toBe('https://vendor.example/v1/chat/completions')
    expect(upstreamHeaders).toMatchObject({ authorization: 'Bearer secret-key' })
    expect(upstreamBody).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: false,
      temperature: 0,
      max_tokens: 512,
      tool_choice: { type: 'function', function: { name: 'select_skills' } },
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: 'Compare evidence sources for seasonal migration patterns.' }
      ],
      tools: [
        {
          type: 'function',
          function: expect.objectContaining({
            name: 'select_skills',
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                skill_names: expect.objectContaining({ maxItems: 3 })
              })
            })
          })
        }
      ]
    })
    const serialized = JSON.stringify(upstreamBody)
    expect(serialized).toContain('Search biomedical literature.')
    expect(serialized.match(/mcp-pubmed/g)).toHaveLength(1)
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('secret-key')
  })

  it('selects an explicitly named connector Skill locally without an upstream request', async () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'deepseek-v4-flash' },
      upstreamFetch
    )

    await expect(
      bridge.selectSkills('Use PubMed to find articles about protein folding.', catalog)
    ).resolves.toEqual([{ name: 'mcp-pubmed', path: '/private/pubmed/SKILL.md' }])
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('does not treat an ordinary Skill name in natural text as an explicit local selection', async () => {
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: 'select_skills',
                        arguments: JSON.stringify({ skill_names: ['research'] })
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const mixedCatalog = [
      ...catalog,
      { name: 'research', description: 'Research a topic.', path: '/skills/research/SKILL.md' }
    ]

    await expect(bridge.selectSkills('research cancer treatments', mixedCatalog)).resolves.toEqual([
      { name: 'research', path: '/skills/research/SKILL.md' }
    ])
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('does not infer connector provenance from a user-controlled mcp-* name', () => {
    expect(
      selectExplicitConnectorSkills('use personal for this task', [
        {
          name: 'mcp-personal',
          description: 'A user-authored Skill.',
          path: '/skills/personal/SKILL.md'
        }
      ])
    ).toEqual([])
  })

  it('finds an explicitly named connector before bounding the inference catalog', async () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const largeCatalog = [
      ...Array.from({ length: 140 }, (_, index) => ({
        name: `skill-${index}`,
        description: `Description ${index}`,
        path: `/skills/${index}/SKILL.md`
      })),
      {
        name: 'mcp-pubmed',
        description: 'Search PubMed.',
        path: '/skills/pubmed/SKILL.md',
        source: 'connector' as const
      }
    ]

    await expect(
      bridge.selectSkills('Use PubMed to find articles about microbial ecology.', largeCatalog)
    ).resolves.toEqual([{ name: 'mcp-pubmed', path: '/skills/pubmed/SKILL.md' }])
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('accepts strict JSON content when the model ignores forced tool choice', async () => {
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"skill_names":["mcp-pubmed"]}\n```' } }]
          })
        )
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )

    await expect(bridge.selectSkills('find biomedical papers', catalog)).resolves.toEqual([
      { name: 'mcp-pubmed', path: '/private/pubmed/SKILL.md' }
    ])
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('disables provider-native reasoning for bounded Skill routing', async () => {
    let upstreamBody: Record<string, unknown> = {}
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'select_skills',
                      arguments: JSON.stringify({ skill_names: ['literature-review'] })
                    }
                  }
                ]
              }
            }
          ]
        })
      )
    })
    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://vendor.example/v1',
        model: 'MiniMax-M3',
        vendorId: 'minimax'
      },
      upstreamFetch
    )

    await expect(
      bridge.selectSkills('Prepare a compact evidence map for river restoration options.', catalog)
    ).resolves.toEqual([{ name: 'literature-review', path: '/private/review/SKILL.md' }])
    expect(upstreamBody).toMatchObject({ thinking: { type: 'disabled' } })
    expect(upstreamBody).not.toHaveProperty('reasoning_effort')
  })

  it.each([
    ['Codex', undefined],
    ['CodeBuddy', { skillSelectorFailureMode: 'throw' as const }]
  ])(
    'omits unsupported Apodex Chat reasoning controls for %s Skill routing',
    async (_framework, options) => {
      let upstreamBody: Record<string, unknown> = {}
      const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'select_skills',
                      arguments: JSON.stringify({ skill_names: ['literature-review'] })
                    }
                  }
                ]
              }
            }
          ]
        })
      })
      const bridge = new ResponsesBridge(
        {
          baseUrl: 'https://api.apodex.ai/v1',
          model: 'apodex-1.1',
          vendorId: 'apodex'
        },
        upstreamFetch,
        options
      )

      await expect(bridge.selectSkills('Prepare a literature review.', catalog)).resolves.toEqual([
        { name: 'literature-review', path: '/private/review/SKILL.md' }
      ])
      expect(upstreamBody).not.toHaveProperty('thinking')
      expect(upstreamBody).not.toHaveProperty('reasoning_effort')
    }
  )

  it('retries without tools when forced tool choice produces ordinary content', async () => {
    const requests: Array<Record<string, unknown>> = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          id: `selector-${requests.length}`,
          usage: { prompt_tokens: 10 * requests.length, completion_tokens: requests.length },
          choices: [
            {
              message: {
                content:
                  requests.length === 1
                    ? 'I will inspect the catalog first.'
                    : '{"skill_names":["literature-review"]}'
              }
            }
          ]
        })
      )
    })
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const observeUsage = vi.fn()

    await expect(
      bridge.selectSkills('find recent papers', catalog, undefined, observeUsage)
    ).resolves.toEqual([{ name: 'literature-review', path: '/private/review/SKILL.md' }])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toHaveProperty('tool_choice')
    expect(requests[1]).not.toHaveProperty('tools')
    expect(requests[1]).not.toHaveProperty('tool_choice')
    expect(observeUsage.mock.calls.map(([observation]) => observation)).toEqual([
      {
        usage: {
          inputTokens: 10,
          cacheTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          outputTokens: 1
        },
        sourceInvocationId: 'selector-1'
      },
      {
        usage: {
          inputTokens: 20,
          cacheTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          outputTokens: 2
        },
        sourceInvocationId: 'selector-2'
      }
    ])
  })

  it.each([
    ['an upstream error', new Response('provider unavailable', { status: 503 })],
    ['a malformed function result', new Response(JSON.stringify({ choices: [{ message: {} }] }))],
    [
      'a Skill outside the offered catalog',
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'select_skills',
                      arguments: '{"skill_names":["not-offered"]}'
                    }
                  }
                ]
              }
            }
          ]
        })
      )
    ]
  ])('keeps Codex Skill selection fail-open for %s', async (_label, response) => {
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      vi.fn(async () => response.clone())
    )

    await expect(bridge.selectSkills('hello', catalog)).resolves.toEqual([])
  })

  it('bounds candidate fields, catalog count, and the complete serialized request', async () => {
    let upstreamBody = ''
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = String(init?.body)
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'select_skills',
                      arguments: JSON.stringify({ skill_names: [] })
                    }
                  }
                ]
              }
            }
          ]
        })
      )
    })
    const oversizedCatalog = [
      { name: 'oversized', description: 'x'.repeat(1_000_000), path: '/oversized/SKILL.md' },
      ...Array.from({ length: 300 }, (_, index) => ({
        name: `skill-${index}`,
        description: `Description ${index}`,
        path: `/skills/${index}/SKILL.md`
      }))
    ]
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )

    await expect(bridge.selectSkills('hello', oversizedCatalog)).resolves.toEqual([])

    const request = JSON.parse(upstreamBody) as {
      messages: Array<{ content: string }>
      tools: Array<{
        function: {
          parameters: { properties: { skill_names: { items: Record<string, unknown> } } }
        }
      }>
    }
    const catalogJson = request.messages[0].content.split('Skill catalog:\n')[1]
    const names = (JSON.parse(catalogJson) as Array<{ name: string }>).map(({ name }) => name)
    expect(names).toHaveLength(128)
    expect(names).not.toContain('oversized')
    expect(request.tools[0].function.parameters.properties.skill_names.items).toEqual({
      type: 'string'
    })
    expect(request.messages[0].content).not.toContain('x'.repeat(10_000))
    expect(Buffer.byteLength(upstreamBody, 'utf8')).toBeLessThan(300 * 1024)
  })

  it('keeps Codex Skill selection fail-open when the selection deadline expires', async () => {
    const upstreamFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch,
      { skillSelectorTimeoutMs: 5 }
    )

    await expect(bridge.selectSkills('hello', catalog)).resolves.toEqual([])
  })

  it('lets CodeBuddy opt into a fail-closed selector', async () => {
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      vi.fn(async () => new Response('provider unavailable', { status: 503 })),
      { skillSelectorFailureMode: 'throw' }
    )

    await expect(bridge.selectSkills('hello', catalog)).rejects.toThrow(
      'Skill selector failed (invalid-response).'
    )
  })

  it('aborts the upstream selection when the caller cancels the turn', async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const upstreamFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        markStarted()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', model: 'model-a' },
      upstreamFetch
    )
    const controller = new AbortController()

    const selecting = bridge.selectSkills('hello', catalog, controller.signal)
    await started
    controller.abort()

    await expect(selecting).resolves.toEqual([])
  })
})
