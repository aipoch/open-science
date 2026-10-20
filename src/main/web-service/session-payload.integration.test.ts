import { createSessionEventHydrator } from '../../shared/session-event-hydrator'
import { createRuntimePayloadClient } from '../../shared/runtime-payload-client'
import {
  RUNTIME_PAYLOAD_CAPABILITY,
  type RuntimePayloadOptions
} from '../../shared/runtime-payload-transfer'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'
import { ApplicationEventHub } from '../application-events'
import { startWebHttpServer } from './http-server'
import {
  createSessionFile,
  decodeSessionFile,
  MAX_PERSISTED_SESSION_BYTES,
  type PersistedChatSession
} from '../../shared/session-persistence'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{
  server: Awaited<ReturnType<typeof startWebHttpServer>>
  events: ApplicationEventHub
  session: PersistedChatSession
}> {
  const file = createSessionFile({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Long research session',
    cwd: process.cwd(),
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: 'user' as const,
      createdAt: 1,
      updatedAt: 2,
      content: 'x'.repeat(512 * 1024),
      status: 'complete' as const,
      eventIds: []
    }))
  })
  const graph = file.session.conversationGraph!
  const rootFrame = graph.frames.find((frame) => frame.id === graph.rootFrameId)!
  graph.branches.push({
    id: 'selected-fork',
    agentFrameId: graph.rootFrameId,
    parentBranchId: rootFrame.activeBranchId,
    forkMessageId: 'message-19',
    headMessageId: 'message-19',
    createdAt: 2,
    updatedAt: 2
  })
  rootFrame.activeBranchId = 'selected-fork'
  expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThan(MAX_PERSISTED_SESSION_BYTES)
  const decoded = decodeSessionFile(file)
  if (decoded.status !== 'ok') throw new Error('Fixture must be a readable persisted Session.')
  const session = decoded.session
  const events = new ApplicationEventHub()
  const dispatcher = {
    commandNames: () => ['sessions:load-one'],
    rejectedCommandNames: () => [],
    invoke: async () => session
  }
  const server = await startWebHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    staticRoot: '/unused',
    applicationCommands: { localWeb: dispatcher, remoteWeb: dispatcher },
    applicationEvents: events,
    bootstrap: {
      appName: 'Open-Science',
      appVersion: 'test',
      configRoot: '/unused',
      platform: process.platform,
      versions: { node: process.versions.node }
    }
  })
  cleanups.push(server.close)
  return { server, events, session }
}

async function clientFor(
  server: Awaited<ReturnType<typeof startWebHttpServer>>
): Promise<Parameters<typeof createRuntimePayloadClient>[0]['invoke']> {
  const bootstrap = await fetch(
    `http://127.0.0.1:${server.port}/api/bootstrap?token=test-token`
  ).then((response) => response.json())
  const invoke = async (
    channel: string,
    args: readonly unknown[],
    options?: RuntimePayloadOptions
  ): Promise<unknown> => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/rpc/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'x-open-science-client': 'payload-test'
        },
        body: JSON.stringify({ protocolVersion: 1, args, ...options })
      }
    )
    const body = await response.json()
    if (!response.ok || !body.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
    return body.result
  }
  const client = createRuntimePayloadClient({
    invoke,
    encode: JSON.stringify,
    decode: JSON.parse,
    signal: () => new AbortController().signal
  })
  return bootstrap.rpcCapabilities?.includes(RUNTIME_PAYLOAD_CAPABILITY) ? client.invoke : invoke
}

it.each(['legacy', 'replay'] as const)(
  'handles a large Session update through the %s Web protocol',
  async (protocol) => {
    const { server, events, session } = await setup()
    const bootstrap = await fetch(`http://127.0.0.1:${server.port}/api/bootstrap`, {
      headers: { authorization: 'Bearer test-token' }
    }).then((response) => response.json())
    const replay =
      protocol === 'replay'
        ? `&eventProtocol=${WEB_EVENT_STREAM_PROTOCOL_VERSION}&stream=${bootstrap.eventStream.streamId}&after=${bootstrap.eventStream.latestSequence}&liveness=1`
        : ''
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=payload-test${replay}`
    )
    cleanups.push(() => socket.terminate())
    await once(socket, 'open')
    const load = await clientFor(server)
    const delivered: string[] = []
    let projectedSession: unknown
    let resolveOutcome: ((result: string) => void) | undefined
    const hydrator = createSessionEventHydrator({
      load: (request) => load('sessions:load-one', [request]),
      deliver: (event) => {
        delivered.push(event.channel)
        if (event.channel === 'session:updated') projectedSession = event.payload
        if (event.channel === 'runtime:policy-changed') resolveOutcome?.('available')
      },
      onFailure: () => resolveOutcome?.('projection-failed')
    })
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.channel) hydrator.receive(message, Buffer.byteLength(data.toString()))
    })
    cleanups.push(() => hydrator.dispose())
    events.publish('runtime:policy-changed', undefined)
    await vi.waitFor(() => expect(delivered).toEqual(['runtime:policy-changed']))
    const outcome = new Promise<string>((resolve) => {
      resolveOutcome = resolve
      socket.once('close', (code) => resolve(`closed:${code}`))
    })
    events.publish('session:updated', { session, originClientId: 'main:runtime-transcript' })
    events.publish('runtime:policy-changed', undefined)
    await expect(outcome).resolves.toBe(protocol === 'legacy' ? 'closed:1002' : 'available')
    if (protocol === 'replay')
      expect(
        JSON.stringify(projectedSession) ===
          JSON.stringify({ session, originClientId: 'main:runtime-transcript' })
      ).toBe(true)
  }
)

it('loads a readable persisted session through the HTTP RPC boundary', async () => {
  const { server, session } = await setup()
  const load = await clientFor(server)
  const actual = await load('sessions:load-one', [
    { projectId: session.projectId, sessionId: session.id }
  ])
  expect(JSON.stringify(actual) === JSON.stringify(session)).toBe(true)
})
