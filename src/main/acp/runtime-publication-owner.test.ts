import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionRequest } from '../../shared/acp'
import { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import { AcpRuntimeSnapshotOwner, type RuntimeSnapshotProjection } from './runtime-snapshot-owner'
import { AcpSessionInteractionOwner } from './session-interaction-owner'

const createProjection = (): RuntimeSnapshotProjection => ({
  sessionIds: ['session-1'],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: { 'session-1': [] },
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

describe('AcpRuntimePublicationOwner', () => {
  it('coalesces assistant text state while publishing every event immediately', () => {
    const order: string[] = []
    let releaseScheduledState: (() => void) | undefined
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onEvent: (event) => order.push(`event:${event.text}`),
        onStateChanged: (snapshot) => order.push(`state:${snapshot.events.length}`)
      },
      scheduleStatePublication: (publish) => {
        releaseScheduledState = publish
        return () => (releaseScheduledState = undefined)
      }
    })

    owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'one' })
    owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'two' })

    expect(order).toEqual(['event:one', 'event:two'])
    releaseScheduledState?.()
    expect(order).toEqual(['event:one', 'event:two', 'state:2'])
  })

  it('flushes pending assistant text at a tool boundary without losing event order', () => {
    const order: string[] = []
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onEvent: (event) => order.push(`event:${event.kind}`),
        onStateChanged: (snapshot) => order.push(`state:${snapshot.events.length}`)
      },
      scheduleStatePublication: () => () => undefined
    })

    owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'before' })
    owner.pushEvent({ kind: 'tool', level: 'info', toolCallId: 'tool-1', status: 'in_progress' })

    expect(order).toEqual(['event:message', 'event:tool', 'state:2'])
  })

  it('keeps a mixed 121-event burst within the frame and boundary publication budget', () => {
    let scheduledState: (() => void) | undefined
    let eventPublications = 0
    let statePublications = 0
    const snapshotOwner = new AcpRuntimeSnapshotOwner('/workspace')
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner,
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onEvent: () => (eventPublications += 1),
        onStateChanged: () => (statePublications += 1)
      },
      scheduleStatePublication: (publish) => {
        scheduledState = publish
        return () => {
          if (scheduledState === publish) scheduledState = undefined
        }
      }
    })

    for (let index = 0; index < 60; index += 1) {
      owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: `${index}` })
    }
    owner.pushEvent({ kind: 'tool', level: 'info', toolCallId: 'tool-1', status: 'completed' })
    for (let index = 0; index < 60; index += 1) {
      owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: `${index}` })
    }
    scheduledState?.()

    expect(eventPublications).toBe(121)
    expect(snapshotOwner.snapshot(createProjection()).events).toHaveLength(121)
    expect(statePublications).toBeLessThanOrEqual(3)
  })

  it('publishes an event only after append hooks and before the resulting state', () => {
    const order: string[] = []
    const snapshotOwner = new AcpRuntimeSnapshotOwner('/workspace')
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner,
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onEvent: () => order.push('event'),
        onStateChanged: () => order.push('state')
      }
    })

    owner.pushEvent({ kind: 'message', level: 'info', text: 'hello' }, () => order.push('appended'))

    expect(order).toEqual(['appended', 'event', 'state'])
    expect(owner.getSnapshot().events).toEqual([
      expect.objectContaining({ id: 'acp-event-1', kind: 'message', text: 'hello' })
    ])
  })

  it('keeps the established permission event-state-callback-state order', () => {
    const order: string[] = []
    const request: AcpPermissionRequest = {
      requestId: 'request-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: []
    }
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onEvent: () => order.push('event'),
        onStateChanged: () => order.push('state'),
        onPermissionRequest: () => order.push('permission')
      }
    })

    owner.publishPermissionRequest(request)

    expect(order).toEqual(['event', 'state', 'permission', 'state'])
    expect(owner.getSnapshot().events[0]).toMatchObject({
      kind: 'permission',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      raw: request
    })
  })

  it('attaches only the active prompt id and preserves an explicit event id', () => {
    const interactions = new AcpSessionInteractionOwner()
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions,
      snapshotProjection: createProjection,
      callbacks: {}
    })
    const prompt = interactions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'active-prompt'
    })

    owner.pushEvent({
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      text: 'inherited'
    })
    owner.pushEvent({
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      promptMessageId: 'explicit-prompt',
      text: 'explicit'
    })
    interactions.release(prompt)
    const compaction = interactions.claim({ sessionId: 'session-1', kind: 'compaction' })
    owner.pushEvent({
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      text: 'compaction'
    })
    interactions.release(compaction)

    expect(owner.getSnapshot().events).toEqual([
      expect.objectContaining({ text: 'inherited', promptMessageId: 'active-prompt' }),
      expect.objectContaining({ text: 'explicit', promptMessageId: 'explicit-prompt' }),
      expect.objectContaining({ text: 'compaction', promptMessageId: undefined })
    ])
  })

  it('retains a frozen event with the inherited prompt id intact', () => {
    const interactions = new AcpSessionInteractionOwner()
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions,
      snapshotProjection: createProjection,
      callbacks: {}
    })
    const prompt = interactions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'active-prompt'
    })

    // The projector deep-freezes its events; scoping must not drop fields or corrupt retention.
    owner.pushEvent(
      Object.freeze({
        kind: 'message' as const,
        level: 'info' as const,
        sessionId: 'session-1',
        text: 'frozen-chunk'
      })
    )
    interactions.release(prompt)

    expect(owner.getSnapshot().events).toEqual([
      expect.objectContaining({ text: 'frozen-chunk', promptMessageId: 'active-prompt' })
    ])
    owner.cancelPendingStatePublication()
  })

  it('reads every snapshot projection live and shares the snapshot event sequence', () => {
    const snapshotOwner = new AcpRuntimeSnapshotOwner('/workspace')
    const snapshotProjection = vi
      .fn<() => RuntimeSnapshotProjection>()
      .mockReturnValueOnce(createProjection())
      .mockReturnValue({ ...createProjection(), sessionIds: ['session-2'] })
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner,
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection,
      callbacks: {}
    })

    expect(owner.getSnapshot().sessionIds).toEqual(['session-1'])
    expect(owner.nextEventId()).toBe('acp-event-1')
    owner.pushEvent({ kind: 'message', level: 'info', text: 'after reservation' })

    expect(owner.getSnapshot().sessionIds).toEqual(['session-2'])
    expect(owner.getSnapshot().events[0]?.id).toBe('acp-event-2')
    expect(snapshotProjection).toHaveBeenCalledTimes(3)
  })
})
