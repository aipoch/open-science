import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

import {
  ResponsesBridge,
  completionToResponse,
  inputToMessages,
  responsesToChatRequest,
  toolsToChat,
  upstreamErrorMessage
} from './responses-bridge'

describe('Responses-compatible bridge conversion', () => {
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

  it('maps Chat Completions output text and tool calls to a Responses response', () => {
    expect(
      completionToResponse({
        id: 'chat-1',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"id":1}' }
                }
              ]
            }
          }
        ],
        usage: { total_tokens: 4 }
      })
    ).toMatchObject({
      id: 'chat-1',
      model: 'model-a',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"id":1}' }
      ],
      usage: { total_tokens: 4 }
    })
  })

  it('restores namespace metadata for non-streaming Chat Completions tool calls', () => {
    expect(
      completionToResponse(
        {
          id: 'chat-mcp-json',
          model: 'model-a',
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-mcp-json',
                    type: 'function',
                    function: {
                      name: 'mcp__open_science_notebook__notebook_execute',
                      arguments: '{"code":"print(1)"}'
                    }
                  }
                ]
              }
            }
          ]
        },
        [
          {
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            parameters: { type: 'object' }
          }
        ]
      )
    ).toMatchObject({
      output: [
        {
          type: 'function_call',
          call_id: 'call-mcp-json',
          namespace: 'mcp__open_science_notebook',
          name: 'notebook_execute'
        }
      ]
    })
  })

  it('drops reasoning_content and keeps the visible answer instead of aborting the turn', () => {
    expect(
      completionToResponse({
        id: 'chat-reasoning',
        model: 'model-a',
        choices: [
          { message: { role: 'assistant', reasoning_content: 'hidden thought', content: '11' } }
        ]
      })
    ).toMatchObject({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '11' }] }]
    })
  })

  it('surfaces a refusal as the visible answer', () => {
    expect(
      completionToResponse({
        id: 'chat-refusal',
        model: 'model-a',
        choices: [{ message: { role: 'assistant', refusal: 'I cannot help with that.' } }]
      })
    ).toMatchObject({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'I cannot help with that.' }] }
      ]
    })
  })

  it('rejects upstream image output instead of returning an empty Responses result', () => {
    expect(() =>
      completionToResponse({
        id: 'chat-image',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,aGVsbG8=' }
                }
              ]
            }
          }
        ]
      })
    ).toThrow(/Upstream image output is not supported/)
    expect(() =>
      completionToResponse({
        id: 'chat-images',
        model: 'model-a',
        choices: [
          { message: { role: 'assistant', images: [{ url: 'https://example.test/a.png' }] } }
        ]
      })
    ).toThrow(/Upstream image output is not supported/)
    expect(() =>
      completionToResponse({
        id: 'chat-image-object',
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              content: { type: 'output_image', image_url: 'https://example.test/a.png' }
            }
          }
        ]
      })
    ).toThrow(/Upstream image output is not supported/)
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

  it('translates the reasoning effort into the Chat Completions parameter when explicitly chosen', () => {
    expect(
      responsesToChatRequest(
        { model: 'model-a', input: 'hi', reasoning: { effort: 'high' } },
        undefined,
        undefined,
        [],
        { forwardReasoningEffort: true }
      )
    ).toMatchObject({ reasoning_effort: 'high' })
    expect(
      responsesToChatRequest(
        { model: 'model-a', input: 'hi', reasoning: { effort: 'low' } },
        undefined,
        undefined,
        [],
        { forwardReasoningEffort: true }
      )
    ).toMatchObject({ reasoning_effort: 'low' })
  })

  it('clamps the Codex-only xhigh effort to high for Chat Completions', () => {
    expect(
      responsesToChatRequest(
        { model: 'model-a', input: 'hi', reasoning: { effort: 'xhigh' } },
        undefined,
        undefined,
        [],
        { forwardReasoningEffort: true }
      )
    ).toMatchObject({ reasoning_effort: 'high' })
  })

  it('omits the reasoning effort when there is nothing portable to send', () => {
    // 'none' has no Chat Completions equivalent — the upstream default stands. No reasoning block
    // means nothing is sent either.
    expect(
      responsesToChatRequest(
        { model: 'model-a', input: 'hi', reasoning: { effort: 'none' } },
        undefined,
        undefined,
        [],
        { forwardReasoningEffort: true }
      )
    ).not.toHaveProperty('reasoning_effort')
    expect(
      responsesToChatRequest({ model: 'model-a', input: 'hi' }, undefined, undefined, [], {
        forwardReasoningEffort: true
      })
    ).not.toHaveProperty('reasoning_effort')
  })

  it('strips the reasoning effort unless the user explicitly chose a level', () => {
    // Codex emits its own default effort even when the app never configured one; forwarding that
    // would change what existing bridged users send to gateways that may reject unknown params.
    expect(
      responsesToChatRequest({ model: 'model-a', input: 'hi', reasoning: { effort: 'high' } })
    ).not.toHaveProperty('reasoning_effort')
  })

  it('surfaces a nested upstream error instead of hiding it behind HTTP status', () => {
    expect(
      upstreamErrorMessage('{"error":{"message":"Model deepseek-v4-flash does not exist"}}', 400)
    ).toBe('Model deepseek-v4-flash does not exist')
    expect(upstreamErrorMessage('plain upstream failure', 400)).toBe('plain upstream failure')
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
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        ]
      })
      expect(output).toContain('response.output_text.delta')
      expect(output).toContain('bridge-ok')
      expect(output).toContain('response.completed')
    } finally {
      await bridge.close()
    }
  })

  it('forwards the reasoning effort to the upstream gateway when explicitly chosen', async () => {
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
      { baseUrl: 'https://vendor.example/v1', key: 'upstream-key', forwardReasoningEffort: true },
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

      // The Codex-only 'xhigh' reaches the gateway as 'high', not dropped.
      expect(response.status).toBe(200)
      expect(upstreamRequest).toMatchObject({ reasoning_effort: 'high' })
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
    // No forwardReasoningEffort: Codex's own default effort must not change what existing bridged
    // users send upstream.
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

      // The user picks a level (Codex applies it live over ACP — the bridge never reconnects).
      bridge.setForwardReasoningEffort(true)
      await post()
      expect(upstreamRequest).toMatchObject({ reasoning_effort: 'high' })

      // Back to default: stripping restored on the same live bridge.
      bridge.setForwardReasoningEffort(false)
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
        ],
        connectorInstructions: [
          {
            id: 'pubmed',
            aliases: ['PubMed'],
            content:
              'Reach this service ONLY via host.mcp. Example: host.mcp("pubmed", "search_articles", {"query": "cancer"})'
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
      expect(upstreamRequest?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('host.mcp("pubmed", "search_articles"')
          })
        ])
      )
      expect(output).toContain('"type":"function_call"')
      expect(output).toContain('"namespace":"mcp__open_science_notebook"')
      expect(output).toContain('"name":"notebook_execute"')
      expect(output).toContain('"call_id":"call-notebook-1"')
      expect(output).not.toContain('"name":"mcp__open_science_notebook__notebook_execute"')
    } finally {
      await bridge.close()
    }
  })

  it('advertises reviewer MCP functions only for a trusted registered session key', async () => {
    const upstreamRequests: Array<Record<string, unknown>> = []
    const upstreamFetch = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(
          [
            `data: ${JSON.stringify({
              id: 'chat-reviewer-scope',
              model: 'model-a',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
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
        baseUrl: 'https://vendor.example/v1',
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
    const post = async (input: string, promptCacheKey: string): Promise<void> => {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
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
      await response.text()
    }

    try {
      bridge.registerReviewerSession('never-observed-reviewer-session')
      expect(bridge.unregisterReviewerSession('never-observed-reviewer-session')).toBe(false)

      await post(`${legacyReviewerMarker} normal user content`, 'normal-session')
      bridge.registerReviewerSession('reviewer-session')
      await post('review this turn without a model-visible routing marker', 'reviewer-session')
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
    } finally {
      await bridge.close()
    }
  })

  it('selects connector guidance from the latest user turn instead of stale history', async () => {
    const upstreamFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      expect(request.messages[0].content).toContain('GENES_GUIDANCE')
      expect(request.messages[0].content).not.toContain('PUBMED_GUIDANCE')
      return Response.json({
        id: 'c-latest',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'ok' } }]
      })
    })
    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://vendor.example/v1',
        connectorInstructions: [
          { id: 'pubmed', aliases: ['PubMed'], content: 'PUBMED_GUIDANCE' },
          { id: 'genes', aliases: ['mygene.info'], content: 'GENES_GUIDANCE' }
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
          model: 'm',
          stream: false,
          input: [
            { type: 'message', role: 'user', content: 'Use PubMed for cancer papers' },
            { type: 'message', role: 'assistant', content: 'done' },
            { type: 'message', role: 'user', content: 'Use mygene.info for TP53' }
          ]
        })
      })
      expect(response.status).toBe(200)
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
    const cache = (bridge as unknown as { reasoningByCallId: Map<string, string> })
      .reasoningByCallId
    cache.set('call-1', 'thinking')
    // Same target (e.g. a skill-reload reconnect): cache is preserved so a resumed thinking session works.
    bridge.setTarget({ baseUrl: 'https://a.example/v1', model: 'm1', key: 'k1' })
    expect(cache.has('call-1')).toBe(true)
    // Real provider switch: cache is cleared so stale reasoning can't leak across providers.
    bridge.setTarget({ baseUrl: 'https://b.example/v1', model: 'm2', key: 'k2' })
    expect(cache.size).toBe(0)
  })
})
