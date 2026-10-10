import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { connectDesktopRuntime } from './desktop-runtime-client'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('./desktop-connection', () => ({ connectToDesktopEndpoint: mocks.connect }))
vi.mock('./logger', () => ({ createLogger: () => ({ warn: mocks.warn, info: mocks.info }) }))

const streamId = '885811d4-929c-4e1e-89c6-2cbef6a4f53b'
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  terminate = vi.fn()
  send = vi.fn((text: string) => {
    if (JSON.parse(text).kind === 'bootstrap')
      queueMicrotask(() =>
        this.frame({
          kind: 'bootstrap',
          pid: 42,
          rpcProtocolVersion: 1,
          rpcChannels: ['projects:list'],
          eventStream: { protocolVersion: 3, streamId, latestSequence: 0 }
        })
      )
  })
  frame(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false)
  }
}
beforeEach(() => vi.clearAllMocks())

async function setup(
  onEvent = vi.fn(),
  startedProcess?: ChildProcess
): Promise<{
  socket: Socket
  client: Awaited<ReturnType<typeof connectDesktopRuntime>>
  onDisconnect: ReturnType<typeof vi.fn>
}> {
  const socket = new Socket()
  mocks.connect.mockResolvedValue(socket)
  const onDisconnect = vi.fn()
  const client = await connectDesktopRuntime({
    endpoint: { path: 'unused', secret: 'unused', generation: streamId, version: 'test' },
    onEvent,
    startedProcess,
    onDisconnect
  })
  return { socket, client, onDisconnect }
}

it('retains a callback disconnect cause without logging its private contents', async () => {
  const failure = new Error('private file path and user content')
  const { socket, client, onDisconnect } = await setup(
    vi.fn(() => {
      throw failure
    })
  )
  socket.frame({
    kind: 'event',
    protocolVersion: 3,
    streamId,
    sequence: 1,
    channel: 'session:changed',
    payload: { private: 'sensitive payload' }
  })
  expect(onDisconnect).toHaveBeenCalledWith(failure)
  socket.emit('close', 1006, Buffer.from('private close reason'))
  await expect(client.invokeHost('projects:list')).rejects.toMatchObject({ cause: failure })
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'connected',
    reason: 'callback-failure',
    pendingRequests: 0,
    pendingNativeOperations: 0
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|sensitive/)
})

it.each([
  ['invalid-frame', (s: Socket) => s.emit('message', Buffer.from('private invalid JSON'), false)],
  ['invalid-event', (s: Socket) => s.frame({ kind: 'private-event' })],
  ['invalid-response', (s: Socket) => s.frame({ kind: 'response', id: 1, ok: 'private' })],
  [
    'response-identity',
    (s: Socket) =>
      s.frame({ kind: 'response', id: 999, protocolVersion: 1, ok: true, result: null })
  ],
  [
    'event-history',
    (s: Socket) =>
      s.frame({
        kind: 'resync-required',
        protocolVersion: 3,
        streamId,
        latestSequence: 1,
        reason: 'cursor-expired'
      })
  ],
  ['socket-error', (s: Socket) => s.emit('error', new Error('private socket details'))]
])('classifies %s without logging frame or error contents', async (reason, trigger) => {
  const { socket } = await setup()
  trigger(socket)
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'connected',
    reason,
    pendingRequests: 0,
    pendingNativeOperations: 0
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private')
})

it.each([1008, -1, 10000])('only logs bounded close codes (%s)', async (code) => {
  const { socket } = await setup()
  socket.emit('close', code, Buffer.from('private close reason'))
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'connected',
    reason: 'transport-close',
    pendingRequests: 0,
    pendingNativeOperations: 0,
    ...(code === 1008 ? { closeCode: code } : {})
  })
})

it('identifies bootstrap schema failures without logging the rejected frame', async () => {
  const socket = new Socket()
  socket.send.mockImplementation(() => {
    queueMicrotask(() => socket.frame({ kind: 'bootstrap', private: 'sensitive value' }))
  })
  mocks.connect.mockResolvedValue(socket)
  await expect(
    connectDesktopRuntime({
      endpoint: { path: 'unused', secret: 'unused', generation: streamId, version: 'test' },
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
  ).rejects.toThrow()
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'bootstrap',
    reason: 'invalid-bootstrap',
    pendingRequests: 0,
    pendingNativeOperations: 0
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|sensitive/)
})

it.each([
  ['Invalid desktop request.', 'invalid-request'],
  ['Invalid or excessive desktop requests.', 'request-order-or-capacity'],
  ['Too many renderer documents.', 'document-capacity'],
  ['Reconnect desktop attachment.', 'retired-document-capacity'],
  ['Invalid desktop request. private details', undefined]
])('only classifies exact known policy reasons (%s)', async (message, policyReason) => {
  const { socket } = await setup()
  socket.emit('close', 1008, Buffer.from(message))
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'connected',
    reason: 'transport-close',
    closeCode: 1008,
    pendingRequests: 0,
    pendingNativeOperations: 0,
    ...(policyReason ? { policyReason } : {})
  })
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(message)
})

it('records an owned runtime shutdown close as informational', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 42 })
  const { socket, client } = await setup(vi.fn(), child)
  socket.send.mockImplementation((text: string) => {
    const frame = JSON.parse(text)
    if (frame.kind === 'shutdown')
      queueMicrotask(() => {
        socket.frame({ kind: 'response', id: frame.id, protocolVersion: 1, ok: true, result: null })
        socket.emit('close', 1006, Buffer.from(''))
        child.emit('exit', 0, null)
      })
  })
  await client.quit()
  expect(mocks.warn).not.toHaveBeenCalled()
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('desktop runtime disconnected', {
    phase: 'shutdown',
    reason: 'transport-close',
    closeCode: 1006,
    pendingRequests: 0,
    pendingNativeOperations: 0
  })
})
