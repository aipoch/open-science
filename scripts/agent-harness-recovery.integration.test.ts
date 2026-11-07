import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createJournalAgentStore,
  openAgentSession,
  type AgentModel,
  type ContentBlock,
  type ModelEvent
} from '@aipoch/agent-harness'
import { loadMcpTools } from '@aipoch/agent-harness/mcp'

// Child workers use installed public exports and real fsync; no mocked store or process exit.
const workerSource = String.raw`
const { openSync, writeSync, fsyncSync, closeSync } = require('node:fs')
const { join } = require('node:path')
const { openAgentSession, createJournalAgentStore } = require('@aipoch/agent-harness')
const [directory, point] = process.argv.slice(1)
const text = value => [{ type: 'text', text: value }]
const done = value => ({ type: 'finish', reason: 'complete', content: text(value) })
const pause = async () => {
  process.send({ point })
  await new Promise(() => { setInterval(() => {}, 1000) })
}
const store = createJournalAgentStore({ directory })
const model = {
  id: 'recovery-fixture', capabilities: { tools: true, images: false, files: false },
  async *stream(request) {
    if (point === 'summary') {
      yield { type: 'text-delta', text: 'Uncommitted partial summary' }
      await pause()
    } else if (request.messages.at(-1).role === 'tool') {
      await pause()
    } else {
      yield { type: 'finish', reason: 'tools', content: [], calls: [{ id: 'append-call', name: 'append', arguments: {} }], usage: { inputTokens: 12, outputTokens: 3 } }
    }
  }
}
async function main() {
  const common = { sessionId: 'session', store, maxSteps: 4, maxOutputTokens: 128 }
  if (point === 'summary') {
    const seed = await openAgentSession({ ...common, model: { ...model, async *stream() { yield done('ready') } } })
    await seed.prompt(text('old evidence '.repeat(1000)))
    await seed.dispose()
  }
  const session = await openAgentSession({
    ...common, model,
    ...(point === 'summary' ? { compaction: { inputBudget: 2000, keepRecentItems: 1, maxOutputTokens: 256, measure: r => JSON.stringify(r.messages).length } } : {}),
    tools: [{ name: 'append', version: '1', description: 'Append one receipt', parameters: { type: 'object' },
      validate: args => args, authorize: async () => true,
      execute: async (_, context) => {
        const receipt = { invocationId: context.invocationId, value: 1 }
        const fd = openSync(join(directory, 'effects.jsonl'), 'a')
        try { writeSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        if (point === 'unacknowledged-effect') await pause()
        return { content: text(JSON.stringify(receipt)) }
      }
    }]
  })
  await session.prompt(text('perform one operation'))
  throw new Error('Expected the parent to terminate at the barrier')
}
main().catch(error => { console.error(error); process.exit(1) })
`

const serverSource = String.raw`
const { openSync, writeSync, fsyncSync, closeSync } = require('node:fs')
const { join } = require('node:path')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const [directory, disconnect] = process.argv.slice(1)
const server = new Server({ name: 'receipt-fixture', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'append', description: 'Append one receipt', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'append' || typeof request.params._meta?.invocationId !== 'string') throw new Error('Invalid fixture call')
  const receipt = { invocationId: request.params._meta.invocationId, value: 1 }
  const fd = openSync(join(directory, 'effects.jsonl'), 'a')
  try { writeSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  if (disconnect === 'yes') process.kill(process.pid, 'SIGKILL')
  return { content: [{ type: 'text', text: JSON.stringify(receipt) }] }
})
server.connect(new StdioServerTransport()).catch(error => { console.error(error); process.exit(1) })
`

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const done = (value: string): ModelEvent => ({
  type: 'finish',
  reason: 'complete',
  content: text(value)
})
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Recovery fixture cleanup failed')
})
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'harness-recovery-'))
  cleanup.push(() => rm(value, { recursive: true, force: true }))
  return value
}
async function receipts(root: string): Promise<{ invocationId: string; value: number }[]> {
  return (await readFile(join(root, 'effects.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
async function crashWorker(root: string, point: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', workerSource, root, point], {
    cwd: process.cwd(),
    env: getDefaultEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  child.stdout!.resume()
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  cleanup.push(stop)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker barrier timeout: ${stderr}`)), 10_000)
    child.once('message', (message) => {
      clearTimeout(timer)
      if ((message as { point: string }).point === point) resolve()
      else reject(new Error('Unexpected worker barrier'))
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Worker exited before barrier: ${stderr}`))
    })
  })
  await stop()
  expect(child.signalCode).toBe('SIGKILL')
}

