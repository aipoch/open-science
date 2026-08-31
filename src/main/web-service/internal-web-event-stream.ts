import { randomUUID } from 'node:crypto'

import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'

const DEFAULT_MAX_FRAMES = 2_048
// This buffer is deliberately process-local. A restart creates a new stream id, which makes clients
// stop and reload instead of assuming an in-memory suffix survived.
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

type InternalWebEvent = Readonly<{
  channel: string
  payload: unknown
}>

type InternalWebEventStreamOptions = Readonly<{
  streamId?: string
  maxFrames?: number
  maxBytes?: number
}>

type ResumeCursor = Readonly<{
  streamId: string
  after: number
}>

type RetainedFrame = Readonly<{
  sequence: number
  serialized: string
  bytes: number
}>

class InternalWebEventStream {
  readonly #streamId: string
  readonly #maxFrames: number
  readonly #maxBytes: number
  readonly #frames: RetainedFrame[] = []
  #latestSequence = 0
  #retainedBytes = 0

  constructor(options: InternalWebEventStreamOptions = {}) {
    this.#streamId = options.streamId ?? randomUUID()
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  cursor(): Readonly<{
    protocolVersion: typeof WEB_EVENT_STREAM_PROTOCOL_VERSION
    streamId: string
    latestSequence: number
  }> {
    return {
      protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
      streamId: this.#streamId,
      latestSequence: this.#latestSequence
    }
  }

  publish(event: InternalWebEvent): string {
    const sequence = ++this.#latestSequence
    const serialized = JSON.stringify({
      kind: 'event',
      protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
      streamId: this.#streamId,
      sequence,
      channel: event.channel,
      payload: event.payload ?? null
    })
    const bytes = Buffer.byteLength(serialized)

    if (bytes > this.#maxBytes || this.#maxFrames === 0) {
      this.#frames.splice(0)
      this.#retainedBytes = 0
      return serialized
    }

    this.#frames.push({ sequence, serialized, bytes })
    this.#retainedBytes += bytes
    while (this.#frames.length > this.#maxFrames || this.#retainedBytes > this.#maxBytes) {
      const removed = this.#frames.shift()
      if (removed) this.#retainedBytes -= removed.bytes
    }
    return serialized
  }

  heartbeat(): string {
    return JSON.stringify({
      kind: 'heartbeat',
      ...this.cursor()
    })
  }

  resume(cursor: ResumeCursor, minimumAfter = 0): readonly string[] {
    if (cursor.streamId !== this.#streamId) return [this.#resyncRequired('stream-changed')]

    const oldestSequence = this.#frames[0]?.sequence
    if (
      !Number.isSafeInteger(cursor.after) ||
      cursor.after < 0 ||
      cursor.after < minimumAfter ||
      cursor.after > this.#latestSequence ||
      (cursor.after < this.#latestSequence &&
        (oldestSequence === undefined || cursor.after < oldestSequence - 1))
    ) {
      return [this.#resyncRequired('cursor-expired')]
    }

    return [
      ...this.#frames
        .filter(({ sequence }) => sequence > cursor.after)
        .map(({ serialized }) => serialized),
      JSON.stringify({
        kind: 'ready',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: this.#streamId,
        latestSequence: this.#latestSequence
      })
    ]
  }

  #resyncRequired(reason: 'stream-changed' | 'cursor-expired'): string {
    return JSON.stringify({
      kind: 'resync-required',
      protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
      streamId: this.#streamId,
      latestSequence: this.#latestSequence,
      reason
    })
  }
}

export { InternalWebEventStream }
export type { InternalWebEventStreamOptions, ResumeCursor }
