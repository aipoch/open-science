import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createWebSocketFrameBudget, createWebSocketFrameSender } from './websocket-frame-sender'

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  callbacks: Array<(error?: Error) => void> = []
  send = vi.fn((_frame: string, callback: (error?: Error) => void) => {
    this.callbacks.push(callback)
  })
  terminate = vi.fn()
}

function setup(): {
  socket: Socket
  failure: ReturnType<typeof vi.fn>
  sender: ReturnType<typeof createWebSocketFrameSender>
} {
  const socket = new Socket()
  const failure = vi.fn()
  const sender = createWebSocketFrameSender(socket as unknown as WebSocket, failure)
  return { socket, failure, sender }
}

it('writes bootstrap, events, native requests and replies in FIFO order, one write at a time', () => {
  const { socket, sender, failure } = setup()
  const shutdown = vi.fn()
  const frames = ['bootstrap', 'event', 'native-request', 'response', 'shutdown-response']
  for (const frame of frames)
    sender.send(frame, frame === 'shutdown-response' ? shutdown : undefined)
  expect(socket.send).toHaveBeenCalledTimes(1)
  for (let index = 0; index < frames.length; index += 1) {
    expect(socket.send.mock.calls[index][0]).toBe(frames[index])
    expect(shutdown).not.toHaveBeenCalled()
    socket.callbacks[index]()
    expect(socket.send).toHaveBeenCalledTimes(Math.min(index + 2, frames.length))
  }
  expect(shutdown).toHaveBeenCalledOnce()
  expect(failure).not.toHaveBeenCalled()
})

it('bounds retained bytes including the active frame and drops queued callbacks on overload', () => {
  const { socket, sender, failure } = setup()
  const sent = vi.fn()
  const frame = 'x'.repeat(16 * 1024 * 1024)
  for (let index = 0; index < 4; index += 1) sender.send(frame, sent)
  expect(failure).not.toHaveBeenCalled()
  sender.send('x', sent)
  expect(failure).toHaveBeenCalledExactlyOnceWith({
    reason: 'outbound-queue-budget',
    queuedBytes: 64 * 1024 * 1024 + 1,
    queuedFrames: 5,
    byteBudget: 64 * 1024 * 1024,
    frameBudget: 4096
  })
  socket.callbacks[0]()
  sender.send('later')
  expect(socket.send).toHaveBeenCalledTimes(1)
  expect(sent).not.toHaveBeenCalled()
  expect(socket.terminate).toHaveBeenCalledOnce()
})

it('bounds small queued frames independently of their total bytes', () => {
  const { socket, sender, failure } = setup()
  for (let index = 0; index < 4096; index += 1) sender.send('x')
  expect(failure).not.toHaveBeenCalled()
  sender.send('x')
  expect(failure).toHaveBeenCalledExactlyOnceWith({
    reason: 'outbound-queue-budget',
    queuedBytes: 4097,
    queuedFrames: 4097,
    byteBudget: 64 * 1024 * 1024,
    frameBudget: 4096
  })
  expect(socket.terminate).toHaveBeenCalledOnce()
})

it.each(['close', 'error'])(
  'clears the closed socket on %s and ignores its late write callback',
  (event) => {
    const old = setup()
    const sent = vi.fn()
    old.sender.send('active', sent)
    old.sender.send('queued', sent)
    old.socket.emit(event)
    const next = setup()
    next.sender.send('new attachment', sent)
    old.socket.callbacks[0](new Error('private old-socket error'))
    expect(old.socket.send).toHaveBeenCalledTimes(1)
    expect(old.failure).not.toHaveBeenCalled()
    expect(next.socket.terminate).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
    next.socket.callbacks[0]()
    expect(sent).toHaveBeenCalledOnce()
  }
)

it.each(['callback', 'throw'])(
  'terminates once on a %s write failure without retrying or logging contents',
  (mode) => {
    const { socket, sender, failure } = setup()
    if (mode === 'throw')
      socket.send.mockImplementation(() => {
        throw new Error('private write details')
      })
    sender.send('private content')
    if (mode === 'callback') socket.callbacks[0](new Error('private write details'))
    sender.send('later')
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledExactlyOnceWith({ reason: 'socket-write-failure' })
  }
)

