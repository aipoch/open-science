import * as acp from '@agentclientprotocol/sdk'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createJournalAgentStore } from '@aipoch/agent-harness'
import { createHarnessAcpAgent, measureHarnessRequest } from './agent'
import { HARNESS_AUTH_METHOD, HARNESS_INSTRUCTIONS, HARNESS_OWNER } from './config'
import { AgentMcpHttpHost } from '../acp/mcp-http-host'
import { HARNESS_INVOCATION, HARNESS_RECEIPT_METHOD, receiptResponseSchema } from './tool-receipts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { harnessTurnAdapter } from '../acp/harness-turn-adapter'
import { toAcpRuntimeEvent } from '../acp/runtime-events'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each(['completed', 'failed', 'cancelled'] as const)(
  'publishes automatic compaction as the host %s lifecycle without leaking its summary',
  async (outcome) => {
    let summaryResponse: ServerResponse | undefined
    const model = await modelServer((body, response) => {
      if (
        JSON.stringify(body.messages.at(-1)).includes('Create a compact continuation checkpoint')
      ) {
        summaryResponse = response
        response.write(': summary pending\n\n')
      } else finish(response, 'answer')
    })
    const seed = await fixture(model.endpoint, undefined, true, 128000)
    const { sessionId } = await seed.connection.agent.request(acp.methods.agent.session.new, {
      cwd: seed.directory,
      mcpServers: []
    })
    for (const size of [35000, 5000, 5000, 5000])
      expect((await prompt(seed.connection, sessionId, 'x'.repeat(size))).stopReason).toBe(
        'end_turn'
      )
    await seed.connection.agent.request(acp.methods.agent.session.close, { sessionId })
    const f = await fixture(model.endpoint, seed.directory, true, 65536)
    await f.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: seed.directory,
      mcpServers: []
    })
    const running = prompt(f.connection, sessionId, 'continue '.repeat(900))
    // Observe rejection immediately, then inspect it after the terminal event has drained.
    const settled = running.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    const compactEvents = (): ReturnType<typeof toAcpRuntimeEvent>[] =>
      f.updates
        .map((notification, index) => toAcpRuntimeEvent(notification, String(index)))
        .filter((event) => event.kind === 'compaction')
    await vi.waitFor(() => {
      expect(summaryResponse).toBeDefined()
      expect(compactEvents()).toMatchObject([
        { status: 'in_progress', compactionReason: 'automatic' }
      ])
    })
    const other = await f.connection.agent.request(acp.methods.agent.session.new, {
      cwd: seed.directory,
      mcpServers: []
    })
    expect((await prompt(f.connection, other.sessionId, 'hello')).stopReason).toBe('end_turn')
    if (outcome === 'cancelled')
      await f.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    else
      finish(
        summaryResponse!,
        outcome === 'failed'
          ? 'PRIVATE INVALID SUMMARY'
          : '## Goal\nContinue.\n## Progress\nPRIVATE SUMMARY.\n## Evidence\nRetained.\n## Next\nContinue.'
      )
    const result = await settled
    if (outcome === 'failed') expect(result).toHaveProperty('error')
    else
      expect(result).toMatchObject({
        value: { stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn' }
      })
    const events = compactEvents()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      sessionId,
      status: outcome,
      toolCallId: events[0].toolCallId
    })
    expect(JSON.stringify(f.updates)).not.toContain('PRIVATE')
    expect(f.approvals).toHaveLength(0)
    const state = await createJournalAgentStore({
      directory: join(f.directory, 'checkpoints')
    }).load(sessionId)
    expect(state!.compactions).toHaveLength(outcome === 'completed' ? 1 : 0)
    // Summary usage remains in accounting, but never produces a context usage notification.
    const usage = f.updates.filter(
      (n) => n.sessionId === sessionId && n.update.sessionUpdate === 'usage_update'
    )
    expect(usage).toHaveLength(outcome === 'completed' ? 1 : 0)
  }
)
type WireRequest = {
  messages: { role: string; content?: unknown }[]
  tools?: { function: { name: string } }[]
}

