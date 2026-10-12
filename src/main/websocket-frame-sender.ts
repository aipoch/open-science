import { WebSocket } from 'ws'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
// Several legal Notebook/session responses can finish together during renderer hydration.
// Retain a bounded burst, while allowing only one frame into the socket's write buffer.
const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024
// Cover the event stream's 2,048-frame replay window plus concurrent command replies.
const MAX_OUTBOUND_FRAMES = 4_096

type OutboundFailure =
  | {
      reason: 'single-frame-too-large'
      frameBytes: number
      bufferedBytes: number
      byteBudget: number
    }
  | {
      reason: 'outbound-queue-budget'
      queuedBytes: number
      queuedFrames: number
      byteBudget: number
      frameBudget: number
    }
  | {
      reason:
        | 'socket-write-failure'
        | 'socket-write-timeout'
        | 'shared-queue-budget'
        | 'socket-buffer-budget'
    }

type PendingFrame = { frame: string; bytes: number; onSent?: () => void }

// One budget per Web server, shared by every event socket (including remote principals).
export function createWebSocketFrameBudget(): {
  reserve(bytes: number): boolean
  release(bytes: number, frames: number): void
} {
  let retainedBytes = 0
  let retainedFrames = 0
  return {
    reserve(bytes) {
      if (retainedBytes + bytes > 256 * 1024 * 1024 || retainedFrames >= 16_384) return false
      retainedBytes += bytes
      retainedFrames += 1
      return true
    },
    release(bytes, frames) {
      retainedBytes -= bytes
      retainedFrames -= frames
    }
  }
}

export function createWebSocketFrameSender(
  socket: WebSocket,
  onFailure: (failure: OutboundFailure) => void,
  options: {
    maxFrameBytes?: number
    budget?: ReturnType<typeof createWebSocketFrameBudget>
    isAuthorized?: () => boolean
    writeTimeoutMs?: number
  } = {}
): { send(frame: string, onSent?: () => void): boolean } {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const queue: PendingFrame[] = []
  let active: PendingFrame | undefined
  let retainedBytes = 0
  let closed = false
  let writeTimer: ReturnType<typeof setTimeout> | undefined

  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearTimeout(writeTimer)
    options.budget?.release(retainedBytes, queue.length + (active ? 1 : 0))
    queue.length = 0
    active = undefined
    retainedBytes = 0
  }
  const fail = (failure: OutboundFailure): void => {
    if (closed) return
    cleanup()
    onFailure(failure)
    socket.terminate()
  }
  const complete = (error?: Error): void => {
    if (closed) return
    if (error) {
      fail({ reason: 'socket-write-failure' })
      return
    }
    clearTimeout(writeTimer)
    const sent = active!
    options.budget?.release(sent.bytes, 1)
    active = undefined
    retainedBytes -= sent.bytes
    sent.onSent?.()
    pump()
  }
  const pump = (): void => {
    if (closed || active || socket.readyState !== WebSocket.OPEN) return
    if (options.isAuthorized && !options.isAuthorized()) {
      cleanup()
      return
    }
    active = queue.shift()
    if (!active) return
    if (socket.bufferedAmount + active.bytes > maxFrameBytes) {
      fail({ reason: 'socket-buffer-budget' })
      return
    }
    if (options.writeTimeoutMs !== undefined) {
      writeTimer = setTimeout(
        () => fail({ reason: 'socket-write-timeout' }),
        options.writeTimeoutMs
      )
      writeTimer.unref()
    }
    try {
      socket.send(active.frame, complete)
    } catch {
      fail({ reason: 'socket-write-failure' })
    }
  }
  socket.once('close', cleanup)
  socket.once('error', cleanup)
  return {
    send(frame, onSent) {
      if (closed || socket.readyState !== WebSocket.OPEN) return false
      const bytes = Buffer.byteLength(frame)
      if (bytes > maxFrameBytes || socket.bufferedAmount > maxFrameBytes) {
        fail({
          reason: 'single-frame-too-large',
          frameBytes: Math.min(bytes, maxFrameBytes + 1),
          bufferedBytes: Math.min(socket.bufferedAmount, maxFrameBytes + 1),
          byteBudget: maxFrameBytes
        })
        return false
      }
      const count = queue.length + (active ? 1 : 0) + 1
      if (retainedBytes + bytes > MAX_OUTBOUND_BYTES || count > MAX_OUTBOUND_FRAMES) {
        fail({
          reason: 'outbound-queue-budget',
          queuedBytes: Math.min(retainedBytes + bytes, MAX_OUTBOUND_BYTES + 1),
          queuedFrames: Math.min(count, MAX_OUTBOUND_FRAMES + 1),
          byteBudget: MAX_OUTBOUND_BYTES,
          frameBudget: MAX_OUTBOUND_FRAMES
        })
        return false
      }
      if (options.budget && !options.budget.reserve(bytes)) {
        fail({ reason: 'shared-queue-budget' })
        return false
      }
      retainedBytes += bytes
      queue.push({ frame, bytes, onSent })
      pump()
      return !closed
    }
  }
}
