import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { refreshDelegatedWorkSessions } from './workspace-runtime-event-owner'

const createSession = (id: string, projectId: string, revision: number): PersistedChatSession => ({
  id,
  projectId,
  title: id,
  cwd: '/workspace',
  status: 'running',
  messages: [],
  runtimeContext: {
    version: 1,
    revision,
    delegatedWork: { records: [] }
  },
  createdAt: 1,
  updatedAt: revision
})

describe('delegated-work Session refresh', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads only the runtime-owned Sessions instead of scanning all durable Sessions', async () => {
    const first = createSession('session-1', 'project-1', 1)
    const second = createSession('session-2', 'project-2', 1)
    const refreshedFirst = createSession('session-1', 'project-1', 2)
    useSessionStore.getState().hydrateSessions([first, second])

    const loadOne = vi.fn().mockResolvedValue(refreshedFirst)
    const loadAll = vi.fn().mockResolvedValue({
      sessions: [refreshedFirst, second],
      manifest: { version: 1 }
    })
    vi.stubGlobal('window', {
      api: { sessions: { loadOne, loadAll } }
    } as unknown as Window)

    await refreshDelegatedWorkSessions(['session-1'])

    expect(loadOne).toHaveBeenCalledOnce()
    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-1' })
    expect(loadAll).not.toHaveBeenCalled()
    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ id: 'session-1', runtimeContext: { revision: 2 } })
    expect(sessions[1]).toMatchObject({ id: 'session-2', runtimeContext: { revision: 1 } })
  })
})
