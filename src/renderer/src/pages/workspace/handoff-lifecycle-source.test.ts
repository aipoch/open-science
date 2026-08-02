// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'
import type { CompletionHandoffLifecycleEvent } from '../../../../shared/specialist'

import { IpcHandoffLifecycleClient } from './handoff-lifecycle-source'

const event = (
  sequence: number,
  phase: HandoffLifecycleEvent['phase']
): CompletionHandoffLifecycleEvent => ({
  id: 'handoff-1',
  sessionId: 'session-1',
  sequence,
  observedAt: sequence,
  phase,
  target: null,
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'user-1',
    attachmentIds: [],
    artifactIds: []
  }
})

describe('IPC handoff lifecycle client', () => {
  it('keeps the empty event snapshot stable before a session has handoff events', () => {
    const api = {
      getHandoffEvents: vi.fn(async () => []),
      retryHandoff: vi.fn(async () => undefined),
      onHandoffLifecycleEvent: vi.fn(() => () => undefined)
    }
    const client = new IpcHandoffLifecycleClient(() => api)

    expect(client.getEvents('session-1')).toBe(client.getEvents('session-1'))
  })

  it('hydrates retained events, follows live updates, and forwards only a retry intent', async () => {
    let onChanged: ((next: CompletionHandoffLifecycleEvent) => void) | undefined
    const api = {
      getHandoffEvents: vi.fn(async () => [event(1, 'switching')]),
      retryHandoff: vi.fn(async () => undefined),
      onHandoffLifecycleEvent: vi.fn((listener: typeof onChanged) => {
        onChanged = listener
        return () => {
          onChanged = undefined
        }
      })
    }
    const client = new IpcHandoffLifecycleClient(() => api)
    const listener = vi.fn()
    client.subscribe(listener)

    await client.load('session-1')
    onChanged?.(event(2, 'reconfiguring'))
    await client.retry({ sessionId: 'session-1', originatingTurnId: 'turn-1' })

    expect(client.getEvents('session-1').map((item) => item.phase)).toEqual(['reconfiguring'])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(api.retryHandoff).toHaveBeenCalledWith({ id: 'handoff-1', sessionId: 'session-1' })
  })

  it('removes a declined approval card from the live lifecycle projection', async () => {
    let onChanged: ((next: CompletionHandoffLifecycleEvent) => void) | undefined
    const api = {
      getHandoffEvents: vi.fn(async () => [event(1, 'awaiting-approval')]),
      retryHandoff: vi.fn(async () => undefined),
      onHandoffLifecycleEvent: vi.fn((listener: typeof onChanged) => {
        onChanged = listener
        return () => undefined
      })
    }
    const client = new IpcHandoffLifecycleClient(() => api)
    client.subscribe(vi.fn())
    await client.load('session-1')

    onChanged?.({ ...event(1, 'awaiting-approval'), removed: true })
    expect(client.getEvents('session-1')).toEqual([])
  })
})
