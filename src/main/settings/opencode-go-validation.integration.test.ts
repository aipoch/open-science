import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatApiEndpoint } from '../../shared/settings'
import { validateProvider, type ValidateProviderDeps } from './validate'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type GatewayRequest = { session?: string; userAgent?: string; path?: string; auth?: string }

const startGoGateway = async (): Promise<{ baseUrl: string; requests: GatewayRequest[] }> => {
  const requests: GatewayRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const session = request.headers['x-opencode-session'] as string | undefined
      requests.push({
        session,
        userAgent: request.headers['user-agent'],
        path: request.url,
        auth: request.headers.authorization
      })
      response.setHeader('content-type', 'application/json')
      if (!session) {
        response.writeHead(400)
        response.end(
          JSON.stringify({
            error: {
              message:
                'Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently.'
            }
          })
        )
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream')
        if (request.url?.endsWith('/responses')) {
          response.end(
            'data: ' +
              JSON.stringify({
                type: 'response.completed',
                response: {
                  id: 'resp_probe',
                  output: [
                    {
                      type: 'function_call',
                      id: 'fc_probe',
                      call_id: 'call_probe',
                      name: 'open_science__bridge_probe',
                      arguments: '{}'
                    }
                  ]
                }
              }) +
              '\n\n'
          )
        } else {
          response.end(
            'data: ' +
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_probe',
                          function: { name: 'open_science_bridge_probe', arguments: '{}' }
                        }
                      ]
                    },
                    finish_reason: 'tool_calls'
                  }
                ]
              }) +
              '\n\ndata: [DONE]\n\n'
          )
        }
      } else if (request.url?.endsWith('/messages')) {
        response.end(
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        )
      } else {
        response.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/zen/go/v1`,
    requests
  }
}

describe('OpenCode Go validation wire contract', () => {
  it.each<{ name: string; endpoint: ChatApiEndpoint; path: string; deps?: ValidateProviderDeps }>([
    { name: 'Chat Completions', endpoint: 'openai', path: '/chat/completions' },
    { name: 'Messages', endpoint: 'anthropic', path: '/messages' },
    { name: 'Responses', endpoint: 'responses', path: '/responses' },
    {
      name: 'Codex Chat Completions bridge',
      endpoint: 'openai',
      path: '/chat/completions',
      deps: { requireBridgeToolCall: true }
    },
    {
      name: 'Codex Responses compatibility proxy',
      endpoint: 'responses',
      path: '/responses',
      deps: { requireNativeResponsesCompatibility: true }
    }
  ])(
    'identifies independent $name probes at the upstream HTTP boundary',
    async ({ endpoint, path, deps }) => {
      const { baseUrl, requests } = await startGoGateway()
      const provider = {
        type: 'official' as const,
        vendorId: 'opencode-go' as const,
        baseUrl,
        openaiBaseUrl: baseUrl,
        key: 'synthetic-go-key',
        model: 'probe-model',
        apiEndpoints: [endpoint]
      }

      for (let index = 0; index < 2; index++) {
        expect(await validateProvider(provider, deps)).toMatchObject({
          ok: true,
          category: 'ok',
          status: 200
        })
      }
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.session).toMatch(/^open-science-probe-[0-9a-f-]{36}$/)
        expect(request.userAgent).toBe('open-science/provider-validation')
        expect(request.path).toBe(`/zen/go/v1${path}`)
        expect(request.auth).toBe('Bearer synthetic-go-key')
      }
      expect(requests[0].session).not.toBe(requests[1].session)
    }
  )

  it.each(['opencode', undefined] as const)(
    'does not attach Go identity for vendor %s',
    async (vendorId) => {
      const { baseUrl, requests } = await startGoGateway()
      const result = await validateProvider({
        type: vendorId ? 'official' : 'custom',
        vendorId,
        baseUrl,
        apiEndpoints: ['openai'],
        model: 'probe-model'
      })
      expect(result).toMatchObject({
        ok: false,
        category: 'unknown',
        status: 400,
        message: expect.stringContaining('missing x-opencode-session')
      })
      expect(requests[0].session).toBeUndefined()
      expect(requests[0].userAgent).not.toBe('open-science/provider-validation')
    }
  )
})
