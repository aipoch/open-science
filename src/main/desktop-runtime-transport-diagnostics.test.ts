import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { ApplicationEventHub } from './application-events'
import { connectToDesktopEndpoint } from './desktop-connection'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'

const mocks = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

const byteBudget = 16 * 1024 * 1024
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function setup(
  result: unknown
): Promise<{ socket: WebSocket; events: ApplicationEventHub; request(): void }> {
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => ['projects:list'], invoke: async () => result },
    events
  })
  cleanups.push(server.close)
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const bootstrap = once(socket, 'message')
  socket.send(JSON.stringify({ kind: 'bootstrap' }))
  await bootstrap
  return {
    socket,
    events,
    request: () =>
      socket.send(
        JSON.stringify({
          kind: 'invoke',
          protocolVersion: 1,
          id: 1,
          clientId: randomUUID(),
          channel: 'projects:list',
          args: []
        })
      )
  }
}

it('classifies an oversized real response without logging its contents', async () => {
  const { socket, request } = await setup('private payload ' + 'x'.repeat(byteBudget))
  const closed = once(socket, 'close')
  request()
  await closed
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime transport terminated', {
    reason: 'single-frame-too-large',
    frameBytes: byteBudget + 1,
    bufferedBytes: 0,
    byteBudget
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|payload|projects:list/)
})

it('bounds a real outgoing burst without logging its contents', async () => {
  const { socket, events } = await setup(null)
  const closed = once(socket, 'close')
  const payload = 'private payload ' + 'x'.repeat(12 * 1024 * 1024)
  for (let index = 0; index < 6; index += 1) events.publish('connectors:approval-settled', payload)
  await closed
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime transport terminated', {
    reason: 'outbound-queue-budget',
    queuedBytes: 64 * 1024 * 1024 + 1,
    queuedFrames: 6,
    byteBudget: 64 * 1024 * 1024,
    frameBudget: 4096
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|payload|connectors/)
})

it('classifies response serialization failure without logging result or exception text', async () => {
  const result: Record<string, unknown> = { private: 'private payload' }
  result.cycle = result
  const { socket, request } = await setup(result)
  const closed = once(socket, 'close')
  request()
  await closed
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime transport terminated', {
    reason: 'response-serialization'
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|payload|cycle|projects:list/)
})
