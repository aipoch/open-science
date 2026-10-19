import { describe, expect, it } from 'vitest'

import {
  messagesToResponses,
  chatCompletionsToResponses,
  responsesToMessages,
  responsesToChatCompletions
} from './responses/conversion'
import { countMessagesInputTokens } from './messages/tokens'
import { sanitizeXaiResponsesRequest } from './xai/responses'

type Json = Record<string, unknown>
const imageParts = (value: unknown): Json[] => {
  if (Array.isArray(value)) return value.flatMap(imageParts)
  if (value === null || typeof value !== 'object') return []
  const part = value as Json
  return part.type === 'input_image' || part.type === 'image_url'
    ? [part]
    : Object.values(part).flatMap(imageParts)
}

describe('xAI protocol projection', () => {
  it('maps Anthropic messages and tools to Responses', () => {
    const request = messagesToResponses(
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
    const request = messagesToResponses(
      { messages: [{ role: 'user', content: 'hello' }] },
      'grok-4.6'
    )
    expect(request.input).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps Chat Completions and tool history to Responses', () => {
    const request = chatCompletionsToResponses(
      {
        messages: [
          { role: 'system', content: 'Use evidence.' },
          { role: 'tool', tool_call_id: 'call_1', content: '42' }
        ],
        reasoning_effort: 'xhigh',
        tool_choice: { type: 'function', function: { name: 'lookup' } }
      },
      'grok-4.6'
    )
    expect(request).toMatchObject({
      instructions: 'Use evidence.',
      reasoning: { effort: 'xhigh' },
      tool_choice: { type: 'function', name: 'lookup' },
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }]
    })
  })

  it('omits empty assistant Chat messages when projecting tool-call history', () => {
    const request = chatCompletionsToResponses(
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
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 }
      }
    }
    expect(responsesToMessages(response, 'grok-4.6')).toMatchObject({
      type: 'message',
      content: [
        { type: 'text', text: 'Answer' },
        { type: 'tool_use', name: 'lookup' }
      ]
    })
    expect(responsesToChatCompletions(response, 'grok-4.6')).toMatchObject({
      object: 'chat.completion',
      choices: [{ finish_reason: 'tool_calls' }],
      usage: {
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 }
      }
    })
  })

  it('removes unsupported fields and estimates token counts locally', () => {
    expect(
      sanitizeXaiResponsesRequest({
        prompt_cache_retention: '24h',
        safety_identifier: 'secret',
        external_web_access: true,
        previous_response_id: null,
        input: [{ role: 'user', content: 'hello' }]
      })
    ).toEqual({ input: [{ role: 'user', content: 'hello' }] })
    expect(
      countMessagesInputTokens({ messages: [{ role: 'user', content: 'hello world' }] })
    ).toBeGreaterThan(0)
  })

  it.each(['native', 'messages', 'chat'] as const)(
    'R08 preserves business schema names and null constraints (%s)',
    (wire) => {
      const schema = {
        type: 'object',
        properties: {
          safety_identifier: { type: 'string' },
          external_web_access: { type: 'boolean' },
          prompt_cache_retention: { type: 'string' },
          nullable: { const: null }
        },
        required: ['safety_identifier', 'nullable'],
        additionalProperties: false
      }
      const original = structuredClone(schema)
      const request =
        wire === 'native'
          ? sanitizeXaiResponsesRequest({
              safety_identifier: 'metadata',
              tools: [{ type: 'function', name: 'audit', parameters: schema }]
            })
          : wire === 'messages'
            ? messagesToResponses(
                { messages: [], tools: [{ name: 'audit', input_schema: schema }] },
                'test'
              )
            : chatCompletionsToResponses(
                {
                  messages: [],
                  tools: [{ type: 'function', function: { name: 'audit', parameters: schema } }]
                },
                'test'
              )
      expect(request).not.toHaveProperty('safety_identifier')
      expect(schema).toEqual(original)
      expect(request.tools).toEqual([expect.objectContaining({ parameters: original })])
    }
  )

  it('R01 preserves URL images in Claude tool results and their call association', () => {
    const result = messagesToResponses(
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'url_call',
                content: [
                  { type: 'text', text: 'image result' },
                  { type: 'image', source: { type: 'url', url: 'https://example.test/tool.png' } }
                ]
              },
              { type: 'tool_result', tool_use_id: 'other_call', content: 'other result' }
            ]
          }
        ]
      },
      'test'
    )
    expect((result.input as Json[]).slice(0, 2)).toEqual([
      { type: 'function_call_output', call_id: 'url_call', output: 'image result' },
      { type: 'function_call_output', call_id: 'other_call', output: 'other result' }
    ])
    expect(imageParts(result)).toEqual([
      { type: 'input_image', image_url: 'https://example.test/tool.png' }
    ])
    expect(JSON.stringify((result.input as Json[]).slice(2))).toContain('url_call')
  })

  it('R08 leaves schema defaults, enums, metadata and tool output business values opaque', () => {
    const data = {
      safety_identifier: null,
      external_web_access: false,
      prompt_cache_retention: 'business'
    }
    const body = {
      prompt_cache_retention: '24h',
      safety_identifier: 'wire',
      external_web_access: true,
      previous_response_id: null,
      metadata: data,
      input: [{ type: 'function_call_output', call_id: 'a', output: data }],
      additional_tools: [
        {
          type: 'function',
          name: 'audit',
          parameters: {
            type: 'object',
            properties: { value: { enum: [null, 'present'], default: null } }
          }
        }
      ]
    }
    const expected = structuredClone(body)
    const result = sanitizeXaiResponsesRequest(body)
    expect(result).toEqual({
      metadata: expected.metadata,
      input: expected.input,
      tools: expected.additional_tools
    })
    expect(body).toEqual(expected)
  })
})
