import * as acp from '@agentclientprotocol/sdk'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { opencodeFramework } from '../agent-framework'
import { AcpAgentConnectionAdapter, type AcpAgentConnectionHooks } from './agent-connection-adapter'
import { AcpBackendGenerationOwner } from './backend-generation-owner'
import { AcpConnectionResourceOwner } from './connection-resource-owner'
import { AcpOpenCodeTurnAdapter } from './opencode-turn-adapter'
import { fetchOpenCodeUsageSnapshot } from './opencode-turn-usage'
import { buildOpenCodeHttpFollowUpBody, parseOpenCodeHttpFollowUp } from './native-follow-up'

const executablePath = process.env.OPENCODE_V2_TEST_PATH

// Real pinned CLI, app-generated configuration/plugin, locked ACP SDK and public HTTP API.
// The only external systems are deterministic loopback model/MCP fixtures; no account is used.
it.runIf(executablePath)(
  'preserves direct MCP approval, model-step usage and Send now with the OpenCode 2.x adapter',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-opencode-v2-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const modelRequests: Array<Record<string, unknown>> = []
    const toolCalls: unknown[] = []
    const mcpRequests: unknown[] = []
    const permissions: acp.RequestPermissionRequest[] = []
    const notifications: acp.SessionNotification[] = []
    let allow = true
    let releaseModel: (() => void) | undefined
    let modelBlocked: (() => void) | undefined
    let probe: Awaited<ReturnType<AcpOpenCodeTurnAdapter['begin']>> | undefined
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (request.url === '/mcp') {
        mcpRequests.push({ method: request.method, body })
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        if (body.id === undefined) {
          response.writeHead(202).end()
          return
        }
        let result: unknown = {}
        if (body.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1' }
          }
        if (body.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'notebook_state',
                description: 'Read test notebook state',
                inputSchema: {
                  type: 'object',
                  properties: { marker: { type: 'string' } },
                  required: ['marker']
                }
              }
            ]
          }
        if (body.method === 'tools/call') {
          toolCalls.push(body.params)
          result = { content: [{ type: 'text', text: 'SAFE_STATE' }] }
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
        return
      }
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      modelRequests.push(body)
      const text = JSON.stringify(body.messages)
      const title = text.includes('You name conversations')
      if (
        !title &&
        text.includes('BLOCK_ORIGINAL') &&
        !text.includes('STEER_ONCE') &&
        modelBlocked
      ) {
        const blocked = modelBlocked
        modelBlocked = undefined
        await new Promise<void>((resolve) => {
          releaseModel = resolve
          blocked()
        })
      }
      const tool = body.tools?.find((entry: { function: { name: string } }) =>
        entry.function.name.endsWith('_notebook_state')
      )
      const invoke =
        !title &&
        text.includes('CALL_TOOL') &&
        !body.messages.some((message: { role: string }) => message.role === 'tool')
      const message =
        invoke && tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_probe',
                  type: 'function',
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({ marker: 'safe' })
                  }
                }
              ]
            }
          : { role: 'assistant', content: 'PROBE_DONE' }
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 }
      }
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'probe',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [{ index: 0, message, finish_reason: 'stop' }],
            usage
          })
        )
        return
      }
      const delta =
        'tool_calls' in message
          ? { ...message, tool_calls: message.tool_calls!.map((call) => ({ index: 0, ...call })) }
          : message
      const chunk = (value: unknown, finish: string | null, tokens?: unknown): string =>
        `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }], ...(tokens ? { usage: tokens } : {}) })}\n\n`
      response
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(
          chunk(delta, null) +
            chunk({}, 'tool_calls' in message ? 'tool_calls' : 'stop', usage) +
            'data: [DONE]\n\n'
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        agentProviderId: 'probe',
        baseUrl: `${baseUrl}/v1`,
        apiEndpoints: ['chat-completions'],
        model: 'probe-model',
        key: 'local-only'
      },
      { storageRoot: root, executablePath: executablePath!, nativeVersion: '2.1.4' }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const owner = new AcpConnectionResourceOwner()
    const backendOwner = new AcpBackendGenerationOwner(opencodeFramework)
    const stderr: string[] = []
    const hooks: AcpAgentConnectionHooks = {
      createElicitation: async () => ({ action: 'decline' }),
      requestPermission: async (request) => {
        permissions.push(request)
        const option = request.options.find(
          (option) => option.kind === (allow ? 'allow_once' : 'reject_once')
        )
        return option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      },
      observeSessionUpdate: (notification) => {
        notifications.push(notification)
        probe?.observe?.(notification)
      },
      observeClaudeSdkMessage: vi.fn(),
      filesystem: { resolveSessionCwd: () => workspace, protectedReadRoots: () => [] },
      onBackendResolved: vi.fn(),
      onProcessSpawned: vi.fn(),
      onBackendPublished: vi.fn(),
      onProcessTreeReaped: vi.fn(),
      markProcessExitExpected: vi.fn(),
      onProcessStderr: (text) => {
        stderr.push(text)
      },
      onProcessError: vi.fn(),
      onProcessExit: vi.fn(),
      onConnectionClosed: () => owner.cleanupUnexpectedClose(owner.epoch),
      reportCleanupFailure: vi.fn(),
      reportProcessTreeError: vi.fn()
    }
    try {
      const ready = await owner.connect(async (attempt) => {
        const candidate = await new AcpAgentConnectionAdapter().open(
          {
            epoch: attempt.epoch,
            resolveBackend: async () => ({
              framework: opencodeFramework,
              executablePath: executablePath!,
              env: {
                ...config.env,
                OPENCODE_DISABLE_MODELS_FETCH: 'true',
                OPENCODE_DISABLE_AUTOUPDATE: 'true',
                OPENCODE_SERVER_USERNAME: 'legacy-user',
                OPENCODE_SERVER_PASSWORD: 'legacy-password'
              },
              args: [],
              opencodeMajorVersion: 2
            }),
            prepareBackend: (backend) => backendOwner.prepare(attempt, backend),
            isCurrent: () => owner.epoch === attempt.epoch,
            isShuttingDown: () => owner.isShuttingDown
          },
          hooks
        )
        const connection = candidate.transferTo(attempt)
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {}
        })
        return attempt.publish({ close: false, delete: false, resume: true, steering: false })
      })
      const api = backendOwner.openCodeUsageApi()!
      expect(api.version).toBe(2)
      const start = (): Promise<acp.NewSessionResponse> =>
        ready.connection.agent.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [
            { name: 'open_science_notebook', type: 'http', url: `${baseUrl}/mcp`, headers: [] }
          ]
        })
      const prompt = (sessionId: string, text: string): Promise<acp.PromptResponse> =>
        ready.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text }]
        })
      const session = await start()
      const contextUrl = `${api.baseUrl}/api/session/${session.sessionId}/context`
      for (const authorization of [
        undefined,
        `Basic ${Buffer.from('opencode:wrong-password').toString('base64')}`,
        `Basic ${Buffer.from('legacy-user:legacy-password').toString('base64')}`
      ]) {
        const response = await fetch(contextUrl, {
          headers: authorization ? { authorization } : {}
        })
        expect(response.status).toBe(401)
        await response.text()
      }
      const authenticated = await fetch(contextUrl, {
        headers: { authorization: api.authorization }
      })
      expect(authenticated.status).toBe(200)
      await authenticated.json()
      const adapter = new AcpOpenCodeTurnAdapter((id, cwd) =>
        fetchOpenCodeUsageSnapshot(api, id, cwd)
      )
      probe = await adapter.begin({ providerSessionId: session.sessionId, cwd: workspace })
      const result = await prompt(session.sessionId, 'CALL_TOOL')
      const usage = await probe.finalize({ response: result })
      expect(toolCalls).toHaveLength(1)
      expect(permissions).toHaveLength(1)
      expect(permissions[0].toolCall.rawInput).toEqual({ marker: 'safe' })
      expect(usage.modelTurnCount).toBe(2)
      expect(usage.turnUsage).toMatchObject({ inputTokens: 16, cacheTokens: 6, outputTokens: 14 })
      expect(usage.contextUsedTokens).toBe(11)
      allow = false
      const rejected = await start()
      await prompt(rejected.sessionId, 'CALL_TOOL')
      expect(permissions).toHaveLength(2)
      expect(toolCalls).toHaveLength(1)

      const steered = await start()
      const blocked = new Promise<void>((resolve) => {
        modelBlocked = resolve
      })
      const pending = prompt(steered.sessionId, 'BLOCK_ORIGINAL')
      await blocked
      const body = buildOpenCodeHttpFollowUpBody([{ type: 'text', text: 'STEER_ONCE' }], 2)
      const response = await fetch(`${api.baseUrl}/api/session/${steered.sessionId}/prompt`, {
        method: 'POST',
        headers: { authorization: api.authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      expect(response.ok).toBe(true)
      expect(
        parseOpenCodeHttpFollowUp(await response.json(), 'STEER_ONCE', 2, steered.sessionId)
      ).toBe(true)
      releaseModel!()
      await pending
      const steeredRequests = modelRequests.filter((request) => {
        const text = JSON.stringify(request.messages)
        return text.includes('BLOCK_ORIGINAL') && !text.includes('You name conversations')
      })
      expect(steeredRequests).toHaveLength(2)
      expect(JSON.stringify(steeredRequests[1].messages).match(/STEER_ONCE/g)).toHaveLength(1)
      expect(notifications.length).toBeGreaterThan(0)
    } catch (error) {
      throw new Error(
        `${String(error)}\n${stderr.join('').slice(-4000)}\n${JSON.stringify({ mcpRequests, modelRequests: modelRequests.map((request) => ({ model: request.model, tools: (request.tools as Array<{ function: { name: string } }>)?.map((tool) => tool.function.name) })), notifications, permissions })}`,
        { cause: error }
      )
    } finally {
      releaseModel?.()
      await owner.teardown(owner.epoch)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60_000
)
