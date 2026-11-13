import * as acp from '@agentclientprotocol/sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'

import { createOpenCodeCompactionStream } from './opencode-compaction-stream'

// The provider fixture runs in a separate Node process. Its ACP responses do not depend on the
// metadata HTTP service, matching the two independent transports used by OpenCode 1.x.
const agentFixture = String.raw`
  import { createInterface } from 'node:readline'
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
  let nextSession = 0
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      return
    }
    if (request.method === 'session/new') {
      send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-' + ++nextSession } })
      return
    }
    if (request.method !== 'session/prompt') return
    const command = JSON.parse(request.params.prompt[0].text)
    if (command.exit) process.exit(0)
    for (const chunk of command.chunks) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: chunk.thought ? 'agent_thought_chunk' : 'agent_message_chunk',
          messageId: chunk.messageId, content: { type: 'text', text: chunk.text } }
      } })
    }
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
  })
`

type FixtureChunk = { messageId: string; text: string; thought?: boolean }
type NativeMessage = {
  sessionId: string
  messageId: string
  partId?: string
  summary?: boolean
  failure?: 'timeout-once' | 'http' | 'finish'
}

type Fixture = {
  connection: acp.ClientConnection
  notifications: acp.SessionNotification[]
  requests: Map<string, number>
  messages: Map<string, NativeMessage>
  closed: () => boolean
  startSession: () => Promise<string>
  prompt: (sessionId: string, chunks: FixtureChunk[]) => Promise<acp.PromptResponse>
  stopTransport: (sessionId: string) => Promise<acp.PromptResponse>
  dispose: () => Promise<void>
}

const closeServer = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

const startFixture = async (): Promise<Fixture> => {
  const messages = new Map<string, NativeMessage>()
  const requests = new Map<string, number>()
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://localhost')
      const segments = url.pathname.split('/')
      const sessionId = segments[2]
      const messageId = segments[4]
      const key = `${sessionId}:${messageId ?? 'history'}`
      const attempt = (requests.get(key) ?? 0) + 1
      requests.set(key, attempt)
      const message = messageId
        ? messages.get(`${sessionId}:${messageId}`)
        : [...messages.values()].find((entry) => entry.sessionId === sessionId && entry.partId)
      if (!message) {
        response.writeHead(404).end()
        return
      }
      if (message.failure === 'timeout-once' && attempt === 1) await delay(2_200)
      if (message.failure === 'http' || (message.failure === 'finish' && attempt > 1)) {
        response.writeHead(503).end('PRIVATE_METADATA_BODY_AND_PATH')
        return
      }
      const native = {
        info: {
          sessionID: sessionId,
          id: message.messageId,
          role: 'assistant',
          summary: message.summary ?? false,
          ...(message.failure === 'finish' ? {} : { finish: 'stop' })
        },
        parts: message.partId ? [{ id: message.partId }] : []
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(messageId ? native : [native]))
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--input-type=module', '-e', agentFixture],
    { stdio: 'pipe', windowsHide: true }
  )
  child.stderr.resume()
  const childExited = once(child, 'exit')
  const abort = new AbortController()
  const notifications: acp.SessionNotification[] = []
  const connection = acp
    .client({ name: 'compaction-regression' })
    .onNotification(acp.methods.client.session.update, (context) => {
      notifications.push(context.params)
    })
    .connect(
      createOpenCodeCompactionStream(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        ),
        {
          api: {
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            authorization: 'Basic local-only'
          },
          resolveSessionCwd: () => '/workspace',
          signal: abort.signal
        }
      )
    )
  let closed = false
  void connection.closed.then(() => {
    closed = true
  })
  const dispose = async (): Promise<void> => {
    abort.abort()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await childExited
    await connection.closed
    await closeServer(server)
  }
  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {}
    })
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    connection,
    notifications,
    requests,
    messages,
    closed: () => closed,
    startSession: async () => {
      const session = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: []
      })
      return session.sessionId
    },
    prompt: (sessionId, chunks) =>
      connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: JSON.stringify({ chunks }) }]
      }),
    stopTransport: (sessionId) =>
      connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: JSON.stringify({ exit: true }) }]
      }),
    dispose
  }
}

