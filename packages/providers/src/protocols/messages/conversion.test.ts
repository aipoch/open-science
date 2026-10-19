import { expect, it } from 'vitest'
import { chatCompletionsToMessages, messagesToChatCompletions } from './conversion'
it('encodes images, system content, tools and tool results in the Messages wire format', () => {
  const request = chatCompletionsToMessages(
    {
      messages: [
        { role: 'system', content: 'system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'question' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
            { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }
          ]
        },
        {
          role: 'assistant',
          tool_calls: [{ id: 'tool', function: { name: 'lookup', arguments: '{"q":1}' } }]
        },
        { role: 'tool', tool_call_id: 'tool', content: 'found' }
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      max_completion_tokens: 20
    },
    'm'
  )
  expect(request).toMatchObject({
    model: 'm',
    system: 'system',
    max_tokens: 20,
    tool_choice: { type: 'any' },
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'question' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
          { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool', name: 'lookup', input: { q: 1 } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'found' }] }
    ]
  })
})
it.each([
  ['end_turn', 'stop'],
  ['max_tokens', 'length'],
  ['refusal', 'content_filter']
])('preserves termination %s and cache accounting', (stop_reason, finish_reason) => {
  const response = messagesToChatCompletions(
    {
      stop_reason,
      content: [{ type: 'text', text: 'answer' }],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7
      }
    },
    'm'
  )
  expect(response).toMatchObject({
    choices: [{ finish_reason, message: { content: 'answer' } }],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 2,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 5 },
      cache_creation_input_tokens: 7
    }
  })
})
it('preserves tool calls and rejects unknown completion states', () => {
  expect(
    messagesToChatCompletions(
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: { q: 1 } }]
      },
      'm'
    )
  ).toMatchObject({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{ id: 'call', function: { name: 'lookup', arguments: '{"q":1}' } }]
        }
      }
    ]
  })
  expect(() => messagesToChatCompletions({ stop_reason: 'unknown' }, 'm')).toThrow('Unsupported')
})
