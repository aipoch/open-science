import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSessionPersistenceHandlers } from './ipc'

const createSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
})

describe('session persistence IPC handlers', () => {
  it('routes each command to the repository', async () => {
    const session = createSession()
    const loadResult = { sessions: [session], manifest: { version: 1 as const } }
    const repository = {
      loadAll: vi.fn().mockResolvedValue(loadResult),
      saveSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createSessionPersistenceHandlers(repository)

    await expect(handlers.loadAll()).resolves.toBe(loadResult)

    await handlers.saveSession(session)
    expect(repository.saveSession).toHaveBeenCalledWith(session)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')

    await handlers.deleteProjectSessions({ projectId: 'project-a' })
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-a')

    await handlers.saveManifest({ lastProjectId: 'project-a', lastSessionId: 'session-1' })
    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-a',
      lastSessionId: 'session-1'
    })
  })
})
