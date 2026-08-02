import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HANDOFF_LIFECYCLE_IPC } from '../../shared/handoff-lifecycle'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))

const { registerHandoffLifecycleIpcHandlers } = await import('./handoff-lifecycle-ipc')

describe('handoff lifecycle IPC', () => {
  beforeEach(() => handlers.clear())

  it('exposes read-only session events and forwards retry intent to coordinator authority', async () => {
    const event = {
      id: 'handoff-1',
      sessionId: 'session-1',
      sequence: 1,
      observedAt: 1,
      phase: 'failed' as const,
      target: { kind: 'main' as const },
      provenance: {
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'user-1',
        attachmentIds: [],
        artifactIds: []
      },
      failure: {
        retryFrom: 'reconfiguring' as const,
        message: 'The approved handoff could not continue.'
      }
    }
    const coordinator = {
      getEvents: vi.fn(() => [event]),
      retry: vi.fn(async () => undefined)
    }
    registerHandoffLifecycleIpcHandlers(coordinator)

    const list = handlers.get(HANDOFF_LIFECYCLE_IPC.LIST)
    const retry = handlers.get(HANDOFF_LIFECYCLE_IPC.RETRY)
    expect(await list?.({}, { sessionId: 'session-1' })).toEqual([event])
    await retry?.({}, { sessionId: 'session-1', originatingTurnId: 'turn-1' })
    expect(coordinator.retry).toHaveBeenCalledWith({
      sessionId: 'session-1',
      originatingTurnId: 'turn-1'
    })
    expect(() => retry?.({}, { sessionId: 'session-1' })).toThrow(
      'originatingTurnId must be a non-empty string'
    )
  })
})
