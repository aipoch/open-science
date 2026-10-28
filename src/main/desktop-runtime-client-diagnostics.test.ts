import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../shared/web-rpc-contract'
import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { waitForRuntimeStopped } from './runtime-stop-confirmation'
import { StoppedServiceProcessRecoveryError } from './service-process-recovery'

vi.mock('./runtime-stop-confirmation', () => ({
  waitForRuntimeStopped: vi.fn(async () => ({ release: vi.fn() }))
}))
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  recover: vi.fn(async () => {}),
  terminate: vi.fn(async () => {})
}))
vi.mock('./verified-service-stop', () => ({ terminateVerifiedService: mocks.terminate }))
vi.mock('./service-process-recovery', async (original) => ({
  ...(await original<typeof import('./service-process-recovery')>()),
  recoverStoppedServiceProcesses: mocks.recover
}))
vi.mock('./desktop-connection', () => ({ connectToDesktopEndpoint: mocks.connect }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: mocks.warn, info: mocks.info })
}))

const streamId = '885811d4-929c-4e1e-89c6-2cbef6a4f53b'
class Socket extends EventEmitter {
  serviceLifetime = false
  readyState = 1
  bufferedAmount = 0
  terminate = vi.fn()
  send = vi.fn((text: string) => {
    if (JSON.parse(text).kind === 'bootstrap')
      queueMicrotask(() =>
        this.frame({
          kind: 'bootstrap',
          ...(this.serviceLifetime
            ? {
                lifetime: {
                  version: 1,
                  generation: streamId,
                  explicit: false,
                  stopping: false,
                  apps: 1
                }
              }
            : {}),
          pid: 42,
          launch: 'desktop',
          control: 'granted',
          generation: streamId,
          birthToken: 'verified-birth',
          entryPath: process.execPath,
          startupOptions: {
            configRoot: process.cwd(),
            dataRoot: process.cwd(),
            profilePath: process.cwd(),
            port: 0,
            host: '127.0.0.1',
            credentialStore: 'os'
          },
          rpcProtocolVersion: 1,
          rpcChannels: ['projects:list'],
          eventStream: {
            protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
            streamId,
            latestSequence: 0
          }
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
  startedProcess?: ChildProcess,
  serviceLifetime = false
): Promise<{
  socket: Socket
  client: Awaited<ReturnType<typeof connectDesktopRuntime>>
  onDisconnect: ReturnType<typeof vi.fn>
}> {
  const socket = new Socket()
  socket.serviceLifetime = serviceLifetime
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

it('isolates callback failures and reports stale display without logging private contents', async () => {
  const socket = new Socket()
  mocks.connect.mockResolvedValue(socket)
  const onDeliveryFailure = vi.fn()
  const onDisconnect = vi.fn()
  const client = await connectDesktopRuntime({
    endpoint: { path: 'unused', secret: 'unused', generation: streamId, version: 'test' },
    onEvent: () => {
      throw new Error('private file path and user content')
    },
    onDeliveryFailure,
    onDisconnect
  })
  socket.frame({
    kind: 'event',
    protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
    streamId,
    sequence: 1,
    channel: 'session:changed',
    payload: { private: 'sensitive payload' }
  })
  expect(onDisconnect).not.toHaveBeenCalled()
  expect(onDeliveryFailure).toHaveBeenCalledWith({ kind: 'event' })
  const read = client.invokeHost('projects:list')
  socket.frame({ kind: 'response', id: 1, protocolVersion: 1, ok: true, result: [] })
  await expect(read).resolves.toEqual([])
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private|sensitive/)
  client.close()
})

it('preserves the first socket failure as the cause after a later close', async () => {
  const { socket, client, onDisconnect } = await setup()
  const failure = new Error('private socket details')
  socket.emit('error', failure)
  socket.emit('close', 1006, Buffer.from('private close reason'))
  expect(onDisconnect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      code: 'desktop-runtime-disconnected',
      cause: failure
    })
  )
  await expect(client.invokeHost('projects:list')).rejects.toMatchObject({
    cause: { cause: failure }
  })
  expect(mocks.warn).toHaveBeenCalledOnce()
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private')
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
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
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

it.each([
  { kind: 'startup-state', state: { phase: 'ready' }, rpcChannels: ['projects:list'] },
  { kind: 'document-event', clientId: streamId, channel: 'office-preview:state', payload: null },
  {
    kind: 'upload-progress',
    clientId: streamId,
    progress: { transferId: 'upload', name: 'private', receivedBytes: 1, totalBytes: 2 }
  }
])('isolates $kind consumer failures while maintaining the request connection', async (frame) => {
  const socket = new Socket()
  mocks.connect.mockResolvedValue(socket)
  const failed = (): never => {
    throw new Error('private contents')
  }
  const onDeliveryFailure = vi.fn()
  const onDisconnect = vi.fn()
  const client = await connectDesktopRuntime({
    endpoint: { path: 'unused', secret: 'unused', generation: streamId, version: 'test' },
    onEvent: vi.fn(),
    onStartupState: failed,
    onDocumentEvent: failed,
    onUploadProgress: failed,
    onDeliveryFailure,
    onDisconnect
  })
  socket.frame(frame)
  expect(onDeliveryFailure).toHaveBeenCalledOnce()
  expect(onDisconnect).not.toHaveBeenCalled()
  const result = client.invokeHost('projects:list')
  socket.frame({ kind: 'response', id: 1, protocolVersion: 1, ok: true, result: null })
  await expect(result).resolves.toBeNull()
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private')
  client.close()
})

it('bounds an ordinary prepare RPC and tolerates its late reply without losing the attachment', async () => {
  vi.useFakeTimers()
  try {
    const { socket, client } = await setup()
    const pending = client.lifecycle({
      operation: 'prepare',
      fingerprint: 'a'.repeat(64),
      deadlineAt: Date.now() + 5000
    })
    const result = expect(pending).rejects.toThrow('acknowledgement timed out')
    await vi.advanceTimersByTimeAsync(1500)
    await result
    socket.frame({ kind: 'response', id: 1, protocolVersion: 1, ok: true, result: 'completed' })
    const read = client.invokeHost('projects:list')
    socket.frame({ kind: 'response', id: 2, protocolVersion: 1, ok: true, result: [] })
    await expect(read).resolves.toEqual([])
    expect(socket.terminate).not.toHaveBeenCalled()
    client.close()
  } finally {
    vi.useRealTimers()
  }
})

it('reports settled unknown receipts while returning only the proven service-exit lease', async () => {
  const { client } = await setup(undefined, undefined, true)
  const lease = { directory: process.cwd(), release: vi.fn() }
  vi.mocked(waitForRuntimeStopped).mockResolvedValueOnce(lease)
  mocks.recover.mockRejectedValueOnce(
    new StoppedServiceProcessRecoveryError(
      'service-process-recovery-incomplete',
      'unknown receipt identity'
    )
  )
  await expect(client.waitForStopped()).resolves.toBe(lease)
  expect(lease.release).not.toHaveBeenCalled()
  expect(mocks.warn).toHaveBeenCalledWith(
    'Stopped local service has unresolved process receipts',
    expect.objectContaining({ code: 'service-process-recovery-incomplete' })
  )
  lease.release()
  client.close()
})

it('retains the Config Root lock until a timed-out reaper actually settles', async () => {
  const { client } = await setup(undefined, undefined, true)
  const lease = { directory: process.cwd(), release: vi.fn() }
  vi.mocked(waitForRuntimeStopped).mockResolvedValueOnce(lease)
  const settlement = Promise.withResolvers<void>()
  const failure = new StoppedServiceProcessRecoveryError(
    'service-process-recovery-timeout',
    'recovery is still running',
    undefined,
    settlement.promise
  )
  mocks.recover.mockRejectedValueOnce(failure)
  await expect(client.waitForStopped()).rejects.toBe(failure)
  expect(lease.release).not.toHaveBeenCalled()
  settlement.resolve()
  await Promise.resolve()
  expect(lease.release).toHaveBeenCalledOnce()
  client.close()
})

it('preserves a genuine Data Root lock failure instead of degrading it to a receipt warning', async () => {
  const { client } = await setup(undefined, undefined, true)
  const lease = { directory: process.cwd(), release: vi.fn() }
  vi.mocked(waitForRuntimeStopped).mockResolvedValueOnce(lease)
  const failure = new Error('Data Root is still owned')
  mocks.recover.mockRejectedValueOnce(failure)
  await expect(client.waitForStopped()).rejects.toBe(failure)
  expect(lease.release).toHaveBeenCalledOnce()
  client.close()
})

it('reserves escalation, exit confirmation and process recovery inside the native stop observation budget', async () => {
  vi.useFakeTimers()
  const { client } = await setup(undefined, undefined, true)
  try {
    const started = Date.now()
    const lease = { directory: process.cwd(), release: vi.fn() }
    const timeout = Object.assign(new Error('grace expired'), { code: 'runtime-stop-timeout' })
    vi.mocked(waitForRuntimeStopped)
      .mockImplementationOnce(
        ({ timeoutMs }) =>
          new Promise((_resolve, reject) => setTimeout(() => reject(timeout), timeoutMs))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(lease), 1000))
      )
    mocks.terminate.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    mocks.recover.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    })
    const stopped = client.waitForStopped()
    expect(waitForRuntimeStopped).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 16_500, requireCleanExit: false })
    )
    await vi.advanceTimersByTimeAsync(16_499)
    expect(mocks.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith({
      configRoot: process.cwd(),
      generation: streamId,
      pid: 42,
      birthToken: 'verified-birth',
      deadlineAt: started + 20_000,
      signal: undefined
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(waitForRuntimeStopped).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 3000, requireCleanExit: false })
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith({
      configRoot: process.cwd(),
      dataRoot: process.cwd(),
      lease,
      deadlineAt: started + 20_000
    })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(stopped).resolves.toBe(lease)
    expect(Date.now() - started).toBe(20_000)
    expect(lease.release).not.toHaveBeenCalled()
  } finally {
    client.close()
    vi.useRealTimers()
  }
})

