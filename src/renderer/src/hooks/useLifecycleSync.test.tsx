// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionUpsertEvent
} from '../../../shared/lifecycle-events'
import type { Project } from '../../../shared/projects'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useLifecycleSync } from './useLifecycleSync'

const listeners: {
  projectCreated?: (project: Project) => void
  projectUpdated?: (project: Project) => void
  projectDeleted?: (event: ProjectDeletedEvent) => void
  sessionCreated?: (event: SessionUpsertEvent) => void
  sessionUpdated?: (event: SessionUpsertEvent) => void
  sessionDeleted?: (event: SessionDeletedEvent) => void
} = {}

const Harness = ({
  isSessionPersistenceReady = true
}: {
  isSessionPersistenceReady?: boolean
}): React.JSX.Element => {
  const lifecycleSync = useLifecycleSync({ isSessionPersistenceReady })
  return (
    <button
      type="button"
      data-notice-session={lifecycleSync.notice?.sessionId ?? ''}
      onClick={lifecycleSync.viewNotice}
    >
      View notice
    </button>
  )
}

const project: Project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: SessionUpsertEvent['session'] = {
  id: 'session-1',
  projectId: project.id,
  title: 'External session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

describe('useLifecycleSync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
    useSessionStore.setState(createInitialSessionState())
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })

    const subscribe =
      <Payload,>(key: keyof typeof listeners) =>
      (listener: (payload: Payload) => void): (() => void) => {
        listeners[key] = listener as never
        return vi.fn()
      }

    window.api = {
      lifecycle: {
        getClientId: vi.fn().mockResolvedValue('electron:7')
      },
      projects: {
        onCreated: subscribe<Project>('projectCreated'),
        onUpdated: subscribe<Project>('projectUpdated'),
        onDeleted: subscribe<ProjectDeletedEvent>('projectDeleted')
      },
      sessions: {
        onCreated: subscribe<SessionUpsertEvent>('sessionCreated'),
        onUpdated: subscribe<SessionUpsertEvent>('sessionUpdated'),
        onDeleted: subscribe<SessionDeletedEvent>('sessionDeleted')
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('upserts external projects and sessions and opens the toast target', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })

    expect(useProjectStore.getState().projects).toEqual([project])
    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    const noticeButton = container.querySelector<HTMLButtonElement>('button')
    expect(noticeButton?.dataset.noticeSession).toBe(session.id)

    await act(async () => noticeButton?.click())

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
    expect(noticeButton?.dataset.noticeSession).toBe('')
  })

  it('replays lifecycle events after initial snapshots finish hydrating', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      root.render(<Harness isSessionPersistenceReady={false} />)
    })
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })

    await act(async () => {
      useProjectStore.setState({ ...createInitialProjectState(), isLoaded: true })
      useSessionStore.getState().hydrateSessions([])
      root.render(<Harness />)
    })

    expect(useProjectStore.getState().projects).toEqual([project])
    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe(
      session.id
    )
  })

  it('does not notify for a session created by this renderer', async () => {
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'electron:7' })
    })

    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('applies session updates without showing a created notice', async () => {
    const updatedSession = { ...session, title: 'Updated session', updatedAt: 2 }

    await act(async () => {
      listeners.sessionUpdated?.({ session: updatedSession, originClientId: 'web:external' })
    })

    expect(useSessionStore.getState().sessions[0]?.title).toBe('Updated session')
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('removes a deleted session and clears its notice', async () => {
    await act(async () => {
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
      listeners.sessionDeleted?.({ projectId: project.id, sessionId: session.id })
    })

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.noticeSession).toBe('')
  })

  it('upserts project updates', async () => {
    const updatedProject = { ...project, name: 'Updated project', updatedAt: 2 }

    await act(async () => {
      listeners.projectUpdated?.(updatedProject)
    })

    expect(useProjectStore.getState().projects).toEqual([updatedProject])
  })

  it('replays deletions after stale initial snapshots hydrate', async () => {
    await act(async () => {
      useProjectStore.setState(createInitialProjectState())
      useSessionStore.setState(createInitialSessionState())
      root.render(<Harness isSessionPersistenceReady={false} />)
    })
    await act(async () => {
      listeners.projectDeleted?.({ projectId: project.id })
    })

    await act(async () => {
      useProjectStore.setState({
        ...createInitialProjectState(),
        projects: [project],
        isLoaded: true
      })
      useSessionStore.getState().hydrateSessions([session])
      root.render(<Harness />)
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('removes externally deleted data and returns an active project to Home', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionCreated?.({ session, originClientId: 'web:external' })
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    await act(async () => {
      listeners.projectDeleted?.({ projectId: project.id })
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useNavigationStore.getState().view).toBe('home')
  })
})
