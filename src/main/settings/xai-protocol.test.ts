import { describe, expect, it } from 'vitest'

import {
  anthropicToResponses,
  chatToResponses,
  countAnthropicInputTokens,
  responsesToAnthropic,
  responsesToChat,
  sanitizeXaiResponsesRequest
} from './xai-protocol'

describe('xAI protocol projection', () => {
  it('maps Anthropic messages and tools to Responses', () => {
    const request = anthropicToResponses(
      {
        system: 'Be concise.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        max_tokens: 256
      },
      'grok-4.6'
    )
    expect(request).toMatchObject({
      model: 'grok-4.6',
      instructions: 'Be concise.',
      max_output_tokens: 256,
      tools: [{ type: 'function', name: 'lookup' }]
    })
  })

  it('keeps primitive Anthropic message content as text instead of a string array', () => {
    const request = anthropicToResponses(
      { messages: [{ role: 'user', content: 'hello' }] },
      'grok-4.6'
    )
    expect(request.input).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps Chat Completions and tool history to Responses', () => {
    const request = chatToResponses(
      {
        messages: [
          { role: 'system', content: 'Use evidence.' },
          { role: 'tool', tool_call_id: 'call_1', content: '42' }
        ],
        reasoning_effort: 'xhigh'
      },
      'grok-4.6'
    )
    expect(request).toMatchObject({
      instructions: 'Use evidence.',
      reasoning: { effort: 'xhigh' },
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }]
    })
  })

  it('omits empty assistant Chat messages when projecting tool-call history', () => {
    const request = chatToResponses(
      {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' }
              }
            ]
          },
          { role: 'tool', tool_call_id: 'call_1', content: '42' }
        ]
      },
      'grok-4.6'
    )
    expect(request.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}'
      },
      { type: 'function_call_output', call_id: 'call_1', output: '42' }
    ])
  })

  it('maps Responses output to both downstream response shapes', () => {
    const response = {
      id: 'resp_1',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }
      ],
      usage: { input_tokens: 10, output_tokens: 5 }
    }
    expect(responsesToAnthropic(response, 'grok-4.6')).toMatchObject({
      type: 'message',
      content: [
        { type: 'text', text: 'Answer' },
        { type: 'tool_use', name: 'lookup' }
      ]
    })
    expect(responsesToChat(response, 'grok-4.6')).toMatchObject({
      object: 'chat.completion',
      choices: [{ finish_reason: 'tool_calls' }],
      usage: { total_tokens: 15 }
    })
  })

  it('removes unsupported fields and estimates token counts locally', () => {
    expect(
      sanitizeXaiResponsesRequest({
        prompt_cache_retention: '24h',
        safety_identifier: 'secret',
        input: [{ external_web_access: true, content: null }]
      })
    ).toEqual({ input: [{}] })
    expect(
      countAnthropicInputTokens({ messages: [{ role: 'user', content: 'hello world' }] })
    ).toBeGreaterThan(0)
  })
})
