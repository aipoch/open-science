import { describe, expect, it } from 'vitest'

import { responsesToChatRequest } from './responses-request-adapter'

describe('Responses request protocol adapter', () => {
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
      new Map([['call-1', 'inspect the notebook first']]),
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
})
