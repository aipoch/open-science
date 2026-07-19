import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'

import { ResponsesBridge } from './responses-bridge'

const adapterPath = process.env.CODEX_ACP_PATH
const nativeCodexPath = process.env.CODEX_NATIVE_PATH
const runLiveContract = Boolean(adapterPath && nativeCodexPath)

const chatSse = (chunks: unknown[]): Response =>
  new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

const terminate = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

it.runIf(runLiveContract)(
  'dispatches a bridged namespaced function through the real Codex MCP router',
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'open-science-codex-mcp-bridge-'))
    const codexHome = join(tempRoot, 'codex-home')
    const workspace = join(tempRoot, 'workspace')
    const mcpEntry = join(tempRoot, 'echo-mcp.mjs')
    await Promise.all([mkdir(codexHome), mkdir(workspace)])
    await writeFile(
      mcpEntry,
      [
        "import { createInterface } from 'node:readline'",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')",
        "createInterface({ input: process.stdin }).on('line', (line) => {",
        '  const message = JSON.parse(line)',
        "  if (message.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe-server', version: '1.0.0' } } })",
        "  } else if (message.method === 'tools/list') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo a value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } })",
        "  } else if (message.method === 'tools/call') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.value }] } })",
        '  }',
        '})'
      ].join('\n'),
      'utf8'
    )

    const chatRequests: Record<string, unknown>[] = []
    const upstreamFetch = async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      chatRequests.push(request)
      if (chatRequests.length === 1) {
        return chatSse([
          {
            id: 'chat-mcp-1',
            model: 'probe-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-probe-echo',
                      type: 'function',
                      function: {
                        name: 'mcp__probe_server__echo',
                        arguments: '{"value":"hello"}'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: 'chat-mcp-1',
            model: 'probe-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ])
      }

      return chatSse([
        {
          id: 'chat-mcp-2',
          model: 'probe-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'MCP_BRIDGE_OK' },
              finish_reason: null
            }
          ]
        },
        {
          id: 'chat-mcp-2',
          model: 'probe-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        }
      ])
    }

    const bridge = new ResponsesBridge(
      {
        baseUrl: 'https://vendor.invalid/v1',
        model: 'probe-model',
        namespacedTools: [
          {
            namespace: 'mcp__probe_server',
            name: 'echo',
            description: 'Echo a value.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false
            }
          }
        ]
      },
      upstreamFetch
    )
    const connection = await bridge.start()
    const child = spawn(adapterPath!, [], {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_PATH: nativeCodexPath!,
        MODEL_PROVIDER: 'probe',
        NO_BROWSER: '1',
        CODEX_CONFIG: JSON.stringify({
          model: 'gpt-5.5',
          model_provider: 'probe',
          model_providers: {
            probe: {
              name: 'Bridge MCP contract',
              base_url: connection.baseUrl,
              env_key: 'CODEX_API_KEY',
              wire_api: 'responses'
            }
          }
        })
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
      const result = await acp
        .client({ name: 'open-science-mcp-bridge-contract' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
          outcome: {
            outcome: 'selected',
            optionId:
              ctx.params.options.find((option) => option.kind === 'allow_once')?.optionId ??
              ctx.params.options[0].optionId
          }
        }))
        .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: '' }))
        .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: 'open-science-mcp-bridge-contract', version: '1.0.0' },
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
          })
          await ctx.request(acp.methods.agent.providers.set, {
            providerId: 'custom-gateway',
            apiType: 'openai',
            baseUrl: connection.baseUrl,
            headers: { authorization: `Bearer ${connection.token}` }
          })

          return ctx
            .buildSession({
              cwd: workspace,
              mcpServers: [
                {
                  name: 'probe-server',
                  command: process.execPath,
                  args: [mcpEntry],
                  env: []
                }
              ]
            })
            .withSession(async (session) => {
              session.prompt('Call the echo tool once, then report success.')
              const updates: acp.SessionNotification[] = []
              for (;;) {
                const update = await session.nextUpdate()
                if (update.kind === 'stop')
                  return { updates, stopReason: update.response.stopReason }
                updates.push(update.notification)
              }
            })
        })

      const secondMessages = (chatRequests[1]?.messages ?? []) as Array<Record<string, unknown>>
      expect(chatRequests).toHaveLength(2)
      expect(secondMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'call-probe-echo',
            content: expect.stringContaining('echo:hello')
          })
        ])
      )
      expect(JSON.stringify(result.updates)).toContain('mcp.probe-server.echo')
      expect(JSON.stringify(result.updates)).toContain('MCP_BRIDGE_OK')
      expect(result.stopReason).toBe('end_turn')
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.join('')}`)
    } finally {
      await terminate(child)
      await bridge.close()
      await rm(tempRoot, { recursive: true, force: true })
    }
  },
  30_000
)