it.each(['unacknowledged-effect', 'acknowledged-effect'])(
  'recovers a killed harness at %s without repeating its durable effect',
  async (point) => {
    const root = await directory()
    await crashWorker(root, point)
    const store = createJournalAgentStore({ directory: root })
    const saved = (await store.load('session'))!
    const [receipt] = await receipts(root)
    expect(await receipts(root)).toHaveLength(1)
    expect(saved.run?.status).toBe('running')
    const execute = vi.fn(async () => {
      throw new Error('Unexpected replay')
    })
    const dispatch = vi.fn(async function* () {
      yield done('verified receipt')
    })
    const session = await openAgentSession({
      sessionId: 'session',
      store,
      maxSteps: 4,
      maxOutputTokens: 128,
      model: {
        id: 'recovery-fixture',
        capabilities: { tools: true, images: false, files: false },
        stream: dispatch
      },
      tools: [
        {
          name: 'append',
          version: '1',
          description: 'Append one receipt',
          parameters: { type: 'object' },
          validate: (args) => args,
          authorize: async () => true,
          execute
        }
      ]
    })
    cleanup.push(() => session.dispose())
    await expect(session.continue()).rejects.toThrow('explicit recovery')
    await expect(session.recover('wrong-run')).rejects.toThrow('identity')
    await session.recover(saved.run!.id)
    if (point === 'unacknowledged-effect') {
      expect(saved.pending[0]).toMatchObject({
        invocationId: receipt.invocationId,
        status: 'started'
      })
      expect((await session.snapshot()).pending[0].status).toBe('unknown')
      await expect(session.continue()).rejects.toThrow('Reconcile')
      expect(dispatch).not.toHaveBeenCalled()
      await session.reconcile(receipt.invocationId, { content: text(JSON.stringify(receipt)) })
    } else {
      expect(saved.pending).toEqual([])
      expect(saved.messages.at(-1)).toMatchObject({
        role: 'tool',
        invocationId: receipt.invocationId
      })
      const interrupted = (await session.snapshot()).requests.at(-1)!
      expect(interrupted.status).toBe('interrupted')
      expect(interrupted.usage).toBeUndefined()
    }
    expect(await session.continue()).toBe('complete')
    expect(execute).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
    const final = await session.snapshot()
    expect(final.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(final.requests[0].usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(await receipts(root)).toEqual([receipt])
  }
)

it('recovers a killed summary without committing partial text or losing original history', async () => {
  const root = await directory()
  await crashWorker(root, 'summary')
  const store = createJournalAgentStore({ directory: root })
  const saved = (await store.load('session'))!
  expect(saved.requests.at(-1)).toMatchObject({ purpose: 'compaction', status: 'started' })
  expect(saved.compactions).toEqual([])
  let summaries = 0,
    mains = 0
  const session = await openAgentSession({
    sessionId: 'session',
    store,
    maxSteps: 4,
    maxOutputTokens: 128,
    compaction: {
      inputBudget: 2000,
      keepRecentItems: 1,
      maxOutputTokens: 256,
      measure: (r) => JSON.stringify(r.messages).length
    },
    model: {
      id: 'recovery-fixture',
      capabilities: { tools: false, images: false, files: false },
      async *stream(request) {
        const last = request.messages.at(-1)?.content[0]
        if (
          last?.type === 'text' &&
          last.text.startsWith('Create a compact continuation checkpoint')
        ) {
          summaries++
          yield done(
            '## Goal\nFinish.\n## Progress\nReady.\n## Evidence\nOriginal evidence retained.\n## Next\nAnswer.'
          )
        } else {
          mains++
          yield done('complete')
        }
      }
    }
  })
  cleanup.push(() => session.dispose())
  await expect(session.continue()).rejects.toThrow('explicit recovery')
  await session.recover(saved.run!.id)
  const recovered = await session.snapshot()
  expect(recovered.requests.at(-1)).toMatchObject({ purpose: 'compaction', status: 'interrupted' })
  expect(recovered.requests.at(-1)?.usage).toBeUndefined()
  expect(recovered.messages).toEqual(saved.messages)
  expect(await session.continue()).toBe('complete')
  const final = await session.snapshot()
  expect([summaries, mains]).toEqual([1, 1])
  expect(final.compactions).toHaveLength(1)
  expect(final.messages.slice(0, saved.messages.length)).toEqual(saved.messages)
  expect(JSON.stringify(final)).not.toContain('Uncommitted partial summary')
})

it('fences an MCP result lost on service exit and reconnects without replaying the effect', async () => {
  const root = await directory()
  const connect = async (
    disconnect: boolean
  ): Promise<Awaited<ReturnType<typeof loadMcpTools>>> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', serverSource, root, disconnect ? 'yes' : 'no'],
      stderr: 'pipe'
    })
    transport.stderr?.on('data', () => undefined)
    const client = new Client({ name: 'recovery-test', version: '1' })
    let pid: number | null = null
    cleanup.push(async () => {
      await client.close()
      if (pid !== null)
        await expect
          .poll(() => {
            try {
              process.kill(pid!, 0)
              return false
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH'
            }
          })
          .toBe(true)
    })
    await client.connect(transport)
    pid = transport.pid
    expect(pid).not.toBeNull()
    return loadMcpTools({
      signal: AbortSignal.timeout(10_000),
      client: {
        listTools: (cursor, signal) => client.listTools(cursor ? { cursor } : {}, { signal }),
        callTool: (name, args, context) =>
          client.callTool(
            { name, arguments: args, _meta: { invocationId: context.invocationId } },
            undefined,
            { signal: context.signal, timeout: 10_000 }
          )
      },
      bind: () => ({ validate: (args) => args, authorize: async () => true })
    })
  }
  let modelCalls = 0
  const model: AgentModel = {
    id: 'mcp-recovery',
    capabilities: { tools: true, images: false, files: false },
    async *stream(request) {
      modelCalls++
      if (request.messages.at(-1)?.role === 'user')
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'append-call', name: 'append', arguments: {} }]
        }
      else yield done('receipt confirmed')
    }
  }
  const common = { sessionId: 'session', model, maxSteps: 4, maxOutputTokens: 128 }
  const first = await openAgentSession({
    ...common,
    store: createJournalAgentStore({ directory: root }),
    tools: await connect(true)
  })
  cleanup.push(() => first.dispose())
  await expect(first.prompt(text('append once'))).rejects.toThrow()
  const failed = await first.snapshot()
  const [receipt] = await receipts(root)
  expect(failed.pending[0]).toMatchObject({ status: 'unknown', invocationId: receipt.invocationId })
  expect(modelCalls).toBe(1)
  await first.dispose()
  const next = await openAgentSession({
    ...common,
    store: createJournalAgentStore({ directory: root }),
    tools: await connect(false)
  })
  cleanup.push(() => next.dispose())
  await expect(next.continue()).rejects.toThrow('Reconcile')
  expect(modelCalls).toBe(1)
  expect(await receipts(root)).toEqual([receipt])
  await next.reconcile(receipt.invocationId, { content: text(JSON.stringify(receipt)) })
  expect(await next.continue()).toBe('complete')
  expect(await receipts(root)).toEqual([receipt])
  expect(await next.prompt(text('append a new operation'))).toBe('complete')
  const effects = await receipts(root)
  expect(effects).toHaveLength(2)
  expect(new Set(effects.map((r) => r.invocationId)).size).toBe(2)
  expect((await next.snapshot()).pending).toEqual([])
})

