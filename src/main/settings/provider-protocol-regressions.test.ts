import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatProviderCompatibilityBridge } from './chat-provider-compatibility'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { normalizeOpenAiChatModelStepUsage } from './openai-chat-usage'
import {
  CAPTURED_TOOL_IMAGE_PNG_BASE64,
  CLAUDE_CODE_TOOL_IMAGE_REQUEST_FIXTURE,
  CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE
} from './provider-tool-image-wire.test-fixtures'
import { ResponsesBridge } from './responses-bridge'
import { responsesToChatRequest } from './responses-request-adapter'
import { streamChatToResponses } from './responses-response-adapter'
import { createXaiOAuthProviderBridge } from './xai-oauth-provider-bridge'
import { anthropicToResponses, chatToResponses, sanitizeXaiResponsesRequest } from './xai-protocol'

type Json = Record<string, unknown>
const bridges: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

const post = async (
  bridge: { start(): Promise<{ baseUrl: string; token: string }>; close(): Promise<void> },
  path: string,
  body: Json
): Promise<Response> => {
  if (!bridges.includes(bridge)) bridges.push(bridge)
  const connection = await bridge.start()
  return fetch(`${connection.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}
const sse = (body: string): ReturnType<typeof JSON.parse>[] =>
  body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    return !data || data === '[DONE]' ? [] : [JSON.parse(data)]
  })
const responsePayload = {
  id: 'resp_report',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
  usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 5 }, output_tokens: 2 }
}
const xai = (
  wire: 'anthropic' | 'openai',
  upstream: typeof fetch
): ReturnType<typeof createXaiOAuthProviderBridge> =>
  createXaiOAuthProviderBridge(
    [{ id: 'active', model: 'grok-test' }],
    'active',
    wire,
    async () => 'test-token',
    upstream
  )
const chat = (payload: Json): ChatProviderCompatibilityBridge =>
  new ChatProviderCompatibilityBridge(
    { wire: 'anthropic', endpoint: 'https://provider.example/v1/messages', model: 'test-model' },
    async () => Response.json(payload)
  )
const textRequest = { messages: [{ role: 'user', content: 'Continue' }] }

// Only traverse structured values: a base64 string hidden inside JSON text is not an image part.
const imageParts = (value: unknown): Json[] => {
  if (Array.isArray(value)) return value.flatMap(imageParts)
  if (value === null || typeof value !== 'object') return []
  const part = value as Json
  return part.type === 'input_image' || part.type === 'image_url'
    ? [part]
    : Object.values(part).flatMap(imageParts)
}

describe('provider protocol report regressions', () => {
  it('R01a preserves a captured Codex tool image as a multimodal part over HTTP', async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'chat-report',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
      })
    )
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://provider.example/v1', model: 'test' },
      upstream
    )
    const response = await post(bridge, '/responses', {
      ...CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE,
      stream: false
    })
    expect(response.status).toBe(200)
    await response.text()
    const sent = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))
    expect(imageParts(sent)).toHaveLength(1)
    expect(JSON.stringify(imageParts(sent))).toContain(CAPTURED_TOOL_IMAGE_PNG_BASE64)
    expect(sent.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_fixture_1' })
    )
    expect(
      sent.messages
        .filter((message: Json) => message.role === 'tool')
        .some((message: Json) => String(message.content).includes(CAPTURED_TOOL_IMAGE_PNG_BASE64))
    ).toBe(false)
  })

  it('R01b preserves a captured Claude tool image through the xAI HTTP bridge', async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json(responsePayload))
    const response = await post(xai('anthropic', upstream), '/v1/messages', {
      ...CLAUDE_CODE_TOOL_IMAGE_REQUEST_FIXTURE,
      max_tokens: 128
    })
    expect(response.status).toBe(200)
    await response.text()
    const sent = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))
    expect(imageParts(sent)).toHaveLength(1)
    expect(JSON.stringify(imageParts(sent))).toContain(CAPTURED_TOOL_IMAGE_PNG_BASE64)
    expect(sent.input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'toolu_fixture_1' })
    )
  })

  it.each([false, true])(
    'R02 Chat length preserves truncation through Responses HTTP (stream=%s)',
    async (stream) => {
      const completion = {
        id: 'chat-length',
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }]
      }
      const upstream = vi.fn<typeof fetch>(async () =>
        stream
          ? new Response(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } }
            )
          : Response.json(completion)
      )
      const response = await post(
        new ResponsesBridge({ baseUrl: 'https://provider.example/v1', model: 'test' }, upstream),
        '/responses',
        { input: 'continue', stream }
      )
      expect(response.status).toBe(200)
      const result = stream ? sse(await response.text()).at(-1)?.response : await response.json()
      expect(result).toMatchObject({ status: 'incomplete' })
    }
  )

  it.each(['anthropic', 'openai'] as const)(
    'R02 Responses incomplete preserves truncation for %s',
    async (wire) => {
      const response = await post(
        xai(wire, async () =>
          Response.json({
            ...responsePayload,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' }
          })
        ),
        wire === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
        textRequest
      )
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(wire === 'anthropic' ? payload.stop_reason : payload.choices[0].finish_reason).toBe(
        wire === 'anthropic' ? 'max_tokens' : 'length'
      )
    }
  )

  it('R02 Messages max_tokens preserves truncation in the Chat HTTP output', async () => {
    const response = await post(
      chat({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
      '/v1/chat/completions',
      textRequest
    )
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].finish_reason).toBe('length')
  })

  it('R03 preserves cached input totals and normalizable cache read/write usage over HTTP', async () => {
    const response = await post(
      chat({
        content: [],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 4,
          output_tokens: 2
        }
      }),
      '/v1/chat/completions',
      textRequest
    )
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect
      .soft(payload.usage)
      .toMatchObject({ prompt_tokens: 17, total_tokens: 19, completion_tokens: 2 })
    expect(normalizeOpenAiChatModelStepUsage(payload.usage)).toEqual({
      inputTokens: 3,
      cachedReadTokens: 10,
      cachedWriteTokens: 4,
      cacheTokens: 14,
      outputTokens: 2
    })
  })

  it('R04 emits requested SSE usage matching the same xAI JSON response', async () => {
    const bridge = xai('openai', async () => Response.json(responsePayload))
    const json = await post(bridge, '/v1/chat/completions', textRequest)
    expect(json.status).toBe(200)
    const payload = await json.json()
    expect(payload.usage).toMatchObject({
      prompt_tokens: 12,
      prompt_tokens_details: { cached_tokens: 5 }
    })
    const response = await post(bridge, '/v1/chat/completions', {
      ...textRequest,
      stream: true,
      stream_options: { include_usage: true }
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('data: [DONE]')
    expect(sse(body).filter((chunk) => chunk.usage)).toEqual([
      expect.objectContaining({ choices: [], usage: payload.usage })
    ])
  })

  it('R05 preserves two tool calls when Chat HTTP SSE is consumed by the existing adapter', async () => {
    const response = await post(
      chat({
        content: [
          { type: 'tool_use', id: 'call_a', name: 'first', input: { a: 1 } },
          { type: 'tool_use', id: 'call_b', name: 'second', input: { b: 2 } }
        ],
        stop_reason: 'tool_use'
      }),
      '/v1/chat/completions',
      { ...textRequest, stream: true }
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    const calls = sse(body).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])
    expect.soft(calls.map((call) => call.index)).toEqual([0, 1])
    let converted = ''
    await streamChatToResponses(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      {
        writeHead: vi.fn(),
        write: (chunk) => {
          converted += chunk
          return true
        },
        end: vi.fn()
      },
      'test-model'
    )
    expect(
      sse(converted)
        .at(-1)
        ?.response.output.filter((item: Json) => item.type === 'function_call')
    ).toMatchObject([
      { call_id: 'call_a', name: 'first', arguments: '{"a":1}' },
      { call_id: 'call_b', name: 'second', arguments: '{"b":2}' }
    ])
  })

  it.each(['incomplete', 'completed'])(
    'R06 rejects invalid tool arguments instead of emitting an empty call (%s)',
    async (status) => {
      const response = await post(
        xai('anthropic', async () =>
          Response.json({
            ...responsePayload,
            status,
            incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
            output: [
              {
                type: 'function_call',
                call_id: 'call_bad',
                name: 'read_file',
                arguments: '{"path":'
              }
            ]
          })
        ),
        '/v1/messages',
        textRequest
      )
      const payload = await response.json()
      expect
        .soft(payload.content?.filter((part: Json) => part.type === 'tool_use') ?? [])
        .toEqual([])
      expect(response.status).toBe(502)
      expect(payload).toHaveProperty('error')
    }
  )

  it('R06 control preserves a legitimate empty-object call', async () => {
    const response = await post(
      xai('anthropic', async () =>
        Response.json({
          ...responsePayload,
          output: [{ type: 'function_call', call_id: 'call_ok', name: 'get_time', arguments: '{}' }]
        })
      ),
      '/v1/messages',
      textRequest
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: 'tool_use', input: {} }],
      stop_reason: 'tool_use'
    })
  })

  it.each([
    { multiline: false, crlf: false },
    { multiline: true, crlf: false },
    { multiline: true, crlf: true }
  ])(
    'R07 restores tool identity in a complete SSE event ($multiline, crlf=$crlf)',
    async ({ multiline, crlf }) => {
      const upstream = vi.fn<typeof fetch>(async (_, init) => {
        const request = JSON.parse(String(init?.body))
        const item = {
          type: 'function_call',
          id: 'fc_a',
          call_id: 'call_a',
          name: request.tools[0].name,
          arguments: '{}'
        }
        const prefix = '{"type":"response.output_item.done",'
        const suffix = `"output_index":0,"item":${JSON.stringify(item)}}`
        const body = `: heartbeat\nevent: response.output_item.done\nid: event-1\nretry: 1500\ndata: ${prefix}${multiline ? '\ndata: ' : ''}${suffix}\n\nevent: unknown\ndata: not-json\n\ndata: [DONE]\n\n`
        const bytes = new TextEncoder().encode(crlf ? body.replaceAll('\n', '\r\n') : body)
        return new Response(
          new ReadableStream({
            start(controller) {
              // Split inside field names and CRLF boundaries, not only at event boundaries.
              for (let index = 0; index < bytes.length; index += 7)
                controller.enqueue(bytes.slice(index, index + 7))
              controller.close()
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
      const response = await post(
        new NativeResponsesCompatibilityProxy(
          { baseUrl: 'https://provider.example/v1', model: 'test' },
          upstream
        ),
        '/responses',
        {
          input: 'lookup',
          stream: true,
          tools: [
            {
              type: 'namespace',
              name: 'mcp__audit',
              tools: [
                { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }
              ]
            }
          ]
        }
      )
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain(': heartbeat')
      expect(body).toContain('id: event-1')
      expect(body).toContain('retry: 1500')
      expect(body).toContain(
        crlf ? 'event: unknown\r\ndata: not-json\r\n\r\n' : 'event: unknown\ndata: not-json\n\n'
      )
      expect(sse(body.split('event: unknown')[0])[0].item).toMatchObject({
        name: 'lookup',
        namespace: 'mcp__audit',
        call_id: 'call_a'
      })
    }
  )

  it.each(['native', 'anthropic', 'chat'])(
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
          : wire === 'anthropic'
            ? anthropicToResponses(
                { messages: [], tools: [{ name: 'audit', input_schema: schema }] },
                'test'
              )
            : chatToResponses(
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
})

describe('provider protocol regression edge contracts', () => {
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
    expect(imageParts(media)).toEqual([
      { type: 'image_url', image_url: { url: image.image_url, detail: 'high' } },
      { type: 'image_url', image_url: { url: image.image_url, detail: 'high' } }
    ])
    expect(JSON.stringify(media)).toContain('call_parallel_alpha')
    expect(JSON.stringify(media)).toContain('call_parallel_beta')
    expect(body).toEqual(original)
    expect(responsesToChatRequest(body, 'test')).toEqual(result)
  })

  it('R01 preserves URL images in Claude tool results and their call association', () => {
    const result = anthropicToResponses(
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

  it.each([false, true])(
    'R02 truncation overrides tool-call completion (Messages stream=%s)',
    async (stream) => {
      const response = await post(
        xai('anthropic', async () =>
          Response.json({
            ...responsePayload,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [
              { type: 'function_call', call_id: 'truncated', name: 'get_time', arguments: '{}' }
            ]
          })
        ),
        '/v1/messages',
        { ...textRequest, stream }
      )
      expect(response.status).toBe(200)
      const stopReason = stream
        ? sse(await response.text()).find((event) => event.type === 'message_delta')?.delta
            .stop_reason
        : (await response.json()).stop_reason
      expect(stopReason).toBe('max_tokens')
    }
  )

  it.each(['failed', 'cancelled', 'in_progress', 'unrecognized'])(
    'R02 rejects an explicit %s Responses result',
    async (status) => {
      const response = await post(
        xai('openai', async () => Response.json({ ...responsePayload, status })),
        '/v1/chat/completions',
        textRequest
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toHaveProperty('error')
    }
  )

  it.each([false, true])('R02 normalizes the Chat length reason (stream=%s)', async (stream) => {
    const upstream = async (): Promise<Response> =>
      stream
        ? new Response(
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          )
        : Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })
    const response = await post(
      new ResponsesBridge({ baseUrl: 'https://provider.example/v1', model: 'test' }, upstream),
      '/responses',
      { input: 'continue', stream }
    )
    expect(response.status).toBe(200)
    const payload = stream ? sse(await response.text()).at(-1)?.response : await response.json()
    expect(payload).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ status: 'incomplete' }]
    })
  })

  it.each([undefined, false])('R04 keeps usage opt-in (include_usage=%s)', async (includeUsage) => {
    const response = await post(
      xai('openai', async () => Response.json(responsePayload)),
      '/v1/chat/completions',
      {
        ...textRequest,
        stream: true,
        ...(includeUsage === undefined ? {} : { stream_options: { include_usage: includeUsage } })
      }
    )
    expect(response.status).toBe(200)
    expect(sse(await response.text()).filter((chunk) => chunk.usage)).toEqual([])
  })

  it.each(['null', '[]', '42', '"text"', undefined])(
    'R06 rejects non-object or missing arguments before SSE (%s)',
    async (arguments_) => {
      const response = await post(
        xai('anthropic', async () =>
          Response.json({
            ...responsePayload,
            output: [{ type: 'function_call', call_id: 'bad', name: 'run', arguments: arguments_ }]
          })
        ),
        '/v1/messages',
        { ...textRequest, stream: true }
      )
      expect(response.status).toBe(502)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toHaveProperty('error')
    }
  )

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

describe('provider termination rejection contracts', () => {
  it.each([false, true])(
    'R02 does not turn an unknown Messages stop reason into success (stream=%s)',
    async (stream) => {
      const response = await post(
        chat({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'unexpected' }),
        '/v1/chat/completions',
        { ...textRequest, stream }
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toHaveProperty('error')
    }
  )

  it.each(['anthropic', 'openai'] as const)(
    'R02 retains content filtering for %s',
    async (wire) => {
      const response = await post(
        xai(wire, async () =>
          Response.json({
            ...responsePayload,
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' }
          })
        ),
        wire === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
        textRequest
      )
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(wire === 'anthropic' ? payload.stop_reason : payload.choices[0].finish_reason).toBe(
        wire === 'anthropic' ? 'refusal' : 'content_filter'
      )
    }
  )
})
