import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProtocolForwardingBridge,
  type ProtocolForwardingBridgeTarget
} from './protocol-forwarding-bridge'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

const startUpstream = async (
  handler: Parameters<typeof createServer>[1]
): Promise<{ url: string; server: Server }> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { url: `http://127.0.0.1:${address.port}`, server }
}

describe('Lab provider bridge routing', () => {
  it('streams the gateway SSE body through the app loopback with a per-request bearer', async () => {
    let authorization: string | undefined
    const { url } = await startUpstream((request, response) => {
      authorization = request.headers.authorization
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')
      setTimeout(() => response.end('data: [DONE]\n\n'), 5)
    })

    const target: ProtocolForwardingBridgeTarget = {
      id: 'lab-target',
      wire: 'chat-completions',
      endpoint: `${url}/v1/chat/completions`,
      model: 'research-default',
      resolveConnection: async () => ({ endpoint: `${url}/v1/chat/completions`, key: 'at_live' })
    }
    const bridge = new ProtocolForwardingBridge([target], 'lab-target')
    const connection = await bridge.start()
    try {
      const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'research-default', stream: true, messages: [] })
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"hel"')
      expect(text).toContain('[DONE]')
      expect(authorization).toBe('Bearer at_live')
    } finally {
      await bridge.close()
    }
  })

  it('cancels the upstream request when the caller aborts the stream', async () => {
    let upstreamClosed: (() => void) | undefined
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve
    })
    const { url } = await startUpstream((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      request.on('close', () => upstreamClosed?.())
    })

    const bridge = new ProtocolForwardingBridge(
      [
        {
          id: 'lab-target',
          wire: 'chat-completions',
          endpoint: `${url}/v1/chat/completions`,
          model: 'research-default',
          resolveConnection: async () => ({
            endpoint: `${url}/v1/chat/completions`,
            key: 'at_live'
          })
        }
      ],
      'lab-target'
    )
    const connection = await bridge.start()
    try {
      const controller = new AbortController()
      const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'research-default', stream: true, messages: [] }),
        signal: controller.signal
      })
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('partial')
      controller.abort()
      await expect(reader.read()).rejects.toBeDefined()
      await expect(
        Promise.race([
          closed,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('upstream not closed')), 1000)
          )
        ])
      ).resolves.toBeUndefined()
    } finally {
      await bridge.close()
    }
  })

  it('refreshes the host-owned token once on a 401 and retries the same request', async () => {
    let calls = 0
    const { url } = await startUpstream((request, response) => {
      calls += 1
      request.resume()
      if (calls === 1) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }))
        return
      }
      expect(request.headers.authorization).toBe('Bearer at_fresh')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })

    const resolveConnection = vi.fn(async (_signal: AbortSignal, forceRefresh?: boolean) => ({
      endpoint: `${url}/v1/chat/completions`,
      key: forceRefresh ? 'at_fresh' : 'at_stale'
    }))
    const bridge = new ProtocolForwardingBridge(
      [
        {
          id: 'lab-target',
          wire: 'chat-completions',
          endpoint: `${url}/v1/chat/completions`,
          model: 'research-default',
          resolveConnection,
          refreshOnUnauthorized: true,
          mapUpstreamError: (status) => ({
            code: status === 401 ? 'unauthorized' : 'server-error',
            message: 'Lab request failed.'
          })
        }
      ],
      'lab-target'
    )
    const connection = await bridge.start()
    try {
      const response = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'research-default', messages: [] })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(resolveConnection).toHaveBeenLastCalledWith(expect.any(AbortSignal), true)
      expect(calls).toBe(2)
    } finally {
      await bridge.close()
    }
  })
})
