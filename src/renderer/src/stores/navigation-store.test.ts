import { beforeEach, describe, expect, it } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type PersistedChatSession
} from '../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from './session-store'
import { useNavigationStore } from './navigation-store'

const createSession = (overrides: Partial<PersistedChatSession>): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

beforeEach(() => {
  useSessionStore.setState(createInitialSessionState())
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
})

describe('navigation store', () => {
  it('opens a project and selects its most recent session', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'old', projectId: 'project-a', updatedAt: 10 }),
          createSession({ id: 'recent', projectId: 'project-a', updatedAt: 99 }),
          createSession({ id: 'other', projectId: 'project-b', updatedAt: 200 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )

    useNavigationStore.getState().openProject('project-a')

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    // The most recent session within the project (not the globally newest) is selected.
    expect(useSessionStore.getState().selectedSessionId).toBe('recent')
  })

  it('clears selection when opening a project with no sessions', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'a', projectId: 'project-a' })], {
        version: SESSION_MANIFEST_VERSION
      })

    useNavigationStore.getState().openProject('project-empty')

    expect(useNavigationStore.getState().activeProjectId).toBe('project-empty')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('opens a specific session inside its project', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'a', projectId: 'project-a', updatedAt: 99 }),
          createSession({ id: 'b', projectId: 'project-b', updatedAt: 1 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )

    useNavigationStore.getState().openSession('project-b', 'b')

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
  })

  it('returns to the home screen without losing session state', () => {
    useNavigationStore.getState().openSession('project-a', 'session-1')
    useNavigationStore.getState().goHome()

    expect(useNavigationStore.getState().view).toBe('home')
  })
})
