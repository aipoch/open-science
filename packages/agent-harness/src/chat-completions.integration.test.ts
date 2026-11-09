import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createChatCompletionsModel } from './chat-completions'
import { createMemoryAgentStore } from './memory-store'
import { openAgentSession } from './session'
import type { ModelRequest } from './session-types'

it('runs automatic compaction and an authorized tool round-trip through native HTTP/SSE', async () => {
  const checkpoint =
    '## Goal\nAdd values.\n## Progress\nReady.\n## Evidence\nGoal and evidence retained.\n## Next\nAdd 3, 5 and 8.'
  let mainCalls = 0,
    summaries = 0,
    effects = 0
  const failures: unknown[] = []
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    void (async () => {
      try {
        expect(request.headers.authorization).toBe('Bearer fixture-key')
        let raw = ''
        for await (const part of request) raw += String(part)
        const body = JSON.parse(raw)
        bodies.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (data: unknown): void => {
          response.write(`data: ${JSON.stringify(data)}\n\n`)
        }
        if (body.messages.at(-1).content.startsWith('Create a compact continuation checkpoint')) {
          summaries++
          expect(body.model).toBe('main')
          expect(body).not.toHaveProperty('tools')
          expect(body.max_tokens).toBe(80)
          expect(body.messages[1].content).toContain('Old evidence.')
          expect(
            body.messages
              .slice(0, -1)
              .some((message: { content: string }) => message.content === 'Add 3, 5 and 8.')
          ).toBe(false)
          expect(body.messages.at(-1)).toMatchObject({
            role: 'user',
            content: expect.stringContaining('Do not continue the task')
          })
          emit({
            choices: [{ index: 0, delta: { content: checkpoint }, finish_reason: 'stop' }]
          })
        } else if (mainCalls++ === 1) {
          expect(body.messages[1].role).toBe('user')
          expect(body.messages[1].content).toBe(checkpoint)
          emit({
            choices: [{ index: 0, delta: { reasoning_content: 'Need sum.' }, finish_reason: null }]
          })
          emit({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'sum-call',
                      type: 'function',
                      function: { name: 'sum', arguments: '{"values":[' }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })
          emit({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '3,5,8]}' } }] },
                finish_reason: 'tool_calls'
              }
            ]
          })
        } else {
          if (mainCalls === 3) {
            expect(body.messages.at(-1)).toMatchObject({
              role: 'tool',
              tool_call_id: 'sum-call',
              content: '16'
            })
            expect(body.messages.at(-2)).toMatchObject({ reasoning_content: 'Need sum.' })
          }
          emit({
            choices: [
              {
                index: 0,
                delta: { content: mainCalls === 1 ? 'ready' : '16' },
                finish_reason: 'stop'
              }
            ]
          })
        }
        emit({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } })
        response.end('data: [DONE]\n\n')
      } catch (error) {
        failures.push(error)
        response.destroy()
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const model = createChatCompletionsModel({ endpoint, model: 'main', apiKey: () => 'fixture-key' })
  const store = createMemoryAgentStore()
  const measure = (request: ModelRequest): number =>
    JSON.stringify(request.messages).length + request.maxOutputTokens
  const common = { sessionId: 'http', store, model, maxSteps: 4, maxOutputTokens: 100 }
  const seed = await openAgentSession(common)
  let session: Awaited<ReturnType<typeof openAgentSession>> | undefined
  try {
    await seed.prompt([{ type: 'text', text: 'Old evidence. '.repeat(1000) }])
    await seed.dispose()
    session = await openAgentSession({
      ...common,
      compaction: {
        inputBudget: 2000,
        keepRecentItems: 1,
        maxOutputTokens: 80,
        measure
      },
      tools: [
        {
          name: 'sum',
          version: '1',
          description: 'Add values',
          parameters: { type: 'object' },
          validate(args) {
            expect(args).toEqual({ values: [3, 5, 8] })
            return args
          },
          authorize: async () => true,
          execute: async () => {
            effects++
            expect((await store.load('http'))!.pending[0].status).toBe('started')
            return { content: [{ type: 'text', text: '16' }] }
          }
        }
      ]
    })
    expect(await session.prompt([{ type: 'text', text: 'Add 3, 5 and 8.' }])).toBe('complete')
    expect(failures).toEqual([])
    expect([summaries, mainCalls, effects]).toEqual([1, 3, 1])
    const snapshot = await session.snapshot()
    expect(snapshot.requests.filter((entry) => entry.purpose === 'compaction')).toHaveLength(1)
    expect(
      snapshot.requests.every(
        (entry) => entry.status === 'completed' && entry.usage?.inputTokens === 20
      )
    ).toBe(true)
    expect(snapshot.messages.at(-1)!.content).toEqual([{ type: 'text', text: '16' }])
    expect(JSON.stringify(snapshot)).not.toContain('fixture-key')
    expect(bodies).toHaveLength(4)
  } finally {
    await seed.dispose()
    await session?.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
