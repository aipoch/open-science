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