it('keeps 300 ACP turns connected across metadata timeout and request-local failure', async () => {
  const fixture = await startFixture()
  try {
    const sessionId = await fixture.startSession()
    const otherSessionId = await fixture.startSession()
    for (let turn = 1; turn <= 300; turn += 1) {
      const messageId = `msg_${turn}`
      fixture.messages.set(`${sessionId}:${messageId}`, {
        sessionId,
        messageId,
        ...(turn === 80 ? { failure: 'timeout-once' } : {}),
        ...(turn === 81 ? { failure: 'http' } : {})
      })
      if (turn === 81) {
        const failed = fixture.prompt(sessionId, [
          { messageId, text: 'PRIVATE_UNKNOWN_REPLY' },
          { messageId: 'msg_withheld', text: 'PRIVATE_LATER_REPLY', thought: true }
        ])
        const rejection = expect(failed).rejects.toMatchObject({
          code: -32603,
          message: expect.stringContaining('OpenCode message classification failed'),
          data: undefined
        })
        fixture.messages.set(`${otherSessionId}:msg_other`, {
          sessionId: otherSessionId,
          messageId: 'msg_other'
        })
        await expect(
          fixture.prompt(otherSessionId, [{ messageId: 'msg_other', text: 'Other Session reply' }])
        ).resolves.toMatchObject({ stopReason: 'end_turn' })
        await rejection
        expect(fixture.closed()).toBe(false)
        fixture.messages.set(`${sessionId}:${messageId}`, { sessionId, messageId })
        await expect(
          fixture.prompt(sessionId, [{ messageId, text: 'Recovered metadata reply' }])
        ).resolves.toMatchObject({ stopReason: 'end_turn' })
        continue
      }
      await expect(
        fixture.prompt(sessionId, [{ messageId, text: `Reply ${turn}`, thought: turn % 2 === 0 }])
      ).resolves.toMatchObject({ stopReason: 'end_turn' })
    }
    expect(fixture.closed()).toBe(false)
    expect(fixture.requests.get(`${sessionId}:msg_80`)).toBeGreaterThan(1)
    expect(fixture.requests.get(`${sessionId}:msg_80`)).toBeLessThanOrEqual(3)
    expect(fixture.notifications).toHaveLength(301)
    const visible = JSON.stringify(fixture.notifications)
    expect(visible).toContain('Reply 300')
    expect(visible).toContain('Other Session reply')
    expect(visible).toContain('Recovered metadata reply')
    expect(visible).not.toContain('PRIVATE_')
  } finally {
    await fixture.dispose()
  }
})

it('withholds summary output, rejects failed final classification and preserves transport failure', async () => {
  const fixture = await startFixture()
  try {
    const sessionId = await fixture.startSession()
    fixture.messages.set(`${sessionId}:msg_summary`, {
      sessionId,
      messageId: 'msg_summary',
      partId: 'prt_summary',
      summary: true
    })
    await expect(
      fixture.prompt(sessionId, [
        { messageId: 'prt_summary', text: 'PRIVATE_SUMMARY_REASONING', thought: true },
        { messageId: 'msg_summary', text: 'PRIVATE_SUMMARY_TEXT' }
      ])
    ).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(fixture.notifications).toMatchObject([
      {
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'opencode/compaction': { messageId: 'msg_summary', status: 'completed' } }
        }
      }
    ])

    fixture.messages.set(`${sessionId}:msg_pending`, {
      sessionId,
      messageId: 'msg_pending',
      summary: true,
      failure: 'finish'
    })
    await expect(
      fixture.prompt(sessionId, [{ messageId: 'msg_pending', text: 'PRIVATE_PENDING_SUMMARY' }])
    ).rejects.toMatchObject({ code: -32603, data: undefined })
    expect(fixture.closed()).toBe(false)
    expect(fixture.notifications.slice(1)).toMatchObject([
      {
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'opencode/compaction': { messageId: 'msg_pending', status: 'started' } }
        }
      },
      {
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'opencode/compaction': { messageId: 'msg_pending', status: 'failed' } }
        }
      }
    ])
    fixture.messages.set(`${sessionId}:msg_after_summary`, {
      sessionId,
      messageId: 'msg_after_summary'
    })
    await expect(
      fixture.prompt(sessionId, [{ messageId: 'msg_after_summary', text: 'Reply after failure' }])
    ).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(JSON.stringify(fixture.notifications)).not.toContain('PRIVATE_')
    expect(fixture.notifications).toHaveLength(4)
    await expect(fixture.stopTransport(sessionId)).rejects.toThrow()
    await fixture.connection.closed
    expect(fixture.closed()).toBe(true)
  } finally {
    await fixture.dispose()
  }
})
