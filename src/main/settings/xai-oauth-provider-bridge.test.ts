import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createXaiOAuthProviderBridge,
  type XaiOAuthProviderBridge
} from './xai-oauth-provider-bridge'

const bridges: XaiOAuthProviderBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

const responsesPayload = {
  id: 'resp_1',
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Hello from Grok' }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"science"}' }
  ],
  usage: { input_tokens: 8, output_tokens: 4 }
}

describe('xAI OAuth provider bridge', () => {
  it.each(['disconnect', 'close'])(
    'does not dispatch after %s while another session waits for the shared credential',
    async (action) => {
      let finish!: (token: string) => void
      const credential = new Promise<string>((resolve) => {
        finish = resolve
      })
      const getAccessToken = vi.fn(() => credential)
      const upstream = vi.fn<typeof fetch>(async () => Response.json(responsesPayload))
      const sessions = Array.from({ length: 2 }, () =>
        createXaiOAuthProviderBridge(
          [{ id: 'active', model: 'grok-4.6' }],
          'active',
          'chat-completions',
          getAccessToken,
          upstream
        )
      )
      bridges.push(...sessions)
      const connections = await Promise.all(sessions.map((bridge) => bridge.start()))
      const abort = new AbortController()
      const requests = connections.map((connection, index) =>
        fetch(`${connection.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: `session-${index}` }] }),
          ...(index === 0 ? { signal: abort.signal } : {})
        })
      )
      const cancelled = expect(requests[0]).rejects.toBeDefined()
      await vi.waitFor(() => expect(getAccessToken).toHaveBeenCalledTimes(2))
      if (action === 'disconnect') abort.abort()
      else await sessions[0]!.close()
      await cancelled
      // Closing the first listener settles server-side cancellation before releasing the token.
      await sessions[0]!.close()
      finish('shared-rotated-token')
      const response = await requests[1]!
      expect(response.status).toBe(200)
      await response.text()
      expect(upstream).toHaveBeenCalledOnce()
      expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject({
        input: [{ role: 'user', content: 'session-1' }]
      })
    }
  )

  it('rejects an oversized successful response before reading its body', async () => {
    let cancelBody: ReturnType<typeof vi.spyOn> | undefined
    const upstream = vi.fn<typeof fetch>(async () => {
      const response = Response.json(responsesPayload, {
        headers: { 'content-length': String(64 * 1024 * 1024 + 1) }
      })
      cancelBody = vi.spyOn(response.body!, 'cancel')
      return response
    })
    const bridge = createXaiOAuthProviderBridge(
      [{ id: 'active', model: 'grok-4.6' }],
      'active',
      'chat-completions',
      vi.fn(async () => 'access-token'),
      upstream
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
    })

    expect(response.status).toBe(502)
    expect(cancelBody).toHaveBeenCalledOnce()
  })

  it('serves Anthropic messages, local token counts, streams, and a forced 401 refresh', async () => {
    const getAccessToken = vi
      .fn<(forceRefresh?: boolean) => Promise<string>>()
      .mockResolvedValueOnce('access-old')
      .mockResolvedValueOnce('access-new')
      .mockResolvedValue('access-new')
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: 'expired' } }, { status: 401 }))
      .mockResolvedValue(Response.json(responsesPayload))
    const bridge = createXaiOAuthProviderBridge(
      [{ id: 'active', model: 'grok-4.6' }],
      'active',
      'messages',
      getAccessToken,
      upstream
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    const count = await fetch(`${connection.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Count this input' }] })
    })
    expect(await count.json()).toMatchObject({ input_tokens: expect.any(Number) })
    expect(upstream).not.toHaveBeenCalled()

    const response = await fetch(`${connection.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': connection.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const stream = await response.text()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(stream).toContain('"model":"claude-sonnet-5"')
    expect(stream).toContain('"type":"text_delta","text":"Hello from Grok"')
    expect(stream).toContain('"type":"input_json_delta"')
    expect(getAccessToken).toHaveBeenNthCalledWith(1, false)
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true)
    expect(upstream).toHaveBeenCalledTimes(2)
    const retriedRequest = upstream.mock.calls[1]
    expect(retriedRequest?.[0]).toBe('https://api.x.ai/v1/responses')
    expect(retriedRequest?.[1]?.headers).toMatchObject({ authorization: 'Bearer access-new' })
    expect(JSON.parse(String(retriedRequest?.[1]?.body))).toMatchObject({
      model: 'grok-4.6',
      max_output_tokens: 128,
      stream: false
    })
  })

  it('lists registered Anthropic models so Claude Code can resolve grok-4.6', async () => {
    const bridge = createXaiOAuthProviderBridge(
      [
        { id: 'active', model: 'grok-4.6' },
        { id: 'other', model: 'grok-4.5' }
      ],
      'active',
      'messages',
      vi.fn(async () => 'access-token'),
      vi.fn<typeof fetch>()
    )
    bridges.push(bridge)
    const connection = await bridge.start()
    const headers = { authorization: `Bearer ${connection.token}` }

    const list = await fetch(`${connection.baseUrl}/v1/models`, { headers })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      has_more: false,
      data: expect.arrayContaining([
        { id: 'grok-4.6', type: 'model', display_name: 'grok-4.6' },
        { id: 'grok-4.5', type: 'model', display_name: 'grok-4.5' },
        { id: 'claude-sonnet-5', type: 'model', display_name: 'claude-sonnet-5' },
        { id: 'sonnet', type: 'model', display_name: 'sonnet' }
      ])
    })

    const found = await fetch(`${connection.baseUrl}/v1/models/grok-4.6`, { headers })
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({
      id: 'grok-4.6',
      type: 'model',
      display_name: 'grok-4.6'
    })

    const alias = await fetch(`${connection.baseUrl}/v1/models/claude-sonnet-4-6`, { headers })
    expect(alias.status).toBe(200)
    expect(await alias.json()).toEqual({
      id: 'claude-sonnet-4-6',
      type: 'model',
      display_name: 'claude-sonnet-4-6'
    })

    const future = await fetch(`${connection.baseUrl}/v1/models/claude-sonnet-6`, { headers })
    expect(future.status).toBe(200)
    const learned = await fetch(`${connection.baseUrl}/v1/models`, { headers })
    expect(await learned.json()).toMatchObject({
      data: expect.arrayContaining([
        { id: 'claude-sonnet-6', type: 'model', display_name: 'claude-sonnet-6' }
      ])
    })
  })

  it('serves OpenAI Chat Completions through the same Responses endpoint', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responsesPayload))
    const bridge = createXaiOAuthProviderBridge(
      [{ id: 'active', model: 'grok-4.6' }],
      'active',
      'chat-completions',
      vi.fn(async () => 'access-token'),
      upstream
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-request-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const completion = (await response.json()) as Record<string, unknown>

    expect(completion).toMatchObject({
      object: 'chat.completion',
      model: 'openai-request-model',
      choices: [{ finish_reason: 'tool_calls' }]
    })
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'Hello' }],
      stream: false
    })
  })

  it('adapts CodeBuddy Chat Completions before translating them to Responses', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responsesPayload))
    const adaptChatCompletionsRequest = vi.fn((request: Record<string, unknown>) => ({
      ...request,
      messages: [{ role: 'user', content: 'Adapted input' }]
    }))
    const bridge = createXaiOAuthProviderBridge(
      [{ id: 'active', model: 'grok-4.6' }],
      'active',
      'chat-completions',
      vi.fn(async () => 'access-token'),
      { fetchImpl: upstream, adaptChatCompletionsRequest }
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-request-model',
        messages: [{ role: 'user', content: 'Original input' }]
      })
    })

    expect(adaptChatCompletionsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'Original input' }] })
    )
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'Adapted input' }]
    })
  })
})

it('passes native Responses SSE through before completion, with one refresh on 401', async () => {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const old = Response.json({ error: 'expired' }, { status: 401 })
  const cancelled = vi.spyOn(old.body!, 'cancel')
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(old)
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(value) {
            controller = value
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    )
  const token = vi.fn(async (force?: boolean) => (force ? 'new' : 'old'))
  const bridge = createXaiOAuthProviderBridge(
    [{ id: 'active', model: 'grok' }],
    'active',
    'responses',
    token,
    upstream
  )
  bridges.push(bridge)
  const connection = await bridge.start()
  const pending = fetch(`${connection.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'override', input: [], stream: true })
  })
  controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'))
  const response = await pending
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('response.created')
  expect(cancelled).toHaveBeenCalledOnce()
  expect(token.mock.calls).toEqual([[false], [true]])
  expect(JSON.parse(String(upstream.mock.calls[1][1]?.body))).toEqual({
    model: 'grok',
    input: [],
    stream: true
  })
  expect(new Headers(upstream.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer new')
  controller.close()
  expect((await reader.read()).done).toBe(true)
})
