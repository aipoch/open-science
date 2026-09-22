import { RuntimeWriterOwner } from '../../../../main/session-persistence/runtime-writer'
import { afterEach, expect, it, vi } from 'vitest'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { createStoreSaver } from '../session-persistence/session-persistence'
import {
  processWorkspaceRuntimeEvents,
  processIncrementalWorkspaceRuntimeEvents,
  syncWorkspaceContextUsage,
  markRunningSessionsDisconnectedOnDrop
} from './workspace-runtime-event-owner'
afterEach(() => vi.unstubAllGlobals())
it('an observer receiving background runtime events does not mutate or save a conversation', async () => {
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().hydrateSessions([
    {
      id: 'old-session',
      projectId: 'old-project',
      title: 'Existing',
      cwd: '/test',
      status: 'running',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
  ])
  useSessionStore.getState().clearSelection()
  const initial = useSessionStore.getState()
  const saveSession = vi.fn(async (session) => session)
  const api = {
    saveSession,
    loadAll: vi.fn(),
    loadOne: vi.fn(),
    deleteSession: vi.fn(),
    saveManifest: vi.fn()
  }
  const save = createStoreSaver(api, initial)
  const owner = new RuntimeWriterOwner()
  owner.claim('electron:desktop')
  vi.stubGlobal('window', {
    api: { lifecycle: { claimRuntimeWriter: vi.fn(async () => owner.claim('web:phone')) } }
  })
  const event = {
    id: 'runtime-event',
    kind: 'message' as const,
    role: 'assistant' as const,
    level: 'info' as const,
    sessionId: 'old-session',
    runId: 'run',
    timestamp: 2,
    text: 'A response visible on the desktop'
  }
  await processWorkspaceRuntimeEvents({ revision: 1, events: [event] })
  await processIncrementalWorkspaceRuntimeEvents([event])
  syncWorkspaceContextUsage(['old-session'], {})
  markRunningSessionsDisconnectedOnDrop('connected', 'closed')
  expect(useSessionStore.getState().sessions).toBe(initial.sessions)
  await save(useSessionStore.getState())
  expect(saveSession).not.toHaveBeenCalled()
  await save(useSessionStore.getState(), { forceTargets: new Set(['session:old-session']) })
  expect(saveSession).not.toHaveBeenCalled()
  useSessionStore.getState().renameSession('old-session', 'My explicit title edit')
  await save(useSessionStore.getState())
  expect(saveSession).toHaveBeenCalledTimes(1)
  expect(saveSession.mock.calls[0][0].title).toBe('My explicit title edit')
})