it('retrieves a large MCP result through the session reader with no repeated effect or extra permission', async () => {
  const original = 'x'.repeat(30000) + 'EXACT_MIDDLE=42' + 'y'.repeat(30000)
  const managed = await mcpServer(false, undefined, false, original)
  let step = 0
  const model = await modelServer((body, response) => {
    step++
    if (step === 1) finish(response, '', body.tools![0].function.name)
    else if (step === 2) {
      const content = String(body.messages.at(-1)?.content)
      expect(content).not.toContain('EXACT_MIDDLE=42')
      const reference = /invocationId=("[^"\n]+")/.exec(content)
      expect(reference).not.toBeNull()
      finish(response, '', 'read_tool_result', {
        invocationId: JSON.parse(reference![1]),
        offset: 30000,
        limit: 32
      })
    } else {
      expect(String(body.messages.at(-1)?.content)).toContain('EXACT_MIDDLE=42')
      finish(response, 'done')
    }
  })
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  expect((await prompt(f.connection, sessionId)).stopReason).toBe('end_turn')
  expect(managed.calls).toEqual(['append'])
  expect(f.approvals).toHaveLength(1)
  expect(step).toBe(3)
  const state = await createJournalAgentStore({ directory: join(f.directory, 'checkpoints') }).load(
    sessionId
  )
  const result = state!.messages.find((message) => message.role === 'tool')!
  expect(result.content).toEqual([{ type: 'text', text: original }])
  expect(JSON.stringify(result.modelContent)).not.toContain('EXACT_MIDDLE=42')
})
async function modelServer(
  reply?: (body: WireRequest, response: ServerResponse) => void
): Promise<{ endpoint: string; requests: WireRequest[] }> {
  const requests: WireRequest[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest
    requests.push(body)
    expect(request.headers.authorization).toBe('Bearer local-test-token')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (reply) reply(body, response)
    else finish(response, 'answer')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
  })
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    requests
  }
}
function finish(
  response: ServerResponse,
  text: string,
  tool?: string,
  args: unknown = { value: 1 }
): void {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: tool, arguments: JSON.stringify(args) }
          }
        ]
      }
    : { content: text }
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } })}\n\ndata: [DONE]\n\n`
  )
}
async function fixture(
  endpoint: string,
  existing?: string,
  allow = true,
  contextWindow = 32768,
  inputCapabilities?: { images?: boolean; files?: boolean; audio?: boolean; video?: boolean }
): Promise<{
  directory: string
  owner: ReturnType<typeof createHarnessAcpAgent>
  connection: acp.ClientConnection
  initialization: { agentCapabilities?: { promptCapabilities?: { audio?: boolean } } }
  updates: acp.SessionNotification[]
  approvals: acp.RequestPermissionRequest[]
}> {
  const directory = existing ?? (await mkdtemp(join(tmpdir(), 'harness-acp-')))
  if (!existing) cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const owner = createHarnessAcpAgent(directory)
  const updates: acp.SessionNotification[] = [],
    approvals: acp.RequestPermissionRequest[] = []
  const connection = acp
    .client({ name: 'host-test' })
    .onNotification(acp.methods.client.session.update, (context) => {
      updates.push(context.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) => {
      expect(
        updates.some(
          ({ sessionId, update }) =>
            sessionId === context.params.sessionId &&
            update.sessionUpdate === 'tool_call' &&
            update.toolCallId === context.params.toolCall.toolCallId &&
            update.title === context.params.toolCall.title
        )
      ).toBe(true)
      approvals.push(context.params)
      return { outcome: { outcome: 'selected', optionId: allow ? 'allow' : 'deny' } }
    })
    .connect(owner.app)
  cleanup.push(async () => {
    connection.close()
    await owner.dispose()
  })
  const initialization = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  })
  expect(initialization.agentInfo?.name).toBe('open-science-agent')
  expect(initialization.authMethods).toEqual([
    { id: HARNESS_AUTH_METHOD, name: 'Open-Science Agent' }
  ])
  await connection.agent.request(acp.methods.agent.authenticate, {
    methodId: HARNESS_AUTH_METHOD,
    _meta: {
      'open-science-agent': {
        endpoint,
        protocol: endpoint.endsWith('/messages')
          ? 'messages'
          : endpoint.endsWith('/responses')
            ? 'responses'
            : 'chat-completions',
        sessionHeader: 'x-opencode-session',
        token: 'local-test-token',
        model: 'test',
        modelIdentity: 'provider:test',
        contextWindow,
        inputCapabilities,
        maxOutputTokens: 1024
      }
    }
  })
  return { directory, owner, connection, initialization, updates, approvals }
}

it('does not advertise audio before the authenticated protocol is known', async () => {
  const model = await modelServer()
  const f = await fixture(model.endpoint)
  expect(f.initialization.agentCapabilities?.promptCapabilities?.audio).toBe(false)
})

const prompt = (
  connection: acp.ClientConnection,
  sessionId: string,
  text = 'do the task'
): Promise<acp.PromptResponse> =>
  connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text }]
  })
async function mcpServer(
  disconnectAfterCall = false,
  waitForCall?: Promise<void>,
  image = false,
  outputText = 'receipt'
): Promise<{ config: acp.McpServer; calls: string[] }> {
  const calls: string[] = []
  const http = createServer(async (request, response) => {
    const server = new Server({ name: 'managed', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'append',
          description: 'Append a receipt',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false
          }
        }
      ]
    }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params.name)
      await waitForCall
      if (disconnectAfterCall) response.destroy()
      return {
        content: image
          ? [{ type: 'image', mimeType: 'image/png', data: 'AA==' }]
          : [{ type: 'text', text: outputText }]
      }
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  cleanup.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r())))
  })
  return {
    config: {
      type: 'http',
      name: 'managed',
      url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
      headers: []
    },
    calls
  }
}

it('keeps streamed chunks in one message per request and separates reasoning and later turns', async () => {
  const model = await modelServer((_body, response) => {
    for (const delta of [{ reasoning_content: 'think' }, { content: 'FIT' }, { content: '_DATA' }])
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`)
    finish(response, '_OK')
  })
  const a = await fixture(model.endpoint)
  const { sessionId } = await a.connection.agent.request(acp.methods.agent.session.new, {
    cwd: a.directory,
    mcpServers: []
  })
  const requestIds = new Set<string>()
  for (let turn = 0; turn < 2; turn++) {
    const response = await prompt(a.connection, sessionId)
    const receipts = response._meta?.['open-science-agent/requests'] as { id: string }[]
    expect(receipts).toHaveLength(1)
    expect(requestIds.has(receipts[0].id)).toBe(false)
    requestIds.add(receipts[0].id)
    const probe = await harnessTurnAdapter.begin({ providerSessionId: sessionId, cwd: a.directory })
    expect(await probe.finalize({ response })).toMatchObject({
      modelTurnCount: 1,
      turnUsage: { inputTokens: 60, cacheTokens: 40, outputTokens: 10 }
    })
  }
  const messages = a.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' ? [update] : []
  )
  expect(messages).toHaveLength(6)
  for (const chunks of [messages.slice(0, 3), messages.slice(3)]) {
    expect(chunks[0].messageId).toEqual(expect.any(String))
    expect(new Set(chunks.map((chunk) => chunk.messageId)).size).toBe(1)
    expect(
      chunks.map((chunk) => (chunk.content.type === 'text' ? chunk.content.text : '')).join('')
    ).toBe('FIT_DATA_OK')
  }
  expect(messages[0].messageId).not.toBe(messages[3].messageId)
  const thoughts = a.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_thought_chunk' ? [update.messageId] : []
  )
  expect(thoughts).toHaveLength(2)
  expect(new Set([...thoughts, messages[0].messageId, messages[3].messageId]).size).toBe(4)
})

