import { describe, expect, it, vi } from 'vitest'

import {
  buildValidationRequest,
  classifyFetchError,
  classifyStatus,
  extractProviderErrorMessage,
  hasBridgeProbeToolCall,
  validateProvider
} from './validate'

const toolCallSse = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open_science_bridge_probe","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
  ''
].join('\n\n')

const chatSseResponse = (body: string = toolCallSse): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

describe('validate: request construction', () => {
  it('builds a bearer /v1/messages probe with anthropic-version and a 1-token body', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      key: 'test-token'
    })

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(request.body)).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 1 })
  })

  it('normalizes a base URL that already carries /v1 so the probe never doubles it', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://api.anthropic.com/v1',
      key: 'test-token'
    })

    expect(request.headers.authorization).toBe('Bearer test-token')
    // Custom providers never send an x-api-key header.
    expect(request.headers['x-api-key']).toBeUndefined()
    // A user-supplied trailing /v1 (and/or slash) must resolve to a single /v1/messages, not two.
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('throws for a missing or unparseable base URL', () => {
    expect(() => buildValidationRequest({ type: 'custom' })).toThrow(/missing base url/i)
    expect(() => buildValidationRequest({ type: 'custom', baseUrl: 'not a url' })).toThrow(
      /invalid base url/i
    )
  })

  it('builds a basic non-streaming probe for an OpenAI provider outside Codex', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://gateway.example.com',
      model: 'gpt-x',
      key: 'test-token',
      apiEndpoints: ['openai']
    })

    expect(JSON.parse(request.body)).toEqual({
      model: 'gpt-x',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false
    })
    expect(request.requiresBridgeToolCall).toBeUndefined()
  })

  it('builds the streaming function-tool probe required by the Codex bridge', () => {
    const request = buildValidationRequest(
      {
        type: 'custom',
        baseUrl: 'https://gateway.example.com',
        model: 'gpt-x',
        key: 'test-token',
        apiEndpoints: ['openai']
      },
      true
    )

    expect(request.url).toBe('https://gateway.example.com/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['anthropic-version']).toBeUndefined()
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'gpt-x',
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: { name: 'open_science_bridge_probe' }
        }
      ],
      tool_choice: 'auto'
    })
  })

  it('uses the OpenAI endpoint for a both-capable provider and never doubles /v1', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'm',
      key: 'k',
      apiEndpoints: ['anthropic', 'openai']
    })

    // preferredEndpoint(both) → openai, so the probe hits chat/completions once.
    expect(request.url).toBe('https://gateway.example.com/v1/chat/completions')
  })

  it('targets the route the active framework drives when frameworkEndpoints is given', () => {
    const provider = {
      type: 'custom' as const,
      baseUrl: 'https://gateway.example.com/v1',
      model: 'm',
      key: 'k',
      apiEndpoints: ['anthropic', 'openai'] as const
    }

    // A framework that only speaks Anthropic must probe /v1/messages, even though the provider also
    // offers OpenAI (which the framework-agnostic preference would otherwise pick).
    expect(buildValidationRequest(provider, false, ['anthropic']).url).toBe(
      'https://gateway.example.com/v1/messages'
    )
    // A framework that speaks OpenAI probes chat/completions for the same provider.
    expect(buildValidationRequest(provider, false, ['anthropic', 'openai']).url).toBe(
      'https://gateway.example.com/v1/chat/completions'
    )
  })

  it('builds a minimal /v1/responses probe without treating it as chat completions', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://api.openai.com/v1/responses',
      model: 'gpt-5-codex',
      key: 'test-token',
      apiEndpoints: ['responses']
    })

    expect(request.url).toBe('https://api.openai.com/v1/responses')
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['anthropic-version']).toBeUndefined()
    expect(JSON.parse(request.body)).toEqual({
      model: 'gpt-5-codex',
      input: 'ping',
      max_output_tokens: 16
    })
  })

  it('appends /responses to a versioned OpenAI base instead of forcing /v1', () => {
    // Volcengine Ark versions its OpenAI-compatible root as /api/v3, so its Responses endpoint is
    // /api/v3/responses — not the /v1/responses a /v1-only normalization would produce.
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
      openaiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-pro-260628',
      key: 'test-token',
      apiEndpoints: ['anthropic', 'openai', 'responses']
    })

    expect(request.url).toBe('https://ark.cn-beijing.volces.com/api/v3/responses')
  })
})

