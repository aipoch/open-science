import { describe, expect, it } from 'vitest'

import { responsesToChatRequest } from './responses-request-adapter'

describe('Responses request protocol adapter', () => {
  it.each([undefined, 'auto', 'low', 'high', 'original'])(
    'converts image detail %s in replay without mutating the input',
    (detail) => {
      const imageUrl = 'https://example.test/image.png'
      const input = [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageUrl, detail },
            { type: 'image_url', image_url: { url: imageUrl, detail } }
          ]
        },
        { type: 'message', role: 'assistant', content: 'An image.' },
        { type: 'message', role: 'user', content: 'Describe it again.' }
      ]
      const before = structuredClone(input)
      const expectedDetail = detail === 'original' ? 'high' : detail
      const converted = {
        type: 'image_url',
        image_url: {
          url: imageUrl,
          ...(expectedDetail === undefined ? {} : { detail: expectedDetail })
        }
      }
      expect(responsesToChatRequest({ input }).messages).toEqual([
        { role: 'user', content: [converted, converted] },
        { role: 'assistant', content: 'An image.' },
        { role: 'user', content: 'Describe it again.' }
      ])
      expect(input).toEqual(before)
    }
  )

  it('rejects conflicting image details before normalization', () => {
    expect(() =>
      responsesToChatRequest({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_image',
                detail: 'original',
                image_url: { url: 'https://example.test/image.png', detail: 'high' }
              }
            ]
          }
        ]
      })
    ).toThrow('Responses image detail values must not conflict')
  })

  it('converts replayed namespaced tool calls, images, and configured reasoning without session state', () => {
    const request = responsesToChatRequest(
      {
        model: 'catalog-model',
        instructions: 'Use the notebook.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Inspect this image.' },
              {
                type: 'input_image',
                image_url: 'https://example.test/image.png',
                detail: 'high'
              }
            ]
          },
          {
            type: 'function_call',
            call_id: 'call-1',
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            arguments: '{"code":"print(1)"}'
          },
          { type: 'function_call_output', call_id: 'call-1', output: '1' }
        ],
        tools: [],
        stream: false
      },
      'deepseek-v4-pro',
      new Map([
        [JSON.stringify(['function_call', 'call-1']), { text: 'inspect the notebook first' }]
      ]),
      [
        {
          namespace: 'mcp__open_science_notebook',
          name: 'notebook_execute',
          parameters: { type: 'object' }
        }
      ],
      { reasoningEffortOverride: 'none', vendorId: 'deepseek' }
    )

    expect(request).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: false,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: 'Use the notebook.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this image.' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/image.png', detail: 'high' }
            }
          ]
        },
        {
          role: 'assistant',
          reasoning_content: 'inspect the notebook first',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'mcp__open_science_notebook__notebook_execute',
                arguments: '{"code":"print(1)"}'
              }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call-1', content: '1' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'mcp__open_science_notebook__notebook_execute',
            parameters: { type: 'object' }
          }
        }
      ]
    })
  })

  it('keeps function-call images in associated user content', () => {
    const imageOutput = [
      { type: 'input_text', text: '{"status":"completed"}' },
      { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }
    ]
    const request = responsesToChatRequest(
      {
        model: 'catalog-model',
        input: [
          { type: 'function_call', call_id: 'call-1', name: 'repl_execute', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: imageOutput }
        ],
        tools: [],
        stream: false
      },
      'chat-model'
    )

    expect(request.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"status":"completed"}'
    })
    expect(request.messages).toContainEqual(
      expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({ type: 'image_url' })])
      })
    )
  })
})
