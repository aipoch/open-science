import { describe, expect, it, vi } from 'vitest'

import {
  completionToResponse,
  streamChatToResponses,
  upstreamErrorMessage
} from './responses-response-adapter'

describe('Responses result protocol adapter', () => {
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
        usage: {
          prompt_tokens: 3,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 5
        }
      })
    ).toMatchObject({
      id: 'chat-1',
      model: 'model-a',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"id":1}' }
      ],
      usage: {
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 5
      }
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

  it('surfaces a nested upstream error instead of hiding it behind HTTP status', () => {
    expect(
      upstreamErrorMessage('{"error":{"message":"Model deepseek-v4-flash does not exist"}}', 400)
    ).toBe('Model deepseek-v4-flash does not exist')
    expect(upstreamErrorMessage('plain upstream failure', 400)).toBe('plain upstream failure')
  })

  it('assembles fragmented tool calls and emits ordered terminal SSE events', async () => {
    let output = ''
    const writer = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        output += chunk
        return true
      }),
      end: vi.fn()
    }
    const record = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
    const upstream = new Response(
      [
        record({
          choices: [
            {
              delta: {
                reasoning_content: 'inspect first',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-',
                    function: { name: 'mcp__open_science_', arguments: '' }
                  }
                ]
              }
            }
          ]
        }),
        record({
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: '1',
                    function: {
                      name: 'notebook__notebook_execute',
                      arguments: '{"code":"print(1)"}'
                    }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        }),
        'data: [DONE]\n\n'
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )

    await expect(
      streamChatToResponses(upstream, writer, 'catalog-model', [
        {
          namespace: 'mcp__open_science_notebook',
          name: 'notebook_execute',
          parameters: { type: 'object' }
        }
      ])
    ).resolves.toEqual({ reasoning: 'inspect first', callIds: ['call-1'] })

    expect(writer.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    expect(output).toContain('event: response.function_call_arguments.delta')
    expect(output).toContain('"namespace":"mcp__open_science_notebook"')
    expect(output.indexOf('event: response.created')).toBeLessThan(
      output.indexOf('event: response.completed')
    )
    expect(output).toContain('"input_tokens":3')
    expect(writer.end).toHaveBeenCalledOnce()
  })
})