describe('validate: classification', () => {
  it('maps status codes to categories', () => {
    expect(classifyStatus(200)).toBe('ok')
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
    expect(classifyStatus(404)).toBe('model-not-found')
    expect(classifyStatus(400)).toBe('unknown')
    expect(classifyStatus(500)).toBe('unknown')
  })

  it('maps thrown errors to categories', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'

    expect(classifyFetchError(abort)).toBe('timeout')
    expect(classifyFetchError(new Error('Invalid base URL.'))).toBe('bad-url')
    expect(classifyFetchError(new Error('fetch failed'))).toBe('network')
  })
})

describe('validate: bridge contract', () => {
  it('accepts a complete streaming function tool call with fragmented fields', () => {
    expect(
      hasBridgeProbeToolCall(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"open_science_","arguments":"{"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"bridge_probe","arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
          ''
        ].join('\n')
      )
    ).toBe(true)
    expect(
      hasBridgeProbeToolCall(
        '{"choices":[{"message":{"tool_calls":[{"id":"call_1","function":{"name":"open_science_bridge_probe","arguments":"{}"}}]}}]}'
      )
    ).toBe(false)
    expect(hasBridgeProbeToolCall('data: not-json\n\n')).toBe(false)
  })
})

describe('validate: error-body extraction', () => {
  it('reads a nested error.message (Anthropic/OpenAI/DeepSeek shape)', () => {
    expect(extractProviderErrorMessage('{"error":{"message":"Insufficient Balance"}}')).toBe(
      'Insufficient Balance'
    )
  })

  it('reads a bare string error or top-level message', () => {
    expect(extractProviderErrorMessage('{"error":"rate limited"}')).toBe('rate limited')
    expect(extractProviderErrorMessage('{"message":"model not deployed"}')).toBe(
      'model not deployed'
    )
  })

  it('falls back to the raw body for non-JSON, collapsing whitespace', () => {
    expect(extractProviderErrorMessage('  Bad\n Gateway  ')).toBe('Bad Gateway')
  })

  it('suppresses an HTML/markup error page (5xx gateway page)', () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>'

    expect(extractProviderErrorMessage(html)).toBeUndefined()
  })

  it('returns undefined for an empty or messageless body', () => {
    expect(extractProviderErrorMessage('')).toBeUndefined()
    expect(extractProviderErrorMessage('   ')).toBeUndefined()
    expect(extractProviderErrorMessage('{"foo":"bar"}')).toBeUndefined()
  })

  it('truncates an overlong message', () => {
    const message = extractProviderErrorMessage(
      JSON.stringify({ error: { message: 'x'.repeat(500) } })
    )

    expect(message).toHaveLength(301)
    expect(message?.endsWith('…')).toBe(true)
  })
})

