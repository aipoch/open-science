import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationEventHub } from './application-events'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import { createSessionFile, decodeSessionFile } from '../shared/session-persistence'
import { RUNTIME_PAYLOAD_INLINE_BYTES } from '../shared/runtime-payload-transfer'
import { stringifyRpcJson } from './rpc-json'

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: diagnostics.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

it.each([true, false])(
  'preserves live Session events while four normal large reads share a document: %s',
  async (shareDocument) => {
    // A single durable message has both its canonical graph body and active-message projection
    // on the wire, crossing the 8 MiB payload boundary without an oversized storage fixture.
    const file = createSessionFile({
      id: 'large-session',
      projectId: 'project-1',
      title: 'Long research session',
      cwd: process.cwd(),
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          status: 'complete',
          content: 'x'.repeat(4 * 1024 * 1024 + 128),
          eventIds: [],
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })
    const decoded = decodeSessionFile(file)
    if (decoded.status !== 'ok') throw new Error('Fixture must pass the persisted Session codec.')
    const session = decoded.session
    expect(Buffer.byteLength(stringifyRpcJson(session))).toBeGreaterThan(
      RUNTIME_PAYLOAD_INLINE_BYTES
    )
    const events = new ApplicationEventHub()
    let reads = 0
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events,
      commands: {
        commandNames: () => ['sessions:load-one', 'projects:list'],
        invoke: async (name) => {
          if (name === 'projects:list') return []
          reads++
          return session
        }
      }
    })
    cleanups.push(server.close)
    const delivered = vi.fn()
    const stale = vi.fn()
    const disconnected = vi.fn()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: delivered,
      onDeliveryFailure: stale,
      onDisconnect: disconnected
    })
    cleanups.push(client.close)
    const document = randomUUID()
    const downloads = Array.from({ length: 4 }, () =>
      client.invoke(shareDocument ? document : randomUUID(), 'sessions:load-one', [
        { projectId: session.projectId, sessionId: session.id }
      ])
    )
    const settled = Promise.allSettled(downloads)
    await vi.waitFor(() => expect(reads).toBe(4), { interval: 1, timeout: 5000 })
    // All callers use the normal client API, including normal paging/release. No descriptor,
    // download page, ACK, event callback, or socket is deliberately held by the fixture.
    events.publish('session:updated', { session, originClientId: 'main:runtime-transcript' })
    expect((await settled).every((result) => result.status === 'fulfilled')).toBe(true)
    expect(stale, JSON.stringify(diagnostics.warn.mock.calls)).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce(), { timeout: 5000 })
    expect(delivered.mock.calls[0][0].channel).toBe('session:updated')
    expect(delivered.mock.calls[0][0].payload.session.id).toBe(session.id)
    // A transient transfer backlog must not permanently dispose the event consumer.
    events.publish('runtime:policy-changed', undefined)
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2))
    expect(delivered.mock.calls[1][0].channel).toBe('runtime:policy-changed')
    expect(disconnected).not.toHaveBeenCalled()
    await expect(client.invoke(document, 'projects:list', [])).resolves.toEqual([])
  },
  15_000
)
