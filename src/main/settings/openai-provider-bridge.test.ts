import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adaptCodeBuddyChatCompletionsRequest } from './codebuddy-chat-request-adapter'
import { OpenAiProviderBridge, type OpenAiProviderBridgeTarget } from './openai-provider-bridge'
import { OPENCODE_TOOL_IMAGE_REQUEST_FIXTURE } from './provider-tool-image-wire.test-fixtures'

type CapturedRequest = {
  authorization?: string
  body: Record<string, unknown>
  path?: string
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const close = async (server: Server): Promise<void> => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

const createUpstream = (): { requests: CapturedRequest[]; server: Server } => {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({
        authorization: request.headers.authorization,
        body,
        path: request.url
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: body.model }))
    })
  })
  return { requests, server }
}

describe('OpenAiProviderBridge', () => {
  const servers: Server[] = []
  const bridges: OpenAiProviderBridge[] = []

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
    await Promise.all(servers.splice(0).map(close))
  })

  it('retargets endpoint, credential, and model without replacing the loopback connection', async () => {
    const first = createUpstream()
    const second = createUpstream()
    servers.push(first.server, second.server)
    const targets: OpenAiProviderBridgeTarget[] = [
      {
        id: 'provider-a/model-a',
        wire: 'chat-completions',
        endpoint: `${await listen(first.server)}/v1/chat/completions`,
        key: 'key-a',
        model: 'model-a'
      },
      {
        id: 'provider-b/model-b',
        wire: 'chat-completions',
        endpoint: `${await listen(second.server)}/custom/chat/completions`,
        key: 'key-b',
        model: 'model-b'
      }
    ]
    const bridge = new OpenAiProviderBridge(targets, targets[0].id)
    bridges.push(bridge)
    const connection = await bridge.start()

    const send = (model: string): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/chat/completions?ignored=1`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model, messages: [] })
      })

    await expect((await send('untrusted-model')).json()).resolves.toEqual({ model: 'model-a' })
    expect(bridge.setTarget(targets[1].id)).toBe(true)
    await expect((await send('still-untrusted')).json()).resolves.toEqual({ model: 'model-b' })

    expect(first.requests).toEqual([
      {
        authorization: 'Bearer key-a',
        body: { model: 'model-a', messages: [] },
        path: '/v1/chat/completions'
      }
    ])
    expect(second.requests).toEqual([
      {
        authorization: 'Bearer key-b',
        body: { model: 'model-b', messages: [] },
        path: '/custom/chat/completions'
      }
    ])
  })

  it('forwards the Responses wire and fails closed for other paths and unknown targets', async () => {
    const upstream = createUpstream()
    servers.push(upstream.server)
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: `${await listen(upstream.server)}/v1/responses`,
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id)
    bridges.push(bridge)
    const connection = await bridge.start()

    expect(bridge.setTarget('missing/model')).toBe(false)
    const wrongPath = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'ignored', input: [] })
    })
    const response = await fetch(`${connection.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'x-api-key': connection.token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'ignored', input: [] })
    })

    expect(wrongPath.status).toBe(404)
    expect(response.status).toBe(200)
    expect(upstream.requests).toEqual([
      {
        authorization: 'Bearer key-a',
        body: { model: 'model-a', input: [] },
        path: '/v1/responses'
      }
    ])
  })

  it('filters Fetch Metadata headers before invoking the upstream fetch', async () => {
    let upstreamHeaders: Headers | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      })
    }
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: 'https://provider.example.test/v1/responses',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-request-id': 'request-1'
      },
      body: JSON.stringify({ model: 'ignored', input: [] })
    })

    expect(response.status).toBe(200)
    expect(upstreamHeaders?.get('sec-fetch-site')).toBeNull()
    expect(upstreamHeaders?.get('x-request-id')).toBe('request-1')
  })

  it('replays an identical deterministic provider error without a second upstream request', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Incorrect API key provided' } },
        { status: 401 }
      )
    )
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: 'https://provider.example.test/v1/responses',
      key: 'wrong-key',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello' })
      })

    const first = await send()
    const second = await send()

    expect(first.status).toBe(400)
    expect(second.status).toBe(400)
    expect(second.headers.get('x-open-science-upstream-status')).toBe('401')
    await expect(second.json()).resolves.toMatchObject({
      error: { type: 'authentication_error', message: 'Incorrect API key provided' }
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('labels a bounded fallback error as JSON on the first response and replay', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('oversized', {
          status: 401,
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(256 * 1024 + 1),
            'content-type': 'text/event-stream'
          }
        })
    )
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: 'https://provider.example.test/v1/responses',
      key: 'wrong-key',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello' })
      })

    for (const response of [await send(), await send()]) {
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.get('content-encoding')).toBeNull()
      await expect(response.json()).resolves.toMatchObject({
        error: { message: 'Provider request failed with status 401' }
      })
    }
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not replay an error after an upstream-visible request header changes', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      return headers.get('x-provider-feature') === 'invalid'
        ? Response.json({ error: { message: 'Invalid feature' } }, { status: 400 })
        : Response.json({ output: [], model: 'model-a' })
    })
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: 'https://provider.example.test/v1/responses',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (feature?: string): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          ...(feature ? { 'x-provider-feature': feature } : {})
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello' })
      })

    expect((await send('invalid')).status).toBe(400)
    expect((await send()).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps retryable 429 responses out of the deterministic replay cache', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { message: 'Rate limited' } }, { status: 429 })
    )
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'responses',
      endpoint: 'https://provider.example.test/v1/responses',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello' })
      })

    expect((await send()).status).toBe(429)
    expect((await send()).status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('preserves the captured OpenCode MCP image fixture at the final Chat boundary', async () => {
    const upstream = createUpstream()
    servers.push(upstream.server)
    const target: OpenAiProviderBridgeTarget = {
      id: 'provider/model-a',
      wire: 'chat-completions',
      endpoint: `${await listen(upstream.server)}/v1/chat/completions`,
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new OpenAiProviderBridge([target], target.id)
    bridges.push(bridge)
    const connection = await bridge.start()
    await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...OPENCODE_TOOL_IMAGE_REQUEST_FIXTURE,
        model: 'untrusted'
      })
    })

    expect(upstream.requests[0].body).toMatchObject({
      model: 'model-a',
      messages: OPENCODE_TOOL_IMAGE_REQUEST_FIXTURE.messages
    })
  })

  it('applies a target-scoped CodeBuddy request adapter before forwarding', async () => {
    const upstream = createUpstream()
    servers.push(upstream.server)
    const target: OpenAiProviderBridgeTarget = {
      id: 'codebuddy/provider/model-a',
      wire: 'chat-completions',
      endpoint: `${await listen(upstream.server)}/v1/chat/completions`,
      key: 'key-a',
      model: 'model-a',
      adaptRequest: adaptCodeBuddyChatCompletionsRequest
    }
    const bridge = new OpenAiProviderBridge([target], target.id)
    bridges.push(bridge)
    const connection = await bridge.start()
    await fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'untrusted',
        messages: [
          {
            role: 'user',
            content:
              'Earlier image.\n<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png</image_local_path>'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png</image_local_path>'
              },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
            ]
          }
        ]
      })
    })

    expect(upstream.requests[0].body).toEqual({
      model: 'model-a',
      messages: [
        { role: 'user', content: 'Earlier image.' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }]
        }
      ]
    })
  })
})