it('does not invent a durable stop grant when observing a modern service timeout', async () => {
  const { client, socket } = await setup(undefined, undefined, true)
  const timeout = Object.assign(new Error('grace expired'), { code: 'runtime-stop-timeout' })
  const denied = new Error('The local service stop identity or intent could not be verified.')
  vi.mocked(waitForRuntimeStopped).mockRejectedValueOnce(timeout)
  mocks.terminate.mockRejectedValueOnce(denied)
  await expect(client.waitForStopped()).rejects.toBe(denied)
  expect(waitForRuntimeStopped).toHaveBeenCalledOnce()
  expect(mocks.recover).not.toHaveBeenCalled()
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame).kind)).toEqual(['bootstrap'])
  client.close()
})

it('preserves legacy clean-exit observation without authorizing escalation', async () => {
  const { client } = await setup()
  const timeout = Object.assign(new Error('legacy grace expired'), { code: 'runtime-stop-timeout' })
  vi.mocked(waitForRuntimeStopped).mockRejectedValueOnce(timeout)
  await expect(client.waitForStopped()).rejects.toBe(timeout)
  expect(waitForRuntimeStopped).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ timeoutMs: 15_000, requireCleanExit: true })
  )
  expect(mocks.terminate).not.toHaveBeenCalled()
  client.close()
})

