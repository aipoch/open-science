import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SPECIALIST_IPC } from '../../shared/specialist'
import { registerCompletionHandoffIpcHandlers } from './completion-handoff-ipc'

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
    handlers.set(channel, handler)
  }
}))

describe('completion handoff IPC', () => {
  beforeEach(() => handlers.clear())

  it('exposes read-only events and session-scoped retry/cancel commands', async () => {
    const lifecycle = {
      getEvents: vi.fn(async () => []),
      retryById: vi.fn(async () => undefined),
      cancelById: vi.fn(async () => undefined)
    }
    registerCompletionHandoffIpcHandlers(lifecycle)

    await handlers.get(SPECIALIST_IPC.GET_HANDOFF_EVENTS)?.(undefined, 'session-1')
    await handlers.get(SPECIALIST_IPC.RETRY_HANDOFF)?.(undefined, {
      id: 'handoff-1',
      sessionId: 'session-1'
    })
    await handlers.get(SPECIALIST_IPC.CANCEL_HANDOFF)?.(undefined, {
      id: 'handoff-1',
      sessionId: 'session-1'
    })

    expect(lifecycle.getEvents).toHaveBeenCalledWith('session-1')
    expect(lifecycle.retryById).toHaveBeenCalledWith('handoff-1', 'session-1')
    expect(lifecycle.cancelById).toHaveBeenCalledWith('handoff-1', 'session-1')
  })
})
