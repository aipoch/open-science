import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'

import { CODEX_BRIDGE_MODEL } from '../agent-framework/codex'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from '../reviewer/bridge-tools'
import { ReviewerMcpServer, type SubmitFindingsHandler } from '../reviewer/mcp-server'
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
          },
          {
            id: 'chat-mcp-1',
            model: 'probe-model',
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
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
        },
        {
          id: 'chat-mcp-2',
          model: 'probe-model',
          choices: [],
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 }
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
          model: CODEX_BRIDGE_MODEL,
          model_context_window: 1_000_000,
          model_auto_compact_token_limit: 950_000,
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
                  return {
                    updates,
                    response: update.response,
                    stopReason: update.response.stopReason
                  }
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
      expect(result.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'usage_update',
              size: 950_000
            })
          })
        ])
      )
      expect(result.response.usage).toMatchObject({
        inputTokens: 15,
        cachedReadTokens: 0,
        outputTokens: 3
      })
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

it.runIf(runLiveContract)(
  'routes a reviewer read and submission through real Codex ACP without advertising built-ins',
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'open-science-codex-reviewer-bridge-'))
    const codexHome = join(tempRoot, 'codex-home')
    const workspace = join(tempRoot, 'workspace')
    await Promise.all([mkdir(codexHome), mkdir(workspace)])

    const scope = { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }
    const evidence = {
      readTurn: vi.fn(() => [
        {
          id: 'block-1',
          kind: 'message' as const,
          sourceId: 'message-1',
          blockIndex: 0,
          contentHash: 'hash-1',
          role: 'agent',
          content: 'audited evidence'
        }
      ]),
      queryExecutionLog: vi.fn(() => []),
      readArtifact: vi.fn(async () => ({
        id: 'artifact-1',
        kind: 'raw' as const,
        content: 'artifact evidence',
        encoding: 'utf8' as const
      }))
    }
    let submittedChecks: unknown
    const submitFindings = vi.fn(async (checks: unknown) => {
      submittedChecks = checks
    })
    const reviewerMcp = new ReviewerMcpServer(
      scope,
      submitFindings as SubmitFindingsHandler,
      evidence
    )
    await reviewerMcp.start()

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
            id: 'chat-reviewer-read',
            model: 'probe-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-reviewer-read',
                      type: 'function',
                      function: {
                        name: 'mcp__open_science_reviewer__read_turn',
                        arguments: '{}'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: 'chat-reviewer-read',
            model: 'probe-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ])
      }

      if (chatRequests.length === 2) {
        return chatSse([
          {
            id: 'chat-reviewer-submit',
            model: 'probe-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-reviewer-submit',
                      type: 'function',
                      function: {
                        name: 'mcp__open_science_reviewer__submit_findings',
                        arguments: '{"checks":[]}'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: 'chat-reviewer-submit',
            model: 'probe-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ])
      }

      return chatSse([
        {
          id: 'chat-reviewer-complete',
          model: 'probe-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'REVIEWER_BRIDGE_OK' },
              finish_reason: null
            }
          ]
        },
        {
          id: 'chat-reviewer-complete',
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
            namespace: 'mcp__open_science_notebook',
            name: 'notebook_execute',
            parameters: { type: 'object' }
          }
        ],
        reviewerScope: {
          namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS
        }
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
          model: CODEX_BRIDGE_MODEL,
          model_context_window: 1_000_000,
          model_auto_compact_token_limit: 950_000,
          model_provider: 'probe',
          model_providers: {
            probe: {
              name: 'Bridge reviewer contract',
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
      const permissionTools: string[] = []
      const result = await acp
        .client({ name: 'open-science-reviewer-bridge-contract' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          permissionTools.push(String(ctx.params.toolCall.title ?? ctx.params.toolCall.kind ?? ''))
          return {
            outcome: {
              outcome: 'selected',
              optionId:
                ctx.params.options.find((option) => option.kind === 'allow_once')?.optionId ??
                ctx.params.options[0].optionId
            }
          }
        })
        .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: '' }))
        .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: 'open-science-reviewer-bridge-contract', version: '1.0.0' },
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
              mcpServers: [reviewerMcp.toAcpMcpServerConfig()],
              _meta: { disableBuiltInTools: true }
            })
            .withSession(async (session) => {
              bridge.registerReviewerSession(session.sessionId)
              session.prompt('Use read_turn, then call submit_findings.')
              const updates: acp.SessionNotification[] = []
              for (;;) {
                const update = await session.nextUpdate()
                if (update.kind === 'stop') {
                  return { updates, stopReason: update.response.stopReason }
                }
                updates.push(update.notification)
              }
            })
        })

      const expectedReviewerTools = REVIEWER_BRIDGE_NAMESPACED_TOOLS.map(
        (tool) => `${tool.namespace}__${tool.name}`
      )
      const upstreamToolNames = chatRequests.map((request) =>
        ((request.tools ?? []) as Array<{ function?: { name?: string } }>).map(
          (tool) => tool.function?.name
        )
      )
      expect(chatRequests).toHaveLength(3)
      expect(upstreamToolNames).toEqual([
        expectedReviewerTools,
        expectedReviewerTools,
        expectedReviewerTools
      ])
      expect(JSON.stringify(chatRequests[1]?.messages)).toContain('audited evidence')
      expect(evidence.readTurn).toHaveBeenCalledOnce()
      expect(submitFindings).toHaveBeenCalledOnce()
      expect(submittedChecks).toEqual([])
      expect(permissionTools).toHaveLength(2)
      expect(JSON.stringify(permissionTools)).not.toMatch(/exec_command|local_shell|shell_command/)
      expect(JSON.stringify(result.updates)).not.toMatch(/exec_command|local_shell|shell_command/)
      expect(JSON.stringify(result.updates)).toContain('REVIEWER_BRIDGE_OK')
      expect(result.stopReason).toBe('end_turn')
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.join('')}`)
    } finally {
      await terminate(child)
      await bridge.close()
      await reviewerMcp.stop()
      await rm(tempRoot, { recursive: true, force: true })
    }
  },
  30_000
)