it('keeps the legacy stop command inside its original fifteen-second confirmation budget', async () => {
  vi.useFakeTimers()
  const { client } = await setup()
  try {
    const timeout = Object.assign(new Error('legacy grace expired'), {
      code: 'runtime-stop-timeout'
    })
    vi.mocked(waitForRuntimeStopped).mockRejectedValueOnce(timeout)
    await expect(client.stopRuntime()).rejects.toBe(timeout)
    expect(waitForRuntimeStopped).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 15_000, requireCleanExit: true })
    )
    expect(mocks.terminate).not.toHaveBeenCalled()
  } finally {
    client.close()
    vi.useRealTimers()
  }
})

it('preserves an explicit clean-exit requirement and shorter deadline after verified escalation', async () => {
  vi.useFakeTimers()
  const { client } = await setup(undefined, undefined, true)
  try {
    const controller = new AbortController()
    const deadlineAt = Date.now() + 10_000
    const lease = { directory: process.cwd(), release: vi.fn() }
    const timeout = Object.assign(new Error('grace expired'), { code: 'runtime-stop-timeout' })
    vi.mocked(waitForRuntimeStopped).mockRejectedValueOnce(timeout).mockResolvedValueOnce(lease)
    await expect(client.waitForStopped(controller.signal, true, 10_000)).resolves.toBe(lease)
    expect(waitForRuntimeStopped).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        signal: controller.signal,
        timeoutMs: 6500,
        requireCleanExit: true
      })
    )
    expect(waitForRuntimeStopped).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        signal: controller.signal,
        timeoutMs: 10_000,
        requireCleanExit: true
      })
    )
    expect(mocks.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt, signal: controller.signal })
    )
    expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt, lease }))
  } finally {
    client.close()
    vi.useRealTimers()
  }
})

it('honors cancellation before native stop escalation while preserving clean-exit requirements', async () => {
  const { client } = await setup(undefined, undefined, true)
  const controller = new AbortController()
  const cancelled = new Error('stop observation cancelled')
  vi.mocked(waitForRuntimeStopped).mockImplementationOnce(async () => {
    controller.abort(cancelled)
    throw Object.assign(new Error('grace expired'), { code: 'runtime-stop-timeout' })
  })
  await expect(client.waitForStopped(controller.signal, true, 10_000)).rejects.toBe(cancelled)
  expect(waitForRuntimeStopped).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ signal: controller.signal, timeoutMs: 6500, requireCleanExit: true })
  )
  expect(mocks.terminate).not.toHaveBeenCalled()
  client.close()
})
