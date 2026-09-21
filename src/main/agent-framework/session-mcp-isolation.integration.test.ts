import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { claudeCodeFramework } from './claude-code'
import { createCodexFramework } from './codex'
import { terminateProcessTree } from '../process-tree'
import { ResponsesBridge } from '../settings/responses-bridge'
import { NativeResponsesCompatibilityProxy } from '../settings/native-responses-compatibility'

const claudeNative = process.env.CLAUDE_NATIVE_PATH
const codexAdapter = process.env.CODEX_ACP_PATH
const codexNative = process.env.CODEX_NATIVE_PATH
const probeTools = [
  { server: 'open-science-notebook', name: 'repl_execute' },
  { server: 'open-science-artifacts', name: 'write_artifact_file' },
  { server: 'open-science-plan', name: 'update_step_status' }
] as const
const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// The model is deterministic, but both the ACP adapter and native agent are real processes.
// Record actual MCP credentials with a per-turn nonce; assistant prose cannot satisfy this check.
for (const engine of ['claude-code', 'codex-responses', 'codex-bridge'] as const) {
  it
    .runIf(engine === 'claude-code' ? claudeNative : codexAdapter && codexNative)
    .each(['stdio', 'http'] as const)(
    `${engine} preserves Session tool ownership through switching, concurrency, and resume (%s)`,
    async (transport) => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-session-mcp-isolation-'))
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      const calls: Array<{ owner: string; turn: string; tool: string }> = []
      const sent = new Set<string>()
      const requestErrors: string[] = []
      const concurrentWaiters: Array<() => void> = []
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
        let result: unknown = {}
        if (body.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'repl_execute', version: '1' }
          }
        const toolName = String(request.headers['x-test-tool'])
        if (body.method === 'tools/list')
          result = {
            tools: [
              {
                name: toolName,
                description: 'Return the tool owner for a test turn.',
                inputSchema: {
                  type: 'object',
                  properties: { turn: { type: 'string' } },
                  required: ['turn']
                }
              }
            ]
          }
        if (body.method === 'tools/call') {
          const record = {
            owner: String(request.headers['x-test-session']),
            turn: String(body.params.arguments.turn),
            tool: String(body.params.name)
          }
          calls.push(record)
          if (record.turn.endsWith('-concurrent') && record.tool === 'repl_execute') {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                requestErrors.push('Concurrent tool calls did not overlap')
                resolve()
              }, 5000)
              concurrentWaiters.push(() => {
                clearTimeout(timer)
                resolve()
              })
              if (concurrentWaiters.length === 2) concurrentWaiters.forEach((release) => release())
            })
          }
          result = { content: [{ type: 'text', text: JSON.stringify(record) }] }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
      const mcpUrl = await listen(mcp)
      const entry = join(root, 'mcp.cjs')
      await writeFile(
        entry,
        `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', async line => {
 const body=JSON.parse(line);
 const result=await fetch(process.env.PROBE_MCP_URL,{method:'POST',headers:{'content-type':'application/json','x-test-session':process.env.PROBE_OWNER,'x-test-tool':process.env.PROBE_TOOL},body:line});
 if(body.id!==undefined) process.stdout.write(JSON.stringify(await result.json())+'\\n');
});\n`
      )
      const respond = (body: Record<string, unknown>): string => {
        const text = JSON.stringify(body.messages ?? body.input ?? [])
        const turn = [...text.matchAll(/ISOLATION_TURN:([a-z0-9-]+)/g)].at(-1)?.[1]
        const tools = body.tools as
          Array<{ name?: string; function?: { name: string } }> | undefined
        const names = probeTools.map((probe) =>
          tools
            ?.map((tool) => tool.name ?? tool.function?.name)
            .find((name) => name?.endsWith(probe.name))
        )
        const name = names.find((name) => name && !sent.has(`${turn}:${name}`))
        const invoke = Boolean(turn && name)
        if (turn && names.some((name) => !name))
          requestErrors.push(`Missing probe tools for ${turn}: ${JSON.stringify(tools)}`)
        if (invoke) sent.add(`${turn}:${name}`)
        const callId = `call_${turn ?? 'background'}_${sent.size}`
        if (engine === 'claude-code') {
          const event = (type: string, value: unknown): string =>
            `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
          return (
            event('message_start', {
              type: 'message_start',
              message: {
                id: callId,
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 0 }
              }
            }) +
            event('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: invoke
                ? { type: 'tool_use', id: callId, name, input: {} }
                : { type: 'text', text: '' }
            }) +
            event('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: invoke
                ? { type: 'input_json_delta', partial_json: JSON.stringify({ turn }) }
                : { type: 'text_delta', text: 'done' }
            }) +
            event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
            event('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 }
            }) +
            event('message_stop', { type: 'message_stop' })
          )
        }
        if (engine === 'codex-bridge') {
          return (
            [
              {
                id: callId,
                choices: [
                  {
                    index: 0,
                    delta: invoke
                      ? {
                          role: 'assistant',
                          tool_calls: [
                            {
                              index: 0,
                              id: callId,
                              type: 'function',
                              function: { name, arguments: JSON.stringify({ turn }) }
                            }
                          ]
                        }
                      : { role: 'assistant', content: 'done' },
                    finish_reason: null
                  }
                ]
              },
              {
                id: callId,
                choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
              }
            ]
              .map((value) => `data: ${JSON.stringify(value)}\n\n`)
              .join('') + 'data: [DONE]\n\n'
          )
        }
        return [
          { type: 'response.created', response: { id: callId } },
          {
            type: 'response.output_item.done',
            item: invoke
              ? {
                  type: 'function_call',
                  call_id: callId,
                  name,
                  arguments: JSON.stringify({ turn })
                }
              : {
                  type: 'message',
                  id: callId,
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'done' }]
                }
          },
          {
            type: 'response.completed',
            response: { id: callId, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
          }
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join('')
      }
      const model = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        if (request.url?.includes('count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(respond(body))
      })
      const modelUrl = await listen(model)
      const upstream: typeof fetch = async (_url, init) =>
        new Response(respond(JSON.parse(String(init?.body))), {
          headers: { 'content-type': 'text/event-stream' }
        })
      const target = {
        baseUrl: 'https://unused.invalid/v1',
        model: 'probe-model',
        namespacedTools: probeTools
          .filter((tool) => tool.server !== 'open-science-plan')
          .map((tool) => ({
            namespace: `mcp__${tool.server.replaceAll('-', '_')}`,
            name: tool.name,
            description: 'Return the owner of this test MCP connection.',
            parameters: {
              type: 'object',
              properties: { turn: { type: 'string' } },
              required: ['turn'],
              additionalProperties: false
            }
          }))
      }
      const proxy =
        engine === 'claude-code'
          ? undefined
          : engine === 'codex-bridge'
            ? new ResponsesBridge(target, upstream)
            : new NativeResponsesCompatibilityProxy(target, upstream)
      const bridge = await proxy?.start()
      const framework = engine === 'claude-code' ? claudeCodeFramework : createCodexFramework()
      const config = framework.prepareModelConfig(
        {
          type: 'custom',
          baseUrl: modelUrl,
          key: 'synthetic-isolation-key',
          apiEndpoints:
            engine === 'claude-code'
              ? ['anthropic']
              : engine === 'codex-bridge'
                ? ['openai']
                : ['responses'],
          model: engine === 'claude-code' ? 'claude-sonnet-4-5' : 'probe-model',
          contextWindow: 128000
        },
        {
          storageRoot: root,
          executablePath: engine === 'claude-code' ? claudeNative! : codexAdapter!,
          ...(bridge ? { responsesBridge: bridge } : {})
        }
      )
      for (const file of config.configFiles ?? []) {
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.content)
      }
      const setup = framework.buildSessionSetup({ systemPromptAppends: [] })
      const executable =
        engine === 'claude-code'
          ? resolve('node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')
          : codexAdapter!
      // Avoid inherited credentials/proxy settings. The framework supplies isolated app-owned homes.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
        ...config.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        ...(engine !== 'claude-code' ? { CODEX_PATH: codexNative! } : {})
      }
      let child: ChildProcessWithoutNullStreams | undefined
      const stderr: string[] = []
      const servers = (owner: string): acp.McpServer[] =>
        probeTools.map((tool) =>
          transport === 'http'
            ? {
                name: tool.server,
                type: 'http',
                url: mcpUrl,
                headers: [
                  { name: 'x-test-session', value: owner },
                  { name: 'x-test-tool', value: tool.name }
                ]
              }
            : {
                name: tool.server,
                command: process.execPath,
                args: [entry],
                env: [
                  { name: 'PROBE_OWNER', value: owner },
                  { name: 'PROBE_MCP_URL', value: mcpUrl },
                  { name: 'PROBE_TOOL', value: tool.name }
                ]
              }
        )
      const expectedCalls = (
        owner: string,
        turn: string
      ): Array<{ owner: string; turn: string; tool: string }> =>
        probeTools.map((probe) => ({ owner, turn, tool: probe.name }))
      const prompt = async (
        session: acp.ActiveSession,
        owner: string,
        turn: string
      ): Promise<void> => {
        session.prompt(
          `Call each of the three test tools once with this turn: ISOLATION_TURN:${turn}`
        )
        while ((await session.nextUpdate()).kind !== 'stop') {
          /* drain */
        }
        expect(
          calls.filter((record) => record.turn === turn),
          stderr.join('').slice(-3000)
        ).toEqual(expectedCalls(owner, turn))
      }
      const connect = async (work: (ctx: acp.ClientContext) => Promise<void>): Promise<void> => {
        child = spawn(
          executable.endsWith('.js') ? process.execPath : executable,
          executable.endsWith('.js') ? [executable] : [],
          { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] }
        )
        child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
        await acp
          .client({ name: 'session-isolation-probe' })
          .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
            outcome: {
              outcome: 'selected',
              optionId: ctx.params.options.find((option) => option.kind === 'allow_once')!.optionId
            }
          }))
          .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: '' }))
          .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
          .connectWith(
            acp.ndJsonStream(
              Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
              Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
            ),
            async (ctx) => {
              await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
              })
              if (config.providerConfiguration)
                await ctx.request(acp.methods.agent.providers.set, config.providerConfiguration)
              await work(ctx)
            }
          )
      }
      let saved: string[] = []
      try {
        await connect(async (ctx) => {
          const original = await ctx
            .buildSession({
              cwd: workspace,
              mcpServers: servers('original'),
              ...(setup.meta ? { _meta: setup.meta } : {})
            })
            .start()
          const sibling = await ctx
            .buildSession({
              cwd: workspace,
              mcpServers: servers('sibling'),
              ...(setup.meta ? { _meta: setup.meta } : {})
            })
            .start()
          saved = [original.sessionId, sibling.sessionId]
          expect(original.sessionId).not.toBe(sibling.sessionId)
          await prompt(original, 'original', 'original-first')
          await prompt(sibling, 'sibling', 'sibling-first')
          await prompt(original, 'original', 'original-again')
          await Promise.all([
            prompt(original, 'original', 'original-concurrent'),
            prompt(sibling, 'sibling', 'sibling-concurrent')
          ])
          await ctx.request(acp.methods.agent.session.close, { sessionId: original.sessionId })
          await ctx.request(acp.methods.agent.session.resume, {
            sessionId: original.sessionId,
            cwd: workspace,
            mcpServers: servers('original'),
            ...(setup.meta ? { _meta: setup.meta } : {})
          })
          await prompt(original, 'original', 'original-resumed')
          await prompt(sibling, 'sibling', 'sibling-after-resume')
          await ctx.request(acp.methods.agent.session.close, { sessionId: sibling.sessionId })
          await ctx.request(acp.methods.agent.session.resume, {
            sessionId: sibling.sessionId,
            cwd: workspace,
            mcpServers: servers('sibling-rebound'),
            ...(setup.meta ? { _meta: setup.meta } : {})
          })
          await prompt(original, 'original', 'original-after-rebind')
          await prompt(sibling, 'sibling-rebound', 'sibling-rebound')
          expect(requestErrors).toEqual([])
          expect(calls).toHaveLength(27)
        })
        await terminateProcessTree(child!)
        await connect(async (ctx) => {
          for (const [index, sessionId] of saved.entries()) {
            const owner = index === 0 ? 'original' : 'sibling-rebound'
            await ctx.request(acp.methods.agent.session.resume, {
              sessionId,
              cwd: workspace,
              mcpServers: servers(owner),
              ...(setup.meta ? { _meta: setup.meta } : {})
            })
          }
          for (const index of [0, 1, 0]) {
            const owner = index === 0 ? 'original' : 'sibling-rebound'
            const turn = `cold-${index}-${calls.length}`
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId: saved[index],
              prompt: [{ type: 'text', text: `Call the tool: ISOLATION_TURN:${turn}` }]
            })
            expect(calls.filter((call) => call.turn === turn)).toEqual(expectedCalls(owner, turn))
          }
          expect(requestErrors).toEqual([])
          expect(calls).toHaveLength(36)
        })
      } catch (error) {
        throw new Error(
          `${String(error)}\n${requestErrors.join('\n')}\n${stderr.join('').slice(-7000)}`
        )
      } finally {
        if (child) await terminateProcessTree(child)
        await proxy?.close()
        for (const server of [model, mcp]) {
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    90_000
  )
}
