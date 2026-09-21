import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { createOpencodeFramework } from './opencode'

const opencodePath = process.env.OPENCODE_ACP_PATH

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// Uses a real OpenCode process and a deterministic local model endpoint. No model account or
// production Session is used. This pins the provider behavior behind coordinator process isolation.
it.runIf(opencodePath)(
  'keeps original MCP credentials after a sibling registers the same tool in an isolated process',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-opencode-mcp-isolation-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const calls: Array<{ owner: string; turn: string }> = []
    const mcp = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.id === undefined) {
        response.writeHead(202).end()
        return
      }
      let result: unknown
      if (body.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'identity', version: '1' }
        }
      } else if (body.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'identity',
              description: 'Read the tool owner.',
              inputSchema: {
                type: 'object',
                properties: { turn: { type: 'string' } },
                required: ['turn']
              }
            }
          ]
        }
      } else if (body.method === 'tools/call') {
        const owner = String(request.headers['x-test-session'])
        calls.push({ owner, turn: body.params.arguments.turn })
        result = { content: [{ type: 'text', text: owner }] }
      } else result = {}
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    const mcpUrl = await listen(mcp)
    const model = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const tool = body.tools?.find((entry: { function?: { name?: string } }) =>
        entry.function?.name?.endsWith('identity')
      )
      const last = body.messages?.at(-1)
      const turn = [...JSON.stringify(body.messages).matchAll(/ISOLATION_TURN:([a-z0-9-]+)/g)].at(
        -1
      )?.[1]
      const invoke = Boolean(tool && last?.role !== 'tool' && last?.role !== 'assistant')
      const delta = invoke
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'identity-call',
                type: 'function',
                function: { name: tool.function.name, arguments: JSON.stringify({ turn }) }
              }
            ]
          }
        : { role: 'assistant', content: 'done' }
      const chunk = (value: unknown, reason: string | null) =>
        JSON.stringify({
          id: 'probe',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: value, finish_reason: reason }]
        })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, invoke ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`
      )
    })
    const modelUrl = await listen(model)
    const framework = createOpencodeFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        agentProviderId: 'isolation-probe',
        baseUrl: `${modelUrl}/v1`,
        apiEndpoints: ['openai'],
        model: 'probe-model',
        key: 'local-test'
      },
      { storageRoot: root, executablePath: opencodePath! }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const children: ChildProcessWithoutNullStreams[] = []
    const connections: Array<{ stop: () => void; finished: Promise<unknown> }> = []
    const stderr: string[] = []
    const start = async (): Promise<acp.ClientContext> => {
      const child = spawn(opencodePath!, ['acp'], {
        cwd: workspace,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      children.push(child)
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
      let stop!: () => void
      const stopped = new Promise<void>((resolve) => {
        stop = resolve
      })
      let ready!: (ctx: acp.ClientContext) => void
      let fail!: (error: unknown) => void
      const connected = new Promise<acp.ClientContext>((resolve, reject) => {
        ready = resolve
        fail = reject
      })
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
      const finished = acp
        .client({ name: 'isolation-probe' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
          outcome: { outcome: 'selected', optionId: ctx.params.options[0].optionId }
        }))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
          })
          ready(ctx)
          await stopped
        })
      void finished.catch(fail)
      connections.push({ stop, finished })
      return connected
    }
    const session = (ctx: acp.ClientContext, owner: string) =>
      ctx
        .buildSession({
          cwd: workspace,
          mcpServers: [
            {
              name: 'open_science_probe',
              type: 'http',
              url: mcpUrl,
              headers: [{ name: 'x-test-session', value: owner }]
            }
          ]
        })
        .start()
    const prompt = async (current: acp.ActiveSession, turn: string) => {
      current.prompt(`Call the identity tool once: ISOLATION_TURN:${turn}`)
      for (;;) {
        const update = await current.nextUpdate()
        if (update.kind === 'stop') return
      }
    }
    try {
      // Demonstrate the original failure without asking a model to choose a Session identity.
      const shared = await start()
      const originalShared = await session(shared, 'shared-original')
      await session(shared, 'shared-fork')
      await prompt(originalShared, 'shared-original')
      expect(calls.splice(0)).toEqual([{ owner: 'shared-fork', turn: 'shared-original' }])

      // The coordinator now allocates this process boundary for every primary OpenCode Session.
      const original = await session(await start(), 'original')
      const fork = await session(await start(), 'fork')
      await prompt(original, 'original-first')
      await prompt(fork, 'fork-first')
      await prompt(original, 'original-again')
      expect(calls.splice(0)).toEqual([
        { owner: 'original', turn: 'original-first' },
        { owner: 'fork', turn: 'fork-first' },
        { owner: 'original', turn: 'original-again' }
      ])
      await Promise.all([prompt(original, 'original-concurrent'), prompt(fork, 'fork-concurrent')])
      expect(calls).toHaveLength(2)
      expect(calls).toEqual(
        expect.arrayContaining([
          { owner: 'original', turn: 'original-concurrent' },
          { owner: 'fork', turn: 'fork-concurrent' }
        ])
      )
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.join('').slice(-6000)}`)
    } finally {
      for (const connection of connections) connection.stop()
      await Promise.allSettled(connections.map((connection) => connection.finished))
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) return
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
          child.kill('SIGTERM')
          const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
          await exited
          clearTimeout(timer)
        })
      )
      for (const server of [model, mcp]) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60_000
)
