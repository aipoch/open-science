import { describe, expect, it } from 'vitest'

import { TASK_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/task-api'
import { PublicTaskEventStream } from './public-task-event-stream'

const parseFrames = (frames: readonly string[]): unknown[] =>
  frames.map((frame) => JSON.parse(frame))

describe('PublicTaskEventStream', () => {
  it('assigns ordered sequences and replays a retained suffix before ready', () => {
    const stream = new PublicTaskEventStream({
      streamId: 'stream-1',
      maxFrames: 10,
      maxBytes: 10_000
    })
    const event = {
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'run.event' as const,
      data: {
        id: 'event-1',
        timestamp: 1,
        kind: 'message' as const,
        level: 'info' as const,
        role: 'assistant' as const,
        text: 'done'
      }
    }

    expect(JSON.parse(stream.publish(event))).toEqual({ sequence: 1, ...event })
    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      { sequence: 1, ...event },
      {
        type: 'stream.ready',
        data: {
          protocolVersion: TASK_EVENT_STREAM_PROTOCOL_VERSION,
          streamId: 'stream-1',
          latestSequence: 1
        }
      }
    ])
  })

  it('reports an explicit resync state when a cursor cannot be replayed', () => {
    const stream = new PublicTaskEventStream({
      streamId: 'stream-1',
      maxFrames: 1,
      maxBytes: 10_000
    })
    const event = {
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'run.event' as const,
      data: {
        id: 'event-1',
        timestamp: 1,
        kind: 'message' as const,
        level: 'info' as const,
        role: 'assistant' as const,
        text: 'done'
      }
    }
    stream.publish(event)
    stream.publish(event)

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }))).toEqual([
      {
        type: 'stream.resync-required',
        data: {
          protocolVersion: TASK_EVENT_STREAM_PROTOCOL_VERSION,
          streamId: 'stream-1',
          latestSequence: 2,
          reason: 'cursor-expired'
        }
      }
    ])
    expect(parseFrames(stream.resume({ streamId: 'old-stream', after: 2 }))).toEqual([
      {
        type: 'stream.resync-required',
        data: {
          protocolVersion: TASK_EVENT_STREAM_PROTOCOL_VERSION,
          streamId: 'stream-1',
          latestSequence: 2,
          reason: 'stream-changed'
        }
      }
    ])
  })

  it('refuses to replay frames older than an authorization floor', () => {
    const stream = new PublicTaskEventStream({ streamId: 'stream-1' })
    const event = {
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'run.event' as const,
      data: {
        id: 'event-1',
        timestamp: 1,
        kind: 'message' as const,
        level: 'info' as const,
        role: 'assistant' as const,
        text: 'done'
      }
    }
    stream.publish(event)
    stream.publish(event)

    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 0 }, 1))).toEqual([
      expect.objectContaining({
        type: 'stream.resync-required',
        data: expect.objectContaining({ reason: 'cursor-expired' })
      })
    ])
    expect(parseFrames(stream.resume({ streamId: 'stream-1', after: 1 }, 1))).toEqual([
      expect.objectContaining({ sequence: 2, type: 'run.event' }),
      expect.objectContaining({ type: 'stream.ready' })
    ])
  })
})
