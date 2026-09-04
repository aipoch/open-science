import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { listProviderModels } from './list-models'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { ResponsesBridge } from './responses-bridge'
import { validateProvider } from './validate'

type CapturedRequest = Readonly<{
  authorization?: string
  apiKey?: string
  path?: string
}>

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

const capture = (request: IncomingMessage): CapturedRequest => ({
  authorization: request.headers.authorization,
  apiKey:
    typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
  path: request.url
})

describe('authenticated provider redirect policy', () => {
  it('does not follow a same-origin redirect during provider validation', async () => {
    const redirected: CapturedRequest[] = []
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === '/v1/messages') {
        response.writeHead(307, { location: '/redirected-validation' })
        response.end()
        return
      }
      redirected.push(capture(request))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })

    const baseUrl = await listen(server)
    try {
      const result = await validateProvider({
        type: 'custom',
        baseUrl,
        model: 'model-a',
        key: 'validation-secret'
      })

      expect(redirected).toEqual([])
      expect(result).toMatchObject({ ok: false, status: 307 })
    } finally {
      await close(server)
    }
  })

  it('does not propagate model-list credentials across origins', async () => {
    const redirected: CapturedRequest[] = []
    const sink = createServer((request, response) => {
      request.resume()
      redirected.push(capture(request))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'redirected-model' }] }))
    })
    const sinkUrl = await listen(sink)
    const source = createServer((request, response) => {
      request.resume()
      response.writeHead(307, { location: `${sinkUrl}/redirected-models` })
      response.end()
    })
    const sourceUrl = await listen(source)

    try {
      const result = await listProviderModels({
        url: `${sourceUrl}/v1/models`,
        key: 'model-list-secret'
      })

      expect(redirected).toEqual([])
      expect(result).toMatchObject({ ok: false, status: 307 })
    } finally {
      await Promise.all([close(source), close(sink)])
    }
  })

  it('does not follow a same-origin redirect in the Responses bridge', async () => {
    const redirected: CapturedRequest[] = []
    const upstream = createServer((request, response) => {
      request.resume()
      if (request.url === '/v1/chat/completions') {
        response.writeHead(307, { location: '/redirected-chat-completions' })
        response.end()
        return
      }
      redirected.push(capture(request))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    })
    const upstreamUrl = await listen(upstream)
    const bridge = new ResponsesBridge({
      baseUrl: `${upstreamUrl}/v1`,
      key: 'responses-bridge-secret',
      model: 'model-a'
    })
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'hello', stream: false }),
        redirect: 'manual'
      })

      expect(redirected).toEqual([])
      expect(response.status).toBe(307)
    } finally {
      await bridge.close()
      await close(upstream)
    }
  })

  it('does not follow a same-origin redirect in native Responses compatibility', async () => {
    const redirected: CapturedRequest[] = []
    const upstream = createServer((request, response) => {
      request.resume()
      if (request.url === '/v1/responses') {
        response.writeHead(307, { location: '/redirected-responses' })
        response.end()
        return
      }
      redirected.push(capture(request))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'response-a',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })
    const upstreamUrl = await listen(upstream)
    const proxy = new NativeResponsesCompatibilityProxy({
      baseUrl: `${upstreamUrl}/v1`,
      key: 'native-responses-secret',
      model: 'model-a'
    })
    const connection = await proxy.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'model-a', input: 'hello', stream: false }),
        redirect: 'manual'
      })

      expect(redirected).toEqual([])
      expect(response.status).toBe(307)
    } finally {
      await proxy.close()
      await close(upstream)
    }
  })
})
