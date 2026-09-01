import { randomUUID } from 'node:crypto'

import { TASK_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/task-api'
import type { PublicTaskEvent } from './application-event-projections'

const DEFAULT_MAX_FRAMES = 2_048
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

type PublicTaskEventStreamOptions = Readonly<{
  streamId?: string
  maxFrames?: number
  maxBytes?: number
}>

type PublicTaskEventCursor = Readonly<{
  streamId: string
  after: number
}>

type RetainedFrame = Readonly<{
  sequence: number
  serialized: string
  bytes: number
}>

class PublicTaskEventStream {
  readonly #streamId: string
  readonly #maxFrames: number
  readonly #maxBytes: number
  readonly #frames: RetainedFrame[] = []
  #latestSequence = 0
  #retainedBytes = 0

  constructor(options: PublicTaskEventStreamOptions = {}) {
    this.#streamId = options.streamId ?? randomUUID()
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  cursor(): Readonly<{
    protocolVersion: typeof TASK_EVENT_STREAM_PROTOCOL_VERSION
    streamId: string
    latestSequence: number
  }> {
    return {
      protocolVersion: TASK_EVENT_STREAM_PROTOCOL_VERSION,
      streamId: this.#streamId,
      latestSequence: this.#latestSequence
    }
  }

  publish(event: PublicTaskEvent): string {
    const sequence = ++this.#latestSequence
    const serialized = JSON.stringify({ sequence, ...event })
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

  resume(cursor: PublicTaskEventCursor, minimumAfter = 0): readonly string[] {
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
      this.ready()
    ]
  }

  ready(): string {
    return JSON.stringify({ type: 'stream.ready', data: this.cursor() })
  }

  #resyncRequired(reason: 'stream-changed' | 'cursor-expired'): string {
    return JSON.stringify({
      type: 'stream.resync-required',
      data: { ...this.cursor(), reason }
    })
  }
}

export { PublicTaskEventStream }
export type { PublicTaskEventCursor, PublicTaskEventStreamOptions }
