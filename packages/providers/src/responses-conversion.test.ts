import { describe, expect, it } from 'vitest'
import { inputToMessages, responsesToChatRequest, toolsToChat } from './responses-request-adapter'

describe('Responses conversion matrix', () => {
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
    const reasoningByCallId = new Map([
      [JSON.stringify(['function_call', 'call-1']), { text: 'let me look that up' }]
    ])
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

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'preserves MiniMax M3.1 %s effort through the Chat bridge',
    (effort) => {
      const request = responsesToChatRequest(
        { model: 'catalog', input: 'hi' },
        'MiniMax-M3.1-Flash-Preview',
        undefined,
        [],
        { vendorId: 'minimax', reasoningEffortOverride: effort }
      )
      expect(request).toMatchObject({
        model: 'MiniMax-M3.1-Flash-Preview',
        reasoning_effort: effort,
        thinking: { type: 'adaptive' }
      })
    }
  )

  it('leaves MiniMax M3.1 default effort to the provider', () => {
    const request = responsesToChatRequest(
      { model: 'catalog', input: 'hi' },
      'MiniMax-M3.1-Flash-Preview',
      undefined,
      [],
      { vendorId: 'minimax' }
    )
    expect(request).not.toHaveProperty('reasoning_effort')
    expect(request).not.toHaveProperty('thinking')
  })

  it('keeps the explicit custom MiniMax transport independent of model names', () => {
    const request = responsesToChatRequest(
      { model: 'catalog', input: 'hi' },
      'MiniMax-M3.1-Flash-Preview',
      undefined,
      [],
      { reasoningEffortTransport: 'minimax', reasoningEffortOverride: 'none' }
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
})

it('R01 keeps parallel Codex results together and associates images without mutating replay', () => {
  const image = {
    type: 'input_image',
    image_url: 'https://example.test/image.png',
    detail: 'high'
  }
  const body = {
    input: [
      { type: 'function_call', call_id: 'call_parallel_alpha', name: 'first', arguments: '{}' },
      { type: 'function_call', call_id: 'call_parallel_beta', name: 'second', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_parallel_alpha',
        output: [{ type: 'input_text', text: 'first result' }, image]
      },
      {
        type: 'function_call_output',
        call_id: 'call_parallel_beta',
        output: [{ type: 'input_text', text: 'second result' }, image]
      },
      { type: 'message', role: 'assistant', content: 'I see both images.' }
    ]
  }
  const original = structuredClone(body)
  const result = responsesToChatRequest(body, 'test')
  expect(result.messages.slice(0, 3)).toMatchObject([
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_parallel_alpha' }, { id: 'call_parallel_beta' }]
    },
    { role: 'tool', tool_call_id: 'call_parallel_alpha', content: 'first result' },
    { role: 'tool', tool_call_id: 'call_parallel_beta', content: 'second result' }
  ])
  const media = result.messages.slice(3, -1)
  expect(
    media
      .flatMap((message: { content: { type: string }[] }) => message.content)
      .filter((part: { type: string }) => part.type === 'image_url')
  ).toEqual([
    { type: 'image_url', image_url: { url: image.image_url, detail: 'high' } },
    { type: 'image_url', image_url: { url: image.image_url, detail: 'high' } }
  ])
  expect(JSON.stringify(media)).toContain('call_parallel_alpha')
  expect(JSON.stringify(media)).toContain('call_parallel_beta')
  expect(body).toEqual(original)
  expect(responsesToChatRequest(body, 'test')).toEqual(result)
})
