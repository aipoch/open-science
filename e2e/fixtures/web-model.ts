import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'

export type ModelRequest = {
  stream?: boolean
  messages: Array<{ role: string; content?: unknown }>
  tools?: Array<{ name?: string; type?: string; function: { name: string } }>
}

type ModelFixture = { name: string; model: string; key: string }
type Usage = { prompt_tokens: number; completion_tokens: number }
type Reply = string | { id: string; name: string; args: object }

export const startWebModel = async (
  model: string,
  replyTo: (body: ModelRequest, path: string) => Reply,
  {
    usage = { prompt_tokens: 1000, completion_tokens: 20 },
    probe = 'usage',
    onPost
  }: { usage?: Usage; probe?: 'minimal' | 'stop' | 'usage'; onPost?: () => void } = {}
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: model }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    onPost?.()
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'OK' },
              ...(probe === 'minimal' ? {} : { finish_reason: 'stop' })
            }
          ],
          ...(probe === 'usage' ? { usage: { prompt_tokens: 1, completion_tokens: 1 } } : {})
        })
      )
      return
    }
    const reply = replyTo(body, request.url ?? '')
    const delta =
      typeof reply === 'string'
        ? { content: reply }
        : {
            tool_calls: [
              {
                index: 0,
                id: reply.id,
                type: 'function',
                function: { name: reply.name, arguments: JSON.stringify(reply.args) }
              }
            ]
          }
    const events = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [
          { index: 0, delta: {}, finish_reason: typeof reply === 'string' ? 'stop' : 'tool_calls' }
        ],
        usage
      }
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export const configureWebModel = (
  page: Page,
  baseUrl: string,
  fixture: ModelFixture
): Promise<void> =>
  page.evaluate(
    async ({ baseUrl, name, model, key }) => {
      await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
      const settings = await window.api.settings.upsertProvider({
        type: 'custom',
        name,
        baseUrl,
        model,
        key,
        apiEndpoints: ['chat-completions'],
        contextWindow: 200000,
        maxOutputTokens: 4096
      })
      const provider = settings.providers.find((item) => item.name === name)!
      await window.api.settings.setActiveProvider({ id: provider.id, model })
      await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
      await window.api.settings.setAgentFramework({ id: 'open-science-agent' })
    },
    { baseUrl, ...fixture }
  )
