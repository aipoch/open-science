import { createDesktopRecoveryEventBuffer } from './desktop-recovery-event-buffer'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationEventHub } from './application-events'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import { stringifyRpcJson } from './rpc-json'
import {
  createSessionFile,
  decodeSessionFile,
  MAX_PERSISTED_SESSION_BYTES,
  sessionApplicationCommandContracts,
  type PersistedChatSession
} from '../shared/session-persistence'

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: diagnostics.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

function largeReadableSession(): PersistedChatSession {
  // Several ordinary messages; use the production file codec and its canonical graph projection.
  const file = createSessionFile({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Long research session',
    cwd: process.cwd(),
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: `message-${i}`,
      role: 'user' as const,
      createdAt: 1,
      updatedAt: 2,
      status: 'complete' as const,
      content: 'x'.repeat(512 * 1024),
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
  expect(decoded.status).toBe('ok')
  if (decoded.status !== 'ok') throw new Error('Fixture must be a readable persisted Session.')
  expect(decoded.session.messages).toHaveLength(20)
  expect(Buffer.byteLength(stringifyRpcJson(decoded.session))).toBeGreaterThan(16 * 1024 * 1024)
  return decoded.session
}

it('keeps unrelated desktop commands usable after a valid large session update', async () => {
  const session = largeReadableSession()
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events,
    commands: {
      commandNames: () => ['projects:list', 'sessions:load-one'],
      invoke: async (name) => (name === 'sessions:load-one' ? session : [])
    }
  })
  cleanups.push(server.close)
  const disconnected = vi.fn()
  const received = vi.fn()
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onEvent: received,
    onDisconnect: disconnected
  })
  cleanups.push(client.close)
  const document = randomUUID()
  await expect(client.invoke(document, 'projects:list', [])).resolves.toEqual([])
  events.publish('session:updated', { session, originClientId: 'main:runtime-transcript' })
  const result = await client.invoke(document, 'projects:list', []).then(
    () => 'available',
    (error: Error) => error.message
  )
  expect(result, JSON.stringify(diagnostics.warn.mock.calls)).toBe('available')
  expect(disconnected).not.toHaveBeenCalled()
  await vi.waitFor(
    () => {
      expect(diagnostics.warn.mock.calls).toEqual([])
      expect(received).toHaveBeenCalledOnce()
    },
    { timeout: 5000 }
  )
  expect(
    JSON.stringify(received.mock.calls[0][0]) ===
      JSON.stringify({
        channel: 'session:updated',
        payload: { session, originClientId: 'main:runtime-transcript' }
      })
  ).toBe(true)
})

it('loads a session accepted by the persisted-session codec through the desktop boundary', async () => {
  const session = largeReadableSession()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events: new ApplicationEventHub(),
    commands: { commandNames: () => ['sessions:load-one'], invoke: async () => session }
  })
  cleanups.push(server.close)
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanups.push(client.close)
  const actual = await client.invoke(randomUUID(), 'sessions:load-one', [
    { projectId: session.projectId, sessionId: session.id }
  ])
  expect(JSON.stringify(actual) === JSON.stringify(session)).toBe(true)
})

it.each(['sessions:save-session', 'sessions:update-configuration'])(
  'uploads %s and dispatches the complete mutation exactly once',
  async (channel) => {
    const session = largeReadableSession()
    const invoke = vi.fn(async (_name: string, request: { args: readonly unknown[] }) => {
      const contract =
        channel === 'sessions:save-session'
          ? sessionApplicationCommandContracts.save
          : sessionApplicationCommandContracts.updateConfiguration
      const [saved] = contract.args.parse(request.args)
      expect(JSON.stringify(saved) === JSON.stringify(session)).toBe(true)
      return { ...saved, revision: 1 }
    })
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: { commandNames: () => [channel], invoke }
    })
    cleanups.push(server.close)
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    cleanups.push(client.close)
    const result = await client.invoke(
      randomUUID(),
      channel,
      channel === 'sessions:save-session' ? [session] : [session, 0]
    )
    expect(JSON.stringify(result) === JSON.stringify({ ...session, revision: 1 })).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
  }
)

// The exact queue extracted from native startup is the seam; the Session uses the persisted codec.
it('retains a valid large Session update received during manual desktop reconciliation', async () => {
  const buffer = createDesktopRecoveryEventBuffer()
  const session = largeReadableSession()
  expect(() =>
    buffer.push({ channel: 'session:updated', payload: { session, originClientId: 'other' } })
  ).not.toThrow()
  const received = vi.fn()
  const load = vi.fn(async () => session)
  await buffer.drain({ load, deliver: received, signal: new AbortController().signal })
  expect(load).toHaveBeenCalledWith({ projectId: session.projectId, sessionId: session.id })
  expect(received).toHaveBeenCalledWith({
    channel: 'session:updated',
    payload: { session, originClientId: 'other' }
  })
})

it('returns the complete large Session after editing its small details request', async () => {
  const session = largeReadableSession()
  const invoke = vi.fn(async (_name: string, request: { args: readonly unknown[] }) => {
    sessionApplicationCommandContracts.editDetails.args.parse(request.args)
    return { ...session, title: 'Renamed' }
  })
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events: new ApplicationEventHub(),
    commands: { commandNames: () => ['sessions:edit-details'], invoke }
  })
  cleanups.push(server.close)
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanups.push(client.close)
  const result = await client.invoke(randomUUID(), 'sessions:edit-details', [
    {
      projectId: session.projectId,
      sessionId: session.id,
      title: 'Renamed',
      description: ''
    }
  ])
  expect(JSON.stringify(result) === JSON.stringify({ ...session, title: 'Renamed' })).toBe(true)
  expect(invoke).toHaveBeenCalledOnce()
})
