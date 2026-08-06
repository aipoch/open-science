import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { OpenAiProviderBridge, type OpenAiProviderBridgeTarget } from './openai-provider-bridge'

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
})
