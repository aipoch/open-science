// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useResearchDemoStore } from '@/stores/research-demo-store'

const persistenceMocks = vi.hoisted(() => ({
  hydratePersistedSessionIfPresent: vi.fn(),
  loadPersistedSession: vi.fn()
}))
const sidebarSessions = vi.hoisted(() => vi.fn())

vi.mock('@/lib/session-persistence/session-persistence', () => persistenceMocks)

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: ({
    sessions,
    onPreviewSession,
    otherProjects = [],
    onOpenProject
  }: {
    sessions: ChatSession[]
    onPreviewSession?: (sessionId: string) => Promise<void> | void
    otherProjects?: Array<Pick<Project, 'id' | 'name' | 'description'>>
    onOpenProject?: (projectId: string) => void
  }) => {
    sidebarSessions(sessions)
    return (
      <div>
        <button type="button" onClick={() => void onPreviewSession?.('lazy-session')}>
          Preview Session
        </button>
        {otherProjects.map((project) => (
          <button
            key={project.id}
            type="button"
            data-project-id={project.id}
            onClick={() => onOpenProject?.(project.id)}
          >
            {project.name}
            {project.description}
          </button>
        ))}
      </div>
    )
  }
}))

import { WorkspaceSidebarContainer } from './WorkspaceSidebarContainer'
import { visibleProjectSessions } from './visible-project-sessions'

const lazySession: ChatSession = {
  id: 'lazy-session',
  projectId: 'project-1',
  title: 'Lazy Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  contentLoaded: false
}

const createProject = (overrides: Partial<Project>): Project => ({
  id: 'project-1',
  name: 'Project 1',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

beforeEach(() => {
  sidebarSessions.mockClear()
  useResearchDemoStore.setState({ carriersByProject: {} })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { researchDemos: { carriers: vi.fn().mockResolvedValue([]) } }
  })
  persistenceMocks.hydratePersistedSessionIfPresent.mockReset()
  persistenceMocks.loadPersistedSession.mockReset()
  useSessionStore.setState({ sessions: [lazySession] })
  useProjectStore.setState(createInitialProjectState())
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-1',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0
  })
  window.localStorage.clear()
})