it.each(['socket-disconnect', 'client-cancel'] as const)(
  'keeps HTTP work uncertain after %s until the remote operation actually settles',
  async (fault) => {
    const root = await directory()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const failures: unknown[] = []
    let callResponse: ServerResponse | undefined
    let activeJobs = 0,
      remoteCalls = 0,
      modelCalls = 0
    const http = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        // A fresh stateless SDK server per HTTP request; jobs outlive their connection.
        const server = new Server(
          { name: 'http-recovery', version: '1' },
          { capabilities: { tools: {} } }
        )
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: 'append',
              description: 'Append a durable receipt',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false }
            }
          ]
        }))
        server.setRequestHandler(CallToolRequestSchema, async (message) => {
          const invocationId = message.params._meta?.invocationId
          if (message.params.name !== 'append' || typeof invocationId !== 'string')
            throw new Error('Invalid fixture call')
          remoteCalls++
          activeJobs++
          const first = remoteCalls === 1
          try {
            if (first) {
              callResponse = response
              response.once('close', () => disconnected.resolve())
              entered.resolve()
              // Deliberately ignore connection cancellation, as an independent executor may do.
              await release.promise
            }
            const receipt = { invocationId, value: 1 }
            const handle = await open(join(root, 'effects.jsonl'), 'a')
            try {
              await handle.writeFile(JSON.stringify(receipt) + '\n')
              await handle.sync()
            } finally {
              await handle.close()
            }
            return { content: text(JSON.stringify(receipt)) }
          } finally {
            activeJobs--
            if (first) settled.resolve()
          }
        })
        try {
          await server.connect(transport)
          await transport.handleRequest(request, response, body)
        } finally {
          await server.close()
        }
      })().catch((error) => {
        // A deliberately closed response may reject its late write; executor errors still fail assertions.
        if (!response.destroyed) {
          failures.push(error)
          response.destroy()
        }
      })
    })
    cleanup.push(async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      )
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)
    const connect = async (): Promise<{
      client: Client
      tools: Awaited<ReturnType<typeof loadMcpTools>>
    }> => {
      const client = new Client({ name: 'http-recovery-test', version: '1' })
      cleanup.push(() => client.close())
      await client.connect(new StreamableHTTPClientTransport(url))
      const tools = await loadMcpTools({
        signal: AbortSignal.timeout(10_000),
        client: {
          listTools: (cursor, signal) => client.listTools(cursor ? { cursor } : {}, { signal }),
          callTool: (name, args, context) =>
            client.callTool(
              { name, arguments: args, _meta: { invocationId: context.invocationId } },
              undefined,
              { signal: context.signal, timeout: 10_000 }
            )
        },
        bind: () => ({ validate: (args) => args, authorize: async () => true })
      })
      return { client, tools }
    }
    const model: AgentModel = {
      id: 'http-recovery',
      capabilities: { tools: true, images: false, files: false },
      async *stream(request) {
        modelCalls++
        if (request.messages.at(-1)?.role === 'user')
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [{ id: 'append-call', name: 'append', arguments: {} }]
          }
        else yield done('receipt confirmed')
      }
    }
    const common = { sessionId: 'session', model, maxSteps: 4, maxOutputTokens: 128 }
    try {
      const connection = await connect()
      const first = await openAgentSession({
        ...common,
        store: createJournalAgentStore({ directory: root }),
        tools: connection.tools
      })
      cleanup.push(() => first.dispose())
      const running = first.prompt(text('append once')).catch((error) => error as Error)
      await entered.promise
      expect(activeJobs).toBe(1)
      if (fault === 'socket-disconnect') callResponse!.destroy()
      else first.cancel()
      if (fault === 'client-cancel') expect(await running).toBe('blocked')
      else expect(await running).toBeInstanceOf(Error)
      await connection.client.close()
      await disconnected.promise
      await first.dispose()
      const saved = await first.snapshot()
      expect(saved.run?.status).toBe('blocked')
      expect(saved.pending[0].status).toBe('unknown')
      expect(activeJobs).toBe(1)
      await expect(readFile(join(root, 'effects.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })

      const next = await openAgentSession({
        ...common,
        store: createJournalAgentStore({ directory: root }),
        tools: (await connect()).tools
      })
      cleanup.push(() => next.dispose())
      await expect(next.continue()).rejects.toThrow('Reconcile')
      await expect(next.prompt(text('try again'))).rejects.toThrow('Resolve pending tools')
      await expect(
        next.reconcile('wrong-invocation', { content: text('assumed done') })
      ).rejects.toThrow('identity')
      expect([remoteCalls, modelCalls, activeJobs]).toEqual([1, 1, 1])
      expect((await next.snapshot()).messages).toEqual(saved.messages)

      release.resolve()
      await settled.promise
      expect(activeJobs).toBe(0)
      const [receipt] = await receipts(root)
      expect(await receipts(root)).toHaveLength(1)
      expect(receipt.invocationId).toBe(saved.pending[0].invocationId)
      // The service finished after disconnect; it did not acknowledge the old session's invocation.
      expect((await next.snapshot()).pending[0].status).toBe('unknown')
      expect((await next.snapshot()).messages).toEqual(saved.messages)
      await next.reconcile(receipt.invocationId, { content: text(JSON.stringify(receipt)) })
      expect(await next.continue()).toBe('complete')
      expect(await receipts(root)).toEqual([receipt])
      expect(await next.prompt(text('append a new operation'))).toBe('complete')
      const effects = await receipts(root)
      expect(effects).toHaveLength(2)
      expect(new Set(effects.map((r) => r.invocationId)).size).toBe(2)
      expect(remoteCalls).toBe(2)
      expect((await next.snapshot()).pending).toEqual([])
      expect(failures).toEqual([])
    } finally {
      release.resolve()
      if (remoteCalls > 0) await settled.promise
    }
  }
)
