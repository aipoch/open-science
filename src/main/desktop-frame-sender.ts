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
  | { reason: 'socket-write-failure' }

type PendingFrame = { frame: string; bytes: number; onSent?: () => void }

export function createDesktopFrameSender(
  socket: WebSocket,
  onFailure: (failure: OutboundFailure) => void
): { send(frame: string, onSent?: () => void): void } {
  const queue: PendingFrame[] = []
  let active: PendingFrame | undefined
  let retainedBytes = 0
  let closed = false

  const cleanup = (): void => {
    closed = true
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
    const sent = active!
    active = undefined
    retainedBytes -= sent.bytes
    sent.onSent?.()
    pump()
  }
  const pump = (): void => {
    if (closed || active || socket.readyState !== WebSocket.OPEN) return
    active = queue.shift()
    if (!active) return
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
      if (closed || socket.readyState !== WebSocket.OPEN) return
      const bytes = Buffer.byteLength(frame)
      if (bytes > MAX_FRAME_BYTES) {
        fail({
          reason: 'single-frame-too-large',
          frameBytes: Math.min(bytes, MAX_FRAME_BYTES + 1),
          bufferedBytes: Math.min(socket.bufferedAmount, MAX_FRAME_BYTES + 1),
          byteBudget: MAX_FRAME_BYTES
        })
        return
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
        return
      }
      retainedBytes += bytes
      queue.push({ frame, bytes, onSent })
      pump()
    }
  }
}
