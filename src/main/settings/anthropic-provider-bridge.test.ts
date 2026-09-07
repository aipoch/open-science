import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AnthropicProviderBridge,
  type AnthropicProviderBridgeTarget
} from './anthropic-provider-bridge'
import {
  CLAUDE_CODE_TOOL_IMAGE_REQUEST_FIXTURE,
  OPENCODE_ANTHROPIC_TOOL_IMAGE_REQUEST_FIXTURE
} from './provider-tool-image-wire.test-fixtures'

type CapturedRequest = {
  authorization?: string
  apiKey?: string
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

const createUpstream = (): {
  requests: CapturedRequest[]
  server: Server
} => {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({
        authorization: request.headers.authorization,
        ...(typeof request.headers['x-api-key'] === 'string'
          ? { apiKey: request.headers['x-api-key'] }
          : {}),
        body,
        path: request.url
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: body.model }))
    })
  })
  return { requests, server }
}

describe('AnthropicProviderBridge', () => {
  const servers: Server[] = []
  const bridges: AnthropicProviderBridge[] = []

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
    await Promise.all(servers.splice(0).map(close))
  })

  it('retargets endpoint, credential, and model without replacing the loopback connection', async () => {
    const first = createUpstream()
    const second = createUpstream()
    servers.push(first.server, second.server)
    const firstBaseUrl = await listen(first.server)
    const secondBaseUrl = await listen(second.server)
    const targets: AnthropicProviderBridgeTarget[] = [
      {
        id: 'deepseek/model-a',
        baseUrl: firstBaseUrl,
        key: 'key-a',
        model: 'model-a',
        backgroundModel: 'model-a-mini'
      },
      { id: 'kimi/model-b', baseUrl: secondBaseUrl, key: 'key-b', model: 'model-b' }
    ]
    const bridge = new AnthropicProviderBridge(targets, targets[0].id)
    bridges.push(bridge)
    const connection = await bridge.start()

    const send = (model?: unknown): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/messages?beta=1`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ ...(model === undefined ? {} : { model }), messages: [] })
      })

    await expect((await send('untrusted-model')).json()).resolves.toEqual({ model: 'model-a' })
    await expect((await send('model-a-mini')).json()).resolves.toEqual({ model: 'model-a-mini' })
    expect(bridge.setTarget(targets[1].id)).toBe(true)
    await expect((await send('still-untrusted')).json()).resolves.toEqual({ model: 'model-b' })
    await expect((await send()).json()).resolves.toEqual({ model: 'model-b' })
    await expect((await send(42)).json()).resolves.toEqual({ model: 'model-b' })
    await expect(
      (
        await fetch(`${connection.baseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: {
            'x-api-key': connection.token,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model: 'ignored-count-model', messages: [] })
        })
      ).json()
    ).resolves.toEqual({ model: 'model-b' })

    expect(first.requests).toEqual([
      {
        authorization: 'Bearer key-a',
        body: { model: 'model-a', messages: [] },
        path: '/v1/messages?beta=1'
      },
      {
        authorization: 'Bearer key-a',
        body: { model: 'model-a-mini', messages: [] },
        path: '/v1/messages?beta=1'
      }
    ])
    expect(second.requests).toEqual([
      {
        authorization: 'Bearer key-b',
        body: { model: 'model-b', messages: [] },
        path: '/v1/messages?beta=1'
      },
      {
        authorization: 'Bearer key-b',
        body: { model: 'model-b', messages: [] },
        path: '/v1/messages?beta=1'
      },
      {
        authorization: 'Bearer key-b',
        body: { model: 'model-b', messages: [] },
        path: '/v1/messages?beta=1'
      },
      {
        authorization: 'Bearer key-b',
        body: { model: 'model-b', messages: [] },
        path: '/v1/messages/count_tokens'
      }
    ])
  })

  it('fails closed for unknown targets and unauthenticated callers', async () => {
    const upstream = createUpstream()
    servers.push(upstream.server)
    const target = {
      id: 'provider/model-a',
      baseUrl: await listen(upstream.server),
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id)
    bridges.push(bridge)
    const connection = await bridge.start()

    expect(bridge.setTarget('missing/model')).toBe(false)
    const response = await fetch(`${connection.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', messages: [] })
    })

    expect(response.status).toBe(401)
    expect(upstream.requests).toEqual([])
  })

  it('uses x-api-key for an upstream target that requires Anthropic API-key authentication', async () => {
    const upstream = createUpstream()
    servers.push(upstream.server)
    const target: AnthropicProviderBridgeTarget = {
      id: 'tencent/hy4-preview',
      baseUrl: await listen(upstream.server),
      key: 'tokenhub-key',
      model: 'hy4-preview',
      useApiKeyHeader: true
    }
    const bridge = new AnthropicProviderBridge([target], target.id)
    bridges.push(bridge)
    const connection = await bridge.start()

    await fetch(`${connection.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'ignored', messages: [] })
    })

    expect(upstream.requests).toEqual([
      {
        authorization: undefined,
        apiKey: 'tokenhub-key',
        body: { model: 'hy4-preview', messages: [] },
        path: '/v1/messages'
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
    const target = {
      id: 'provider/model-a',
      baseUrl: 'https://provider.example.test',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-request-id': 'request-1'
      },
      body: JSON.stringify({ model: 'ignored', messages: [] })
    })

    expect(response.status).toBe(200)
    expect(upstreamHeaders?.get('sec-fetch-site')).toBeNull()
    expect(upstreamHeaders?.get('x-request-id')).toBe('request-1')
  })

  it('logs a redacted upstream connection failure after the loopback request arrives', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 203.0.113.1:443'), {
      code: 'ECONNREFUSED'
    })
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause })
    }) as typeof fetch
    const diagnostics = { info: vi.fn(), error: vi.fn() }
    const target = {
      id: 'provider/model-a',
      baseUrl: 'https://user:provider-secret@provider.example.test/gateway?api_key=query-secret',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id, fetchImpl, diagnostics)
    bridges.push(bridge)
    const connection = await bridge.start()

    const response = await fetch(`${connection.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'ignored', messages: [] })
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: { type: 'api_error', message: 'fetch failed' }
    })
    expect(diagnostics.error).toHaveBeenCalledWith(
      'anthropic provider request failed',
      expect.objectContaining({
        targetId: target.id,
        upstreamOrigin: 'https://provider.example.test',
        error: 'fetch failed',
        cause: expect.objectContaining({ code: 'ECONNREFUSED' })
      })
    )
    expect(JSON.stringify(diagnostics.error.mock.calls)).not.toContain('provider-secret')
    expect(JSON.stringify(diagnostics.error.mock.calls)).not.toContain('query-secret')
    expect(JSON.stringify(diagnostics.error.mock.calls)).not.toContain('key-a')
  })

  it('replays an identical deterministic provider error without a second upstream request', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Incorrect API key provided' } },
        { status: 401 }
      )
    )
    const target = {
      id: 'provider/model-a',
      baseUrl: 'https://provider.example.test',
      key: 'wrong-key',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', messages: [{ role: 'user', content: 'hello' }] })
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
    const target = {
      id: 'provider/model-a',
      baseUrl: 'https://provider.example.test',
      key: 'wrong-key',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', messages: [] })
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
      return headers.get('anthropic-beta') === 'invalid-beta'
        ? Response.json({ error: { message: 'Invalid beta' } }, { status: 400 })
        : Response.json({ content: [], model: 'model-a' })
    })
    const target = {
      id: 'provider/model-a',
      baseUrl: 'https://provider.example.test',
      key: 'key-a',
      model: 'model-a'
    }
    const bridge = new AnthropicProviderBridge([target], target.id, fetchImpl)
    bridges.push(bridge)
    const connection = await bridge.start()
    const send = (beta?: string): Promise<Response> =>
      fetch(`${connection.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          ...(beta ? { 'anthropic-beta': beta } : {})
        },
        body: JSON.stringify({ model: 'ignored', messages: [] })
      })

    expect((await send('invalid-beta')).status).toBe(400)
    expect((await send()).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['Claude Code', CLAUDE_CODE_TOOL_IMAGE_REQUEST_FIXTURE],
    ['OpenCode', OPENCODE_ANTHROPIC_TOOL_IMAGE_REQUEST_FIXTURE]
  ] as const)(
    'preserves the captured %s MCP image fixture at the final Anthropic boundary',
    async (_framework, fixture) => {
      const upstream = createUpstream()
      servers.push(upstream.server)
      const target = {
        id: 'provider/model-a',
        baseUrl: await listen(upstream.server),
        key: 'key-a',
        model: 'model-a'
      }
      const bridge = new AnthropicProviderBridge([target], target.id)
      bridges.push(bridge)
      const connection = await bridge.start()
      await fetch(`${connection.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          ...fixture,
          model: 'untrusted'
        })
      })

      expect(upstream.requests[0].body).toMatchObject({
        model: 'model-a',
        messages: fixture.messages
      })
    }
  )
})