describe('WorkspaceSidebarContainer Session previews', () => {
  it('groups only indexed demo carriers and keeps old discussions plus an explicitly opened carrier accessible', async () => {
    const carrier = { ...lazySession, id: 'carrier', title: 'Same title' }
    const oldDiscussion = { ...lazySession, id: 'old-86', title: 'Same title' }
    useSessionStore.setState({ sessions: [lazySession, carrier, oldDiscussion] })
    vi.mocked(window.api.researchDemos.carriers).mockResolvedValue([
      {
        sessionId: 'carrier',
        source: { projectId: 'project-1', sourceSessionId: 'source', sourceImportId: 'import' }
      }
    ])
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () =>
        root.render(
          <WorkspaceSidebarContainer
            {...({ projectId: 'project-1', isProjectArchived: false } as ComponentProps<
              typeof WorkspaceSidebarContainer
            >)}
          />
        )
      )
      expect(sidebarSessions.mock.lastCall?.[0].map((session: ChatSession) => session.id)).toEqual([
        'lazy-session',
        'old-86'
      ])
      await act(async () =>
        root.render(
          <WorkspaceSidebarContainer
            {...({
              projectId: 'project-1',
              isProjectArchived: false,
              activeSessionId: 'carrier'
            } as ComponentProps<typeof WorkspaceSidebarContainer>)}
          />
        )
      )
      expect(sidebarSessions.mock.lastCall?.[0].map((session: ChatSession) => session.id)).toEqual([
        'lazy-session',
        'carrier',
        'old-86'
      ])
    } finally {
      await act(async () => root.unmount())
    }
  })
  it('hides only explicitly bound seeds and reveals them after release', () => {
    const pending = {
      ...lazySession,
      id: 'pending',
      isPending: true,
      pendingBindingSessionId: 'seed'
    }
    const seed = { ...lazySession, id: 'seed' }
    const sameTitle = { ...seed, id: 'independent' }
    const otherProject = {
      ...pending,
      id: 'other-pending',
      projectId: 'other-project',
      pendingBindingSessionId: 'independent'
    }
    const sessions = [pending, seed, sameTitle, otherProject]
    expect(visibleProjectSessions(sessions, 'project-1')).toEqual([pending, sameTitle])
    expect(
      visibleProjectSessions(
        [{ ...pending, pendingBindingSessionId: undefined }, seed, sameTitle],
        'project-1'
      )
    ).toHaveLength(3)
    expect(
      visibleProjectSessions([{ ...pending, archivedAt: 1 }, seed, sameTitle], 'project-1')
    ).toEqual([seed, sameTitle])
  })

  it('loads lazy Session details on demand and deduplicates concurrent requests', async () => {
    let resolveLoad: ((value: { id: string; projectId: string }) => void) | undefined
    persistenceMocks.loadPersistedSession.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebarContainer
            {...({
              projectId: 'project-1',
              isProjectArchived: false
            } as ComponentProps<typeof WorkspaceSidebarContainer>)}
          />
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Preview trigger did not render')

      await act(async () => {
        trigger.click()
        trigger.click()
      })

      expect(persistenceMocks.loadPersistedSession).toHaveBeenCalledOnce()
      expect(persistenceMocks.loadPersistedSession).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'lazy-session'
      })

      await act(async () => resolveLoad?.({ id: 'lazy-session', projectId: 'project-1' }))

      expect(persistenceMocks.hydratePersistedSessionIfPresent).toHaveBeenCalledWith({
        id: 'lazy-session',
        projectId: 'project-1'
      })
    } finally {
      act(() => root.unmount())
    }
  })

  it('does not load details for an already hydrated Session', async () => {
    useSessionStore.setState({ sessions: [{ ...lazySession, contentLoaded: undefined }] })
    const container = document.createElement('div')
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebarContainer
            {...({
              projectId: 'project-1',
              isProjectArchived: false
            } as ComponentProps<typeof WorkspaceSidebarContainer>)}
          />
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Preview trigger did not render')

      await act(async () => trigger.click())

      expect(persistenceMocks.loadPersistedSession).not.toHaveBeenCalled()
    } finally {
      act(() => root.unmount())
    }
  })
})

describe('WorkspaceSidebarContainer Project switching', () => {
  it('passes only other active projects in store order and opens one without a mobile close callback', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [
        createProject({ id: 'project-new', name: 'Newer', description: 'Newest active project' }),
        createProject({ id: 'project-1', name: 'Current', updatedAt: 3 }),
        createProject({ id: 'project-archived', name: 'Archived', archivedAt: 4, updatedAt: 2 }),
        createProject({ id: 'project-old', name: 'Older', description: 'Older active project' })
      ],
      isLoaded: true
    })
    const container = document.createElement('div')
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebarContainer
            {...({
              projectId: 'project-1',
              isProjectArchived: false
            } as ComponentProps<typeof WorkspaceSidebarContainer>)}
          />
        )
      })

      const projectButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-project-id]')
      )
      expect(projectButtons.map((button) => button.dataset.projectId)).toEqual([
        'project-new',
        'project-old'
      ])
      expect(projectButtons[0]?.textContent).toBe('NewerNewest active project')

      await act(async () => projectButtons[0]?.click())

      expect(useNavigationStore.getState().activeProjectId).toBe('project-new')
      expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    } finally {
      act(() => root.unmount())
    }
  })

  it('closes mobile navigation after opening the selected project', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [
        createProject({ id: 'project-1', name: 'Current' }),
        createProject({ id: 'project-2', name: 'Target' })
      ],
      isLoaded: true
    })
    const onMobileClose = vi.fn(() => {
      expect(useNavigationStore.getState().activeProjectId).toBe('project-2')
    })
    const container = document.createElement('div')
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebarContainer
            {...({
              projectId: 'project-1',
              isProjectArchived: false
            } as ComponentProps<typeof WorkspaceSidebarContainer>)}
            onMobileClose={onMobileClose}
          />
        )
      })

      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-project-id="project-2"]')?.click()
      )

      expect(onMobileClose).toHaveBeenCalledOnce()
      expect(useNavigationStore.getState().activeProjectId).toBe('project-2')
      expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    } finally {
      act(() => root.unmount())
    }
  })
})
