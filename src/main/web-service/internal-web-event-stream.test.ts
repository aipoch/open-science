import { describe, expect, it } from 'vitest'

import { WEB_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'
import { InternalWebEventStream } from './internal-web-event-stream'

const parseFrames = (frames: readonly string[]): unknown[] =>
  frames.map((frame) => JSON.parse(frame))

describe('InternalWebEventStream', () => {
  it('replays retained event frames in sequence before declaring the stream live', () => {
    const stream = new InternalWebEventStream({
      streamId: 'stream-1',
      maxFrames: 10,
      maxBytes: 10_000
    })

    stream.publish({ channel: 'project:created', payload: { id: 'project-1' } })
    stream.publish({ channel: 'settings:changed', payload: undefined })

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      {
        kind: 'event',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        sequence: 1,
        channel: 'project:created',
        payload: { id: 'project-1' }
      },
      {
        kind: 'event',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        sequence: 2,
        channel: 'settings:changed',
        payload: null
      },
      {
        kind: 'ready',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        latestSequence: 2
      }
    ])
  })

  it('requires resynchronization when the requested suffix was evicted by frame count', () => {
    const stream = new InternalWebEventStream({
      streamId: 'stream-1',
      maxFrames: 2,
      maxBytes: 10_000
    })

    stream.publish({ channel: 'settings:changed', payload: { revision: 1 } })
    stream.publish({ channel: 'settings:changed', payload: { revision: 2 } })
    stream.publish({ channel: 'settings:changed', payload: { revision: 3 } })

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      {
        kind: 'resync-required',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        latestSequence: 3,
        reason: 'cursor-expired'
      }
    ])
  })

  it('evicts by aggregate serialized bytes while retaining a contiguous suffix', () => {
    const event = { channel: 'settings:changed', payload: { revision: 1 } }
    const probe = new InternalWebEventStream({
      streamId: 'stream-1',
      maxFrames: 10,
      maxBytes: 10_000
    })
    const frameBytes = Buffer.byteLength(probe.publish(event))
    const stream = new InternalWebEventStream({
      streamId: 'stream-1',
      maxFrames: 10,
      maxBytes: frameBytes * 2 - 1
    })

    stream.publish(event)
    stream.publish({ ...event, payload: { revision: 2 } })

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      expect.objectContaining({ kind: 'resync-required', reason: 'cursor-expired' })
    ])
    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 1 }))).toEqual([
      expect.objectContaining({ kind: 'event', sequence: 2 }),
      expect.objectContaining({ kind: 'ready', latestSequence: 2 })
    ])
  })

  it('requires resynchronization when a frame is too large to retain', () => {
    const stream = new InternalWebEventStream({
      streamId: 'stream-1',
      maxFrames: 10,
      maxBytes: 1
    })

    stream.publish({ channel: 'settings:changed', payload: { value: 'not-retained' } })

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      {
        kind: 'resync-required',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-1',
        latestSequence: 1,
        reason: 'cursor-expired'
      }
    ])
  })

  it('requires resynchronization when the server process stream changes', () => {
    const stream = new InternalWebEventStream({
      streamId: 'stream-new',
      maxFrames: 10,
      maxBytes: 10_000
    })

    expect(parseFrames(stream.resume({ streamId: 'stream-old', after: 4 }))).toEqual([
      {
        kind: 'resync-required',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: 'stream-new',
        latestSequence: 0,
        reason: 'stream-changed'
      }
    ])
  })

  it('refuses to replay frames older than an authorization floor', () => {
    const stream = new InternalWebEventStream({ streamId: 'stream-1' })
    stream.publish({ channel: 'settings:changed', payload: { revision: 1 } })
    stream.publish({ channel: 'settings:changed', payload: { revision: 2 } })

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }, 1))).toEqual([
      expect.objectContaining({ kind: 'resync-required', reason: 'cursor-expired' })
    ])
    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 1 }, 1))).toEqual([
      expect.objectContaining({ kind: 'event', sequence: 2 }),
      expect.objectContaining({ kind: 'ready', latestSequence: 2 })
    ])
  })
})
