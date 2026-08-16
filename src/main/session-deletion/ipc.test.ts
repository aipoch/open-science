import { beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcastLifecycleEvent, handlers } = vi.hoisted(() => ({
  broadcastLifecycleEvent: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
vi.mock('../lifecycle-broadcast', () => ({ broadcastLifecycleEvent }))

import { registerSessionDeletionIpcHandler } from './ipc'

const request = { projectId: 'project-1', sessionId: 'session-1' }

describe('Session deletion IPC', () => {
  beforeEach(() => {
    handlers.clear()
    broadcastLifecycleEvent.mockClear()
  })

  it('returns the owner result and broadcasts only committed deletion', async () => {
    const result = { status: 'deleted' as const, runtimeDetached: true as const }
    const command = { delete: vi.fn().mockResolvedValue(result) }
    registerSessionDeletionIpcHandler(command)

    await expect(handlers.get('sessions:delete-session')?.({}, request)).resolves.toEqual(result)
    expect(command.delete).toHaveBeenCalledWith(request)
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:deleted', request)
  })

  it('does not publish deletion for a partial failure', async () => {
    const result = {
      status: 'failed' as const,
      reason: 'persistence' as const,
      runtimeDetached: true as const
    }
    registerSessionDeletionIpcHandler({ delete: vi.fn().mockResolvedValue(result) })

    await expect(handlers.get('sessions:delete-session')?.({}, request)).resolves.toEqual(result)
    expect(broadcastLifecycleEvent).not.toHaveBeenCalled()
  })
})
