import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ApplicationEventHub } from './application-events'
import { connectToDesktopEndpoint } from './desktop-connection'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'

const mocks = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
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
  // Receiving the bootstrap on the peer does not settle the local write callback on Windows.
  // Observe that real callback so the burst starts with an empty outgoing queue.
  const bootstrapSent = Promise.withResolvers<void>()
  const originalSend = WebSocket.prototype.send
  const sendObserver = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
    this: WebSocket,
    data,
    optionsOrCallback,
    callback
  ) {
    const onSent = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    const options = typeof optionsOrCallback === 'object' ? optionsOrCallback : {}
    const isBootstrap =
      typeof data === 'string' && data.includes('"kind":"bootstrap"') && data.includes('"control":')
    originalSend.call(this, data, options, (error) => {
      onSent?.(error)
      if (isBootstrap) {
        if (error) bootstrapSent.reject(error)
        else bootstrapSent.resolve()
      }
    })
  })
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => ['projects:list'], invoke: async () => result },
    events
  })
  cleanups.push(server.close)
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const bootstrap = once(socket, 'message')
  socket.send(
    JSON.stringify({ kind: 'bootstrap', desktopInstanceId: '77d62b13-8a19-491f-af43-af36c9824521' })
  )
  await bootstrap
  await bootstrapSent.promise
  sendObserver.mockRestore()
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

it('rejects an oversized response locally without logging its contents', async () => {
  const { socket, request } = await setup('private payload ' + 'x'.repeat(byteBudget))
  const response = once(socket, 'message')
  request()
  const [bytes] = await response
  expect(JSON.parse(bytes.toString())).toMatchObject({
    ok: false,
    error: { message: 'Desktop runtime response exceeds the transport byte budget.' }
  })
  expect(socket.readyState).toBe(1)
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
    'desktop runtime response exceeds transport budget',
    {
      channel: 'projects:list',
      requestId: 1,
      byteLength: expect.any(Number),
      maxFrameBytes: byteBudget
    }
  )
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|payload/)
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