it('uses the package across turns and resumes durable history without replay duplication', async () => {
  const model = await modelServer()
  const a = await fixture(model.endpoint)
  const created = await a.connection.agent.request(acp.methods.agent.session.new, {
    cwd: a.directory,
    mcpServers: [],
    _meta: { [HARNESS_INSTRUCTIONS]: 'Stable host instructions' }
  })
  const result = await prompt(a.connection, created.sessionId, 'keep this fact')
  expect(result.stopReason).toBe('end_turn')
  const probe = await harnessTurnAdapter.begin({
    providerSessionId: created.sessionId,
    cwd: a.directory
  })
  expect(await probe.finalize({ response: result })).toMatchObject({
    modelTurnCount: 1,
    turnUsage: { inputTokens: 60, cacheTokens: 40, outputTokens: 10 }
  })
  expect(a.updates.some((n) => n.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
  await a.connection.agent.request(acp.methods.agent.session.close, {
    sessionId: created.sessionId
  })
  const b = await fixture(model.endpoint, a.directory)
  await b.connection.agent.request(acp.methods.agent.session.resume, {
    sessionId: created.sessionId,
    cwd: a.directory,
    mcpServers: [],
    _meta: { [HARNESS_INSTRUCTIONS]: 'Stable host instructions' }
  })
  await prompt(b.connection, created.sessionId, 'continue')
  expect(model.requests[1].messages.filter((m) => m.role === 'user')).toHaveLength(2)
  expect(model.requests[0].messages[0]).toEqual(model.requests[1].messages[0])
  await expect(
    b.connection.agent.request(acp.methods.agent.session.fork, {
      sessionId: created.sessionId,
      cwd: a.directory
    })
  ).rejects.toThrow()
})

it('reports missing MCP fields without reflecting input values and recovers on the next step', async () => {
  const managed = await mcpServer()
  let requests = 0
  const model = await modelServer((body, response) => {
    requests++
    if (requests === 1)
      finish(response, '', body.tools![0].function.name, { private: 'do-not-reflect-this' })
    else if (requests === 2) {
      const diagnostic = JSON.stringify(body.messages.at(-1))
      expect(diagnostic).toContain('$.value: expected required field')
      expect(diagnostic).not.toContain('do-not-reflect-this')
      finish(response, '', body.tools![0].function.name, { value: 1 })
    } else finish(response, 'done')
  })
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  expect((await prompt(f.connection, sessionId)).stopReason).toBe('end_turn')
  expect(requests).toBe(3)
  expect(managed.calls).toEqual(['append'])
  expect(f.approvals).toHaveLength(1)
  expect(model.requests[1].tools).toEqual(model.requests[0].tools)
  expect(model.requests[2].tools).toEqual(model.requests[0].tools)
})

it.each([true, false])('routes MCP through host permission, allow=%s', async (allow) => {
  const managed = await mcpServer()
  const model = await modelServer((body, response) => {
    if (body.messages.at(-1)?.role === 'tool') finish(response, 'done')
    else finish(response, '', body.tools![0].function.name)
  })
  const f = await fixture(model.endpoint, undefined, allow)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  const result = await prompt(f.connection, sessionId)
  expect(result.stopReason).toBe('end_turn')
  expect(f.approvals).toHaveLength(1)
  expect(f.approvals[0].toolCall.title).toBe('mcp__managed__append')
  expect(f.approvals[0].toolCall._meta?.toolName).toBe('mcp__managed__append')
  expect(
    f.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'tool_call' &&
        update.toolCallId === f.approvals[0].toolCall.toolCallId &&
        update._meta?.toolName === 'mcp__managed__append'
    )
  ).toBe(true)
  expect(managed.calls).toHaveLength(allow ? 1 : 0)
  const facts = await (
    await harnessTurnAdapter.begin({ providerSessionId: sessionId, cwd: f.directory })
  ).finalize({ response: result })
  expect(facts).toMatchObject({
    modelTurnCount: 2,
    turnUsage: { inputTokens: 120, cacheTokens: 80, outputTokens: 20 }
  })
  const checkpoint = await createJournalAgentStore({
    directory: join(f.directory, 'checkpoints')
  }).load(sessionId)
  expect(checkpoint!.pending).toEqual([])
  expect(checkpoint!.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
})

it('delivers queued observations before requesting MCP permission on a slow transport', async () => {
  const notify = acp.AgentContext.prototype.notify
  const delayed = vi.spyOn(acp.AgentContext.prototype, 'notify').mockImplementation(async function (
    this: acp.AgentContext,
    ...args
  ) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return notify.apply(this, args)
  })
  try {
    const managed = await mcpServer()
    const model = await modelServer((body, response) => {
      if (body.messages.at(-1)?.role === 'tool') finish(response, 'done')
      else {
        for (let i = 0; i < 5; i++)
          response.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'thinking' } }] })}\n\n`
          )
        finish(response, '', body.tools![0].function.name)
      }
    })
    const f = await fixture(model.endpoint)
    const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
      cwd: f.directory,
      mcpServers: [managed.config]
    })
    await prompt(f.connection, sessionId)
    expect(f.approvals).toHaveLength(1)
    expect(managed.calls).toEqual(['append'])
  } finally {
    delayed.mockRestore()
  }
})

it('does not request permission or execute MCP when its observation cannot be delivered', async () => {
  const managed = await mcpServer()
  const model = await modelServer((body, response) =>
    finish(response, '', body.tools![0].function.name)
  )
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  const failed = vi
    .spyOn(acp.AgentContext.prototype, 'notify')
    .mockRejectedValue(new Error('transport unavailable'))
  try {
    await expect(prompt(f.connection, sessionId)).rejects.toThrow()
    expect(f.approvals).toEqual([])
    expect(managed.calls).toEqual([])
  } finally {
    failed.mockRestore()
  }
})

it('preserves full MCP identity when model tool names exceed 64 characters', async () => {
  const managed = await mcpServer()
  managed.config.name = 'connector_' + 'long_name_'.repeat(7)
  const canonical = `mcp__${managed.config.name}__append`
  const model = await modelServer((body, response) => {
    if (body.messages.at(-1)?.role === 'tool') finish(response, 'done')
    else {
      expect(body.tools![0].function.name.length).toBeLessThanOrEqual(64)
      finish(response, '', body.tools![0].function.name)
    }
  })
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  await prompt(f.connection, sessionId)
  expect(f.approvals).toHaveLength(1)
  expect(f.approvals[0].toolCall.title).toBe(canonical)
  expect(managed.calls).toEqual(['append'])
})

it('cancels an active model stream, drains it, and admits another turn', async () => {
  let response: ServerResponse | undefined
  const model = await modelServer((_body, res) => {
    response = res
    res.write(': keepalive\n\n')
  })
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: []
  })
  const running = prompt(f.connection, sessionId)
  await vi.waitFor(() => expect(response).toBeDefined())
  await expect(prompt(f.connection, sessionId)).rejects.toThrow()
  await f.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  expect((await running).stopReason).toBe('cancelled')
  response = undefined
  const next = prompt(f.connection, sessionId)
  await vi.waitFor(() => expect(response).toBeDefined())
  finish(response!, 'recovered')
  expect((await next).stopReason).toBe('end_turn')
})

it('acknowledges cancellation during an MCP effect without replaying its uncertain receipt', async () => {
  let release!: () => void
  const managed = await mcpServer(
    false,
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const model = await modelServer((body, response) =>
    finish(response, '', body.tools![0].function.name)
  )
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  try {
    const running = prompt(f.connection, sessionId)
    await vi.waitFor(() => expect(managed.calls).toHaveLength(1))
    await f.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    expect((await running).stopReason).toBe('cancelled')
    const checkpoint = await createJournalAgentStore({
      directory: join(f.directory, 'checkpoints')
    }).load(sessionId)
    expect(checkpoint?.run?.status).toBe('blocked')
    expect(checkpoint?.pending.some((entry) => entry.status === 'unknown')).toBe(true)
    await expect(prompt(f.connection, sessionId)).rejects.toThrow()
    expect(managed.calls).toHaveLength(1)
    expect(model.requests).toHaveLength(1)
  } finally {
    release()
  }
})

it('rejects duplicate authentication, unsupported MCP and changed resume workspace', async () => {
  const model = await modelServer()
  const f = await fixture(model.endpoint)
  await expect(
    f.connection.agent.request(acp.methods.agent.authenticate, {
      methodId: HARNESS_AUTH_METHOD,
      _meta: {}
    })
  ).rejects.toThrow()
  await expect(
    f.connection.agent.request(acp.methods.agent.session.new, {
      cwd: f.directory,
      mcpServers: [{ name: 'unmanaged', command: 'sh', args: [], env: [] }]
    })
  ).rejects.toThrow()
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: []
  })
  await f.connection.agent.request(acp.methods.agent.session.close, { sessionId })
  await expect(
    f.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: tmpdir(),
      mcpServers: []
    })
  ).rejects.toThrow()
  expect(model.requests).toHaveLength(0)
})

it('counts full request bytes including schemas and non-ASCII content', () => {
  const request = {
    requestId: 'r',
    instructions: '中文',
    messages: [],
    tools: [],
    maxOutputTokens: 12
  }
  expect(measureHarnessRequest(request)).toBe(Buffer.byteLength(JSON.stringify(request)) + 1024)
})

it('does not retry an MCP side effect after its response connection is lost', async () => {
  const managed = await mcpServer(true)
  const model = await modelServer((body, response) =>
    finish(response, '', body.tools![0].function.name)
  )
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: [managed.config]
  })
  await expect(prompt(f.connection, sessionId)).rejects.toThrow(
    'Built-in Agent tool outcome is unknown:'
  )
  const checkpoint = await createJournalAgentStore({
    directory: join(f.directory, 'checkpoints')
  }).load(sessionId)
  expect(checkpoint!.pending).toHaveLength(1)
  expect(checkpoint!.pending[0].status).toBe('unknown')
  await expect(prompt(f.connection, sessionId, 'try again')).rejects.toThrow(
    'Built-in Agent tool outcome is unknown:'
  )
  expect(managed.calls).toEqual(['append'])
  expect(model.requests).toHaveLength(1)
})

it('closes an active session before acknowledging release and rejects further prompts', async () => {
  let response: ServerResponse | undefined
  const model = await modelServer((_body, res) => {
    response = res
    res.write(': keepalive\n\n')
  })
  const f = await fixture(model.endpoint)
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: []
  })
  const running = prompt(f.connection, sessionId)
  await vi.waitFor(() => expect(response).toBeDefined())
  await f.connection.agent.request(acp.methods.agent.session.close, { sessionId })
  expect((await running).stopReason).toBe('cancelled')
  await vi.waitFor(() => expect(response!.destroyed).toBe(true))
  await expect(prompt(f.connection, sessionId)).rejects.toThrow()
  await f.owner.dispose()
  await expect(
    f.connection.agent.request(acp.methods.agent.session.new, {
      cwd: f.directory,
      mcpServers: []
    })
  ).rejects.toThrow()
})

it.each(['notebook', 'plan'] as const)(
  'recovers a lost %s receipt after helper reattachment without executing twice',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'host-tool-recovery-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let executions = 0
    const rpc = createServer(async (request, response) => {
      for await (const chunk of request) {
        void chunk // Drain the fixture request before replying.
      }
      executions++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          result:
            kind === 'notebook'
              ? { status: 'completed', runId: 'effect-1', stdout: 'RECOVERED_EFFECT' }
              : {
                  changed: true,
                  projection: {
                    approval: 'approved',
                    lifecycle: 'approved',
                    revision: 1,
                    artifactVersionId: 'version'
                  },
                  planContext: 'RECOVERED_EFFECT'
                }
        })
      )
    })
    rpc.listen(0, '127.0.0.1')
    await once(rpc, 'listening')
    cleanup.push(async () => {
      rpc.closeAllConnections()
      await new Promise<void>((resolve) => rpc.close(() => resolve()))
    })
    const host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
    const connection = await host.ensureStarted()
    cleanup.push(() => host.close())
    const environment = {
      endpoint: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`,
      token: 'rpc-token',
      projectId: 'project',
      sessionId: 'app-session',
      workspaceCwd: root
    }
    const register = (route: string): void => {
      if (kind === 'notebook') host.registerNotebook(route, environment)
      else host.registerPlan(route, environment)
      host.registerReceiptScope(route, 'app-session', kind)
    }
    register('old-route')
    const toolName = kind === 'notebook' ? 'repl_execute' : 'generate_plan'
    const argumentsForTool = kind === 'notebook' ? { code: 'return 1' } : { approve: true }
    let route = 'old-route',
      lost = false
    const proxy = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      const parsed = body ? JSON.parse(body) : undefined
      const upstream = await fetch(host.urlFor(kind, route), {
        method: request.method,
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        ...(body ? { body } : {})
      })
      const value = await upstream.text()
      if (parsed?.method === 'tools/call' && !lost) {
        lost = true
        response.destroy()
        return
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json'
      })
      response.end(value)
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    cleanup.push(async () => {
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    })
    const mcp: acp.McpServer = {
      type: 'http',
      name: kind,
      url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`,
      headers: []
    }
    const model = await modelServer((body, response) => {
      if (JSON.stringify(body.messages).includes('RECOVERED_EFFECT'))
        finish(response, 'Recovered without replay')
      else
        finish(
          response,
          '',
          body.tools!.find((tool) => tool.function.name.endsWith(`__${toolName}`))!.function.name,
          argumentsForTool
        )
    })
    const a = await fixture(model.endpoint, undefined, true, 262144)
    const { sessionId } = await a.connection.agent.request(acp.methods.agent.session.new, {
      cwd: a.directory,
      mcpServers: [mcp]
    })
    await expect(prompt(a.connection, sessionId)).rejects.toThrow()
    const store = createJournalAgentStore({ directory: join(a.directory, 'checkpoints') })
    expect((await store.load(sessionId))?.pending[0].status).toBe('unknown')
    expect(executions).toBe(1)
    await a.connection.agent.request(acp.methods.agent.session.close, { sessionId })
    host.unregister('old-route')
    route = 'new-route'
    register(route)
    const b = await fixture(model.endpoint, a.directory, true, 262144)
    await b.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: a.directory,
      mcpServers: [mcp]
    })
    host.registerReceiptScope(route, 'other-session', kind)
    await expect(
      prompt(b.connection, sessionId, 'Continue without matching evidence')
    ).rejects.toThrow()
    expect(executions).toBe(1)
    expect(model.requests).toHaveLength(1)
    expect((await store.load(sessionId))?.pending[0].status).toBe('unknown')
    host.registerReceiptScope(route, 'app-session', kind)
    expect(
      (await prompt(b.connection, sessionId, 'Continue the interrupted task')).stopReason
    ).toBe('end_turn')
    expect(executions).toBe(1)
    expect((await store.load(sessionId))?.pending).toEqual([])
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests[1].messages)).toContain('RECOVERED_EFFECT')
    const client = new Client({ name: 'receipt-check', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor(kind, route)), {
        requestInit: { headers: { authorization: `Bearer ${connection.token}` } }
      })
    )
    try {
      const query = {
        invocationId: 'duplicate-check',
        name: toolName,
        arguments: argumentsForTool
      }
      await client.callTool({
        name: query.name,
        arguments: query.arguments,
        _meta: { [HARNESS_INVOCATION]: query.invocationId }
      })
      await expect(
        client.callTool({
          name: query.name,
          arguments: query.arguments,
          _meta: { [HARNESS_INVOCATION]: query.invocationId }
        })
      ).rejects.toThrow()
      expect(executions).toBe(2)
      expect(
        (
          await client.request(
            { method: HARNESS_RECEIPT_METHOD, params: query },
            receiptResponseSchema
          )
        ).status
      ).toBe('completed')
      host.registerReceiptScope(route, 'other-session', kind)
      expect(
        (
          await client.request(
            { method: HARNESS_RECEIPT_METHOD, params: query },
            receiptResponseSchema
          )
        ).status
      ).toBe('unknown')
      host.unregister(route)
      await expect(
        client.request({ method: HARNESS_RECEIPT_METHOD, params: query }, receiptResponseSchema)
      ).rejects.toThrow()
    } finally {
      await client.close()
    }
  }
)

it.each([false, true])('retains storage ownership across resume, legacy=%s', async (legacy) => {
  const model = await modelServer()
  const a = await fixture(model.endpoint)
  const owner = { projectId: 'project', sessionId: 'application-session' }
  const { sessionId } = await a.connection.agent.request(acp.methods.agent.session.new, {
    cwd: a.directory,
    mcpServers: [],
    ...(!legacy ? { _meta: { [HARNESS_OWNER]: owner } } : {})
  })
  await prompt(a.connection, sessionId)
  await a.connection.agent.request(acp.methods.agent.session.close, { sessionId })
  const b = await fixture(model.endpoint, a.directory)
  const resume = (identity: typeof owner): Promise<acp.ResumeSessionResponse> =>
    b.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: a.directory,
      mcpServers: [],
      _meta: { [HARNESS_OWNER]: identity }
    })
  if (!legacy) await expect(resume({ ...owner, projectId: 'other' })).rejects.toThrow()
  await resume(owner)
  expect(JSON.parse(await readFile(join(a.directory, `${sessionId}.json`), 'utf8')).owner).toEqual(
    owner
  )
  await b.connection.agent.request(acp.methods.agent.session.close, { sessionId })
  await expect(resume({ ...owner, sessionId: 'other' })).rejects.toThrow()
  expect(model.requests).toHaveLength(1)
})

it.each(['messages', 'responses'] as const)(
  'runs native %s image/tool/permission and stable session headers through ACP',
  async (protocol) => {
    const managed = await mcpServer(false, undefined, true)
    const received: Record<string, unknown>[] = []
    const headers: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      received.push(body)
      headers.push(String(request.headers['x-opencode-session']))
      expect(request.headers['user-agent']).toBe('open-science-agent/0.1.0')
      expect(request.headers[protocol === 'messages' ? 'x-api-key' : 'authorization']).toBe(
        protocol === 'messages' ? 'local-test-token' : 'Bearer local-test-token'
      )
      const tool = (body.tools as { name: string }[])[0].name
      const first = received.length === 1
      const events =
        protocol === 'messages'
          ? [
              ...(first
                ? [
                    {
                      type: 'content_block_start',
                      content_block: { type: 'tool_use', id: 'native_call', name: tool, input: {} }
                    },
                    {
                      type: 'content_block_delta',
                      delta: { type: 'input_json_delta', partial_json: '{"value":1}' }
                    },
                    { type: 'content_block_stop' }
                  ]
                : [
                    {
                      type: 'content_block_delta',
                      delta: { type: 'text_delta', text: 'native done' }
                    }
                  ]),
              {
                type: 'message_delta',
                delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
                usage: { output_tokens: 3 }
              },
              { type: 'message_stop' }
            ]
          : [
              ...(first
                ? [
                    {
                      type: 'response.output_item.done',
                      item: {
                        type: 'function_call',
                        call_id: 'native_call',
                        name: tool,
                        arguments: '{"value":1}'
                      }
                    }
                  ]
                : [{ type: 'response.output_text.delta', delta: 'native done' }]),
              {
                type: 'response.completed',
                response: { usage: { input_tokens: 5, output_tokens: 3 } }
              }
            ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const f = await fixture(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/${protocol}`
    )
    const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
      cwd: f.directory,
      mcpServers: [managed.config]
    })
    const result = await f.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: 'text', text: 'inspect' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' }
      ]
    })
    expect(result.stopReason).toBe('end_turn')
    expect(managed.calls).toEqual(['append'])
    expect(f.approvals).toHaveLength(1)
    expect(headers).toEqual([sessionId, sessionId])
    expect(received).toHaveLength(2)
    const image =
      protocol === 'messages'
        ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
        : { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
    const history = received[1][protocol === 'messages' ? 'messages' : 'input'] as Record<
      string,
      unknown
    >[]
    expect(JSON.stringify(history[0])).toContain(JSON.stringify(image))
    expect(history.at(-1)).toMatchObject(
      protocol === 'messages'
        ? {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'native_call', content: [image] }]
          }
        : { type: 'function_call_output', call_id: 'native_call', output: [image] }
    )
  }
)