it('checks authorization again before a queued frame reaches the socket', () => {
  const socket = new Socket()
  let authorized = true
  const failure = vi.fn()
  const sender = createWebSocketFrameSender(socket as unknown as WebSocket, failure, {
    isAuthorized: () => authorized
  })
  sender.send('already sent')
  sender.send('private queued event')
  authorized = false
  socket.callbacks[0]()
  expect(socket.send).toHaveBeenCalledTimes(1)
  expect(sender.send('later')).toBe(false)
  expect(failure).not.toHaveBeenCalled()
})

it.each(['complete', 'close', 'error', 'revoked', 'timeout'])(
  'releases shared byte reservations on %s, without double release from late callbacks',
  (outcome) => {
    vi.useFakeTimers()
    try {
      const budget = createWebSocketFrameBudget()
      let authorized = true
      const clients = Array.from({ length: 4 }, () => {
        const socket = new Socket()
        const failure = vi.fn()
        const sender = createWebSocketFrameSender(socket as unknown as WebSocket, failure, {
          budget,
          isAuthorized: () => authorized,
          writeTimeoutMs: 30_000
        })
        return { socket, sender, failure }
      })
      const frame = 'x'.repeat(16 * 1024 * 1024)
      for (const client of clients) {
        for (let index = 0; index < 4; index++) expect(client.sender.send(frame)).toBe(true)
      }
      const extra = new Socket()
      const failure = vi.fn()
      expect(
        createWebSocketFrameSender(extra as unknown as WebSocket, failure, { budget }).send('x')
      ).toBe(false)
      expect(failure).toHaveBeenCalledExactlyOnceWith({ reason: 'shared-queue-budget' })
      expect(extra.terminate).toHaveBeenCalledOnce()
      if (outcome === 'complete') clients[0].socket.callbacks[0]()
      else if (outcome === 'revoked') {
        authorized = false
        clients[0].socket.callbacks[0]()
        expect(clients[0].socket.send).toHaveBeenCalledTimes(1)
      } else if (outcome === 'timeout') {
        vi.advanceTimersByTime(30_000)
        expect(clients[0].failure).toHaveBeenCalledExactlyOnceWith({
          reason: 'socket-write-timeout'
        })
        expect(clients[0].socket.terminate).toHaveBeenCalledOnce()
      } else clients[0].socket.emit(outcome)
      if (outcome !== 'complete') {
        clients[0].socket.emit('close')
        if (outcome !== 'error') clients[0].socket.emit('error')
        clients[0].socket.callbacks[0]()
      }
      const next = new Socket()
      const nextFailure = vi.fn()
      const sender = createWebSocketFrameSender(next as unknown as WebSocket, nextFailure, {
        budget
      })
      const releasedFrames = outcome === 'timeout' ? 16 : outcome === 'complete' ? 1 : 4
      // Refill all capacity that was released, across separate connections.
      for (let index = 0; index < releasedFrames; index++) {
        const consumer =
          index === 0
            ? sender
            : createWebSocketFrameSender(new Socket() as unknown as WebSocket, vi.fn(), { budget })
        expect(consumer.send(frame)).toBe(true)
      }
      expect(sender.send('x')).toBe(false)
      expect(nextFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'shared-queue-budget' })
    } finally {
      vi.useRealTimers()
    }
  }
)

it('bounds aggregate small frames across clients independently of the byte budget', () => {
  const budget = createWebSocketFrameBudget()
  const sockets = Array.from({ length: 4 }, () => new Socket())
  for (const socket of sockets) {
    const sender = createWebSocketFrameSender(socket as unknown as WebSocket, vi.fn(), { budget })
    for (let index = 0; index < 4096; index++) expect(sender.send('x')).toBe(true)
  }
  const extra = new Socket()
  const failure = vi.fn()
  const sender = createWebSocketFrameSender(extra as unknown as WebSocket, failure, { budget })
  expect(sender.send('x')).toBe(false)
  expect(failure).toHaveBeenCalledExactlyOnceWith({ reason: 'shared-queue-budget' })
  sockets[0].emit('close')
  const replacement = createWebSocketFrameSender(new Socket() as unknown as WebSocket, vi.fn(), {
    budget
  })
  for (let index = 0; index < 4096; index++) expect(replacement.send('x')).toBe(true)
})
