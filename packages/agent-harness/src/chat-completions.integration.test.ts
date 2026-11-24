import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createChatCompletionsModel } from './chat-completions'
import { createJournalAgentStore } from './journal-store'
import { createMemoryAgentStore } from './memory-store'
import { openAgentSession } from './session'
import type { ModelRequest } from './session-types'

it('commits captured text, tools and usage through HTTP to a cold journal store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-terminal-trailers-'))
  const samples = await Promise.all(
    ['repeated-stop', 'repeated-tool-calls', 'empty-choices'].map((name) =>
      readFile(new URL(`./fixtures/chat-completions/${name}.sse`, import.meta.url), 'utf8')
    )
  )
  const requests: ModelRequest[] = []
  let effects = 0
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const part of request) raw += String(part)
      const body = JSON.parse(raw)
      requests.push(body)
      const sample = body.messages.some((message: { role: string }) => message.role === 'tool')
        ? samples[0]
        : samples[Number(request.url!.split('/')[1])]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const bytes = Buffer.from(sample)
      for (let offset = 0; offset < bytes.length; offset += 17)
        response.write(bytes.subarray(offset, offset + 17))
      response.end()
    })().catch(() => response.destroy())
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const [index, expectedUsage] of [
      { inputTokens: 46, outputTokens: 4, cacheReadTokens: 0 },
      { inputTokens: 223, outputTokens: 13, cacheReadTokens: 192 },
      { inputTokens: 35, outputTokens: 5, cacheReadTokens: 0 }
    ].entries()) {
      const sessionId = `captured-${index}`
      const session = await openAgentSession({
        sessionId,
        store: createJournalAgentStore({ directory }),
        model: createChatCompletionsModel({
          endpoint: `${base}/${index}/chat/completions`,
          model: 'generic-model',
          apiKey: () => 'fixture-key'
        }),
        maxSteps: 3,
        maxOutputTokens: 100,
        tools: [
          {
            name: 'protocol_probe',
            version: '1',
            description: 'Local no-op',
            parameters: { type: 'object' },
            validate(args) {
              expect(args).toEqual({ value: 'OK' })
              return args
            },
            authorize: async () => true,
            execute: async () => {
              effects++
              return { content: [{ type: 'text', text: 'OK' }] }
            }
          }
        ]
      })
      try {
        expect(await session.prompt([{ type: 'text', text: 'Replay' }])).toBe('complete')
      } finally {
        await session.dispose()
      }
      // Reopen the store from disk to verify persistence independently of the in-memory snapshot.
      const cold = (await createJournalAgentStore({ directory }).load(sessionId))!
      const assistant = cold.messages.filter((message) => message.role === 'assistant')
      expect(assistant).toHaveLength(index === 1 ? 2 : 1)
      expect(assistant.at(-1)!.content).toEqual([{ type: 'text', text: 'PROBE_OK' }])
      expect(cold.requests[0].usage).toEqual(expectedUsage)
      expect(cold.requests.every((request) => request.status === 'completed')).toBe(true)
      if (index === 1) {
        expect(assistant[0].calls).toEqual([
          { id: 'probe-id-007', name: 'protocol_probe', arguments: { value: 'OK' } }
        ])
        expect(cold.requests[1].usage).toEqual({
          inputTokens: 46,
          outputTokens: 4,
          cacheReadTokens: 0
        })
      }
    }
    expect(effects).toBe(1)
    expect(requests).toHaveLength(4)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(directory, { recursive: true, force: true })
  }
})

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
                delta: {
                  tool_calls: [
                    { index: 0, id: null, function: { name: null, arguments: '3,5,8]}' } }
                  ]
                },
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