it('carries native PDF, audio and explicitly supported video across the ACP host boundary', async () => {
  const model = await modelServer()
  const f = await fixture(model.endpoint, undefined, true, 32768, { video: true })
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: []
  })
  await f.connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [
      { type: 'text', text: 'Inspect these inputs' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
      {
        type: 'resource',
        resource: { uri: 'memory:document', mimeType: 'application/pdf', blob: 'AA==' }
      },
      { type: 'resource', resource: { uri: 'memory:clip', mimeType: 'video/mp4', blob: 'AA==' } }
    ]
  })
  expect(model.requests).toHaveLength(1)
  expect(model.requests[0].messages.at(-1)?.content).toEqual([
    { type: 'text', text: 'Inspect these inputs' },
    { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } },
    {
      type: 'file',
      file: { file_data: 'data:application/pdf;base64,AA==', filename: 'document.pdf' }
    },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AA==' } }
  ])
})

it('rejects model-disabled media before provider I/O and allows a subsequent text turn', async () => {
  const model = await modelServer()
  const f = await fixture(model.endpoint, undefined, true, 32768, { audio: false })
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, {
    cwd: f.directory,
    mcpServers: []
  })
  await expect(
    f.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'audio', mimeType: 'audio/wav', data: 'AA==' }]
    })
  ).rejects.toThrow()
  expect(model.requests).toHaveLength(0)
  await prompt(f.connection, sessionId)
  expect(model.requests).toHaveLength(1)
})