describe('validate: provider dispatch', () => {
  it('returns ok for a 200 custom response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 } as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: true, category: 'ok', status: 200 })
  })

  it('requires an actual function call from a Chat Completions bridge provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatSseResponse())

    const result = await validateProvider(
      { type: 'custom', apiEndpoints: ['openai'], baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, requireBridgeToolCall: true }
    )

    expect(result).toMatchObject({ ok: true, category: 'ok', status: 200 })
  })

  it('uses the production Responses-to-Chat conversion for the bridge probe', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatSseResponse())

    await validateProvider(
      { type: 'custom', apiEndpoints: ['openai'], baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, requireBridgeToolCall: true }
    )

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'm',
      max_tokens: 512,
      messages: [
        { role: 'user', content: 'Call the validation tool now. Do not answer with text.' }
      ],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: { name: 'open_science_bridge_probe' }
        }
      ]
    })
  })

  it('probes a GLM dual-endpoint provider at its verbatim OpenAI base, not a hard-coded /v1', async () => {
    // apiEndpoints ['anthropic','openai'] → OpenAI wins; the OpenAI base is the vendor's exact
    // openaiBaseUrl (GLM's /api/paas/v4), so the probe must hit /api/paas/v4/chat/completions.
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 } as Response)

    await validateProvider(
      {
        type: 'custom',
        apiEndpoints: ['anthropic', 'openai'],
        baseUrl: 'https://api.z.ai/api/anthropic',
        openaiBaseUrl: 'https://api.z.ai/api/paas/v4',
        model: 'glm-5.2',
        key: 'k'
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.z.ai/api/paas/v4/chat/completions')
  })

  it('probes a custom OpenAI root at <root>/v1/chat/completions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 } as Response)

    await validateProvider(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        baseUrl: 'https://host/proxy',
        model: 'm',
        key: 'k'
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://host/proxy/v1/chat/completions')
  })

  it('surfaces a non-model 400 instead of misreporting model-not-found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"message":"tool_choice is not supported"}}', { status: 400 })
      )

    const result = await validateProvider(
      { type: 'custom', apiEndpoints: ['openai'], baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, requireBridgeToolCall: true }
    )

    expect(result).toMatchObject({
      ok: false,
      category: 'unknown',
      status: 400,
      message: 'tool_choice is not supported'
    })
  })

  it('keeps a model-specific 400 classified as model-not-found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"message":"Model m was not found"}}', { status: 400 })
      )

    const result = await validateProvider(
      { type: 'custom', apiEndpoints: ['openai'], baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, requireBridgeToolCall: true }
    )

    expect(result).toMatchObject({ ok: false, category: 'model-not-found', status: 400 })
  })

  it('keeps a text-only Chat Completions provider unverified', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        chatSseResponse(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        )
      )

    const result = await validateProvider(
      { type: 'custom', apiEndpoints: ['openai'], baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, requireBridgeToolCall: true }
    )

    expect(result).toMatchObject({
      ok: false,
      category: 'unknown',
      message: expect.stringContaining('required streaming function tool call')
    })
  })

  it('keeps the friendly auth guidance and does not surface a raw 401 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 401,
      // Even when the gateway returns a body, an auth failure keeps its targeted advice, so the raw
      // text is deliberately ignored here.
      text: () => Promise.resolve('{"error":{"message":"invalid api key"}}')
    } as unknown as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: false, category: 'auth', status: 401 })
    expect(result.message).toBeUndefined()
  })

  it('surfaces the gateway error body on a billing 402 (DeepSeek insufficient balance)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 402,
      text: () =>
        Promise.resolve('{"error":{"message":"Insufficient Balance","type":"unknown_error"}}')
    } as unknown as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://api.deepseek.com', key: 'k', model: 'deepseek-chat' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({
      ok: false,
      category: 'unknown',
      status: 402,
      message: 'Insufficient Balance'
    })
  })

  it('surfaces a JSON 5xx error message (e.g. an overloaded upstream)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 503,
      text: () => Promise.resolve('{"error":{"message":"Service temporarily unavailable"}}')
    } as unknown as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({
      ok: false,
      category: 'unknown',
      status: 503,
      message: 'Service temporarily unavailable'
    })
  })

  it('tolerates an unreadable error body without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      text: () => Promise.reject(new Error('stream closed'))
    } as unknown as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: false, category: 'unknown', status: 500 })
    expect(result.message).toBeUndefined()
  })

  it('classifies a thrown fetch as network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.category).toBe('network')
  })

  it('reports bad-url before any fetch is attempted', async () => {
    const fetchImpl = vi.fn()

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'nonsense' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.category).toBe('bad-url')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runs the claude probe for claude-default providers', async () => {
    const okResult = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: true }) }
    )
    const failResult = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: false }) }
    )

    expect(okResult).toMatchObject({ ok: true, category: 'ok' })
    expect(failResult).toMatchObject({ ok: false, category: 'auth' })
  })

  it('classifies a claude-default probe timeout as timeout, not auth', async () => {
    const result = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: false, timedOut: true }) }
    )

    expect(result).toMatchObject({ ok: false, category: 'timeout' })
  })
})
