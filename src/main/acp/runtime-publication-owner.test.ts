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
  it('publishes coalesced state on the renderer 33 ms presentation cadence', () => {
    vi.useFakeTimers()
    try {
      const onStateChanged = vi.fn()
      const owner = new AcpRuntimePublicationOwner({
        snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
        interactions: new AcpSessionInteractionOwner(),
        snapshotProjection: createProjection,
        callbacks: { onStateChanged }
      })

      owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'chunk' })
      vi.advanceTimersByTime(32)
      expect(onStateChanged).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onStateChanged).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending state publication without a late callback', () => {
    vi.useFakeTimers()
    try {
      const onStateChanged = vi.fn()
      const owner = new AcpRuntimePublicationOwner({
        snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
        interactions: new AcpSessionInteractionOwner(),
        snapshotProjection: createProjection,
        callbacks: { onStateChanged }
      })

      owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'chunk' })
      owner.cancelPendingStatePublication()
      vi.advanceTimersByTime(33)

      expect(onStateChanged).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes assistant text incrementally without scheduling snapshot delivery', () => {
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
    expect(order).toEqual(['event:one', 'event:two'])
  })

  it('publishes all runtime events incrementally until lifecycle state is explicitly requested', () => {
    let releaseScheduledState: (() => void) | undefined
    const onEvent = vi.fn()
    const onStateChanged = vi.fn()
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: { onEvent, onStateChanged },
      scheduleStatePublication: (publish) => {
        releaseScheduledState = publish
        return () => (releaseScheduledState = undefined)
      }
    })

    owner.pushEvent({ kind: 'thought', level: 'info', role: 'assistant', text: 'one' })
    owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'two' })
    owner.pushEvent({ kind: 'tool', level: 'info', toolCallId: 'tool-1', status: 'in_progress' })
    owner.pushEvent({ kind: 'tool', level: 'info', toolCallId: 'tool-1', status: 'completed' })
    owner.pushEvent({ kind: 'stop', level: 'info', text: 'end_turn' })
    owner.pushEvent({ kind: 'error', level: 'error', text: 'provider failed' })
    releaseScheduledState?.()

    expect(onEvent).toHaveBeenCalledTimes(6)
    expect(onStateChanged).not.toHaveBeenCalled()

    owner.emitState()
    expect(onStateChanged).toHaveBeenCalledOnce()
    expect(onStateChanged.mock.calls[0]?.[0].events).toHaveLength(6)
  })

  it('coalesces streamed assistant thought state', () => {
    let releaseScheduledState: (() => void) | undefined
    const onStateChanged = vi.fn()
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: { onStateChanged },
      scheduleStatePublication: (publish) => {
        releaseScheduledState = publish
        return () => (releaseScheduledState = undefined)
      }
    })

    owner.pushEvent({ kind: 'thought', level: 'info', role: 'assistant', text: 'one' })
    owner.pushEvent({ kind: 'thought', level: 'info', role: 'assistant', text: 'two' })

    expect(onStateChanged).not.toHaveBeenCalled()
    releaseScheduledState?.()
    expect(onStateChanged).toHaveBeenCalledOnce()
  })

  it('publishes a burst before retained events can evict unseen prefix chunks', () => {
    let releaseScheduledState: (() => void) | undefined
    const visibleChunks = new Map<string, string>()
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onStateChanged: (snapshot) => {
          for (const event of snapshot.events) {
            if (event.kind === 'message' && event.role === 'assistant' && event.text) {
              visibleChunks.set(event.id, event.text)
            }
          }
        }
      },
      scheduleStatePublication: (publish) => {
        releaseScheduledState = publish
        return () => {
          if (releaseScheduledState === publish) releaseScheduledState = undefined
        }
      }
    })
    const chunks = Array.from({ length: 600 }, (_, index) => `[${index}]`)

    for (const text of chunks) {
      owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text })
    }
    releaseScheduledState?.()

    expect([...visibleChunks.values()].join('')).toBe(chunks.join(''))
  })

  it('keeps incremental event order across a tool boundary', () => {
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

    expect(order).toEqual(['event:message', 'event:tool'])
  })

  it('coalesces progressive tool output but publishes completion immediately', () => {
    const snapshots: string[][] = []
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: {
        onStateChanged: (snapshot) =>
          snapshots.push(snapshot.events.map((event) => event.status ?? 'updating'))
      },
      scheduleStatePublication: () => () => undefined
    })

    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      toolCallId: 'tool-1',
      status: 'in_progress',
      terminalOutput: 'one'
    })
    expect(snapshots).toEqual([['in_progress']])

    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      toolCallId: 'tool-1',
      status: 'in_progress',
      rawInput: { command: 'echo repeated provider input' },
      terminalOutput: 'two'
    })
    expect(snapshots).toEqual([['in_progress']])

    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      toolCallId: 'tool-1',
      status: 'completed',
      terminalOutput: 'done'
    })
    expect(snapshots).toEqual([['in_progress'], ['in_progress', 'in_progress', 'completed']])
  })

  it('isolates tool lifecycles by session and resets abandoned calls at lifecycle boundaries', () => {
    const snapshots: number[] = []
    const owner = new AcpRuntimePublicationOwner({
      snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
      interactions: new AcpSessionInteractionOwner(),
      snapshotProjection: createProjection,
      callbacks: { onStateChanged: (snapshot) => snapshots.push(snapshot.events.length) },
      scheduleStatePublication: () => () => undefined
    })

    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1',
      toolCallId: 'reused-call',
      terminalOutput: 'first session start'
    })
    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-2',
      toolCallId: 'reused-call',
      terminalOutput: 'second session start'
    })
    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1',
      toolCallId: 'reused-call',
      terminalOutput: 'progressive output'
    })
    expect(snapshots).toEqual([1, 2])

    owner.pushEvent({ kind: 'stop', level: 'info', sessionId: 'session-1' })
    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1',
      toolCallId: 'reused-call',
      terminalOutput: 'next run start'
    })
    expect(snapshots).toEqual([1, 2, 4, 5])

    owner.cancelPendingStatePublication()
    owner.pushEvent({
      kind: 'tool',
      level: 'info',
      sessionId: 'session-2',
      toolCallId: 'reused-call',
      terminalOutput: 'next connection start'
    })
    expect(snapshots).toEqual([1, 2, 4, 5, 6])
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

  it('publishes an event after append hooks and before explicitly requested state', () => {
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

    owner.pushEvent({ kind: 'message', level: 'info', role: 'assistant', text: 'hello' }, () =>
      order.push('appended')
    )

    expect(order).toEqual(['appended', 'event'])
    owner.emitState()
    expect(order).toEqual(['appended', 'event', 'state'])
    expect(owner.getSnapshot().events).toEqual([
      expect.objectContaining({ id: 'acp-event-1', kind: 'message', text: 'hello' })
    ])
  })

  it('publishes permission event and callback before one lifecycle state', () => {
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

    expect(order).toEqual(['event', 'permission', 'state'])
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
      role: 'assistant',
      text: 'inherited'
    })
    owner.pushEvent({
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      promptMessageId: 'explicit-prompt',
      role: 'assistant',
      text: 'explicit'
    })
    interactions.release(prompt)
    const compaction = interactions.claim({ sessionId: 'session-1', kind: 'compaction' })
    owner.pushEvent({
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      role: 'assistant',
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
        role: 'assistant' as const,
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
    owner.pushEvent({
      kind: 'message',
      level: 'info',
      role: 'assistant',
      text: 'after reservation'
    })

    expect(owner.getSnapshot().sessionIds).toEqual(['session-2'])
    expect(owner.getSnapshot().events[0]?.id).toBe('acp-event-2')
    expect(snapshotProjection).toHaveBeenCalledTimes(3)
  })
})
