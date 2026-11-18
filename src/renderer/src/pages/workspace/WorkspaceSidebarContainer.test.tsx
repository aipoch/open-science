// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import type { SessionHistoryPage } from '../../../../shared/session-history'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: ({
    onPreviewSession,
    otherProjects = [],
    onOpenProject,
    credentialPendingSessionIds
  }: {
    onPreviewSession?: (sessionId: string) => Promise<void> | void
    otherProjects?: Array<Pick<Project, 'id' | 'name' | 'description'>>
    onOpenProject?: (projectId: string) => void
    credentialPendingSessionIds?: ReadonlySet<string>
  }) => (
    <div>
      <span data-testid="credential-waiting-sessions">
        {[...(credentialPendingSessionIds ?? [])].join(',')}
      </span>
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
  useSessionStore.setState({ sessions: [lazySession] })
  useProjectStore.setState(createInitialProjectState())
  useSettingsStore.setState({ pendingCredentialRequests: [] })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-1',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0
  })
  window.localStorage.clear()
})

describe('WorkspaceSidebarContainer Session previews', () => {
  it('excludes closed credential requests while keeping another Session waiting', async () => {
    useSettingsStore.setState({
      pendingCredentialRequests: [
        {
          id: 'closed-credential',
          credentialId: 'openalex',
          connector: 'literature',
          method: 'openalex_search_works',
          sessionId: lazySession.id,
          closed: true
        },
        {
          id: 'open-credential',
          credentialId: 'openalex',
          connector: 'literature',
          method: 'openalex_search_works',
          sessionId: 'another-session'
        }
      ]
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebarContainer
            {...({ projectId: 'project-1', isProjectArchived: false } as ComponentProps<
              typeof WorkspaceSidebarContainer
            >)}
          />
        )
      })
      expect(
        container.querySelector('[data-testid="credential-waiting-sessions"]')?.textContent
      ).toBe('another-session')
    } finally {
      act(() => root.unmount())
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

  it('loads a lazy Session history page on demand and deduplicates concurrent requests', async () => {
    let resolveLoad: ((value: SessionHistoryPage) => void) | undefined
    const loadHistoryPage = vi.fn(
      () =>
        new Promise<SessionHistoryPage>((resolve) => {
          resolveLoad = resolve
        })
    )
    const loadOne = vi.fn()
    window.api = { sessions: { loadHistoryPage, loadOne } } as unknown as Window['api']
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

      expect(loadHistoryPage).toHaveBeenCalledOnce()
      expect(loadHistoryPage).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'lazy-session'
      })
      expect(loadOne).not.toHaveBeenCalled()

      await act(async () =>
        resolveLoad?.({
          projectId: 'project-1',
          sessionId: 'lazy-session',
          revision: 1,
          session: {
            ...lazySession,
            messages: [
              {
                id: 'history-message',
                role: 'user',
                content: 'Loaded history',
                status: 'complete',
                eventIds: [],
                createdAt: 1,
                updatedAt: 1
              }
            ]
          } as PersistedChatSession,
          totalItems: 1,
          hasMore: false
        })
      )

      const loaded = useSessionStore
        .getState()
        .sessions.find((session) => session.id === 'lazy-session')
      expect(loaded?.messages.map((message) => message.id)).toEqual(['history-message'])
      expect(loaded?.historyPage).toMatchObject({ revision: 1, totalItems: 1, hasMore: false })
      expect(loaded?.contentLoaded).toBe(false)
      expect(loadHistoryPage).toHaveBeenCalledOnce()
    } finally {
      act(() => root.unmount())
    }
  })

  it('falls back to loadOne when the preload surface has no history pagination', async () => {
    const loadOne = vi.fn().mockResolvedValue({
      ...lazySession,
      messages: [],
      revision: 1
    } satisfies PersistedChatSession)
    window.api = { sessions: { loadOne } } as unknown as Window['api']
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

      expect(loadOne).toHaveBeenCalledOnce()
      expect(loadOne).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'lazy-session'
      })
    } finally {
      act(() => root.unmount())
    }
  })

  it('does not load details for an already hydrated Session', async () => {
    useSessionStore.setState({ sessions: [{ ...lazySession, contentLoaded: undefined }] })
    const loadHistoryPage = vi.fn()
    const loadOne = vi.fn()
    window.api = { sessions: { loadHistoryPage, loadOne } } as unknown as Window['api']
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

      expect(loadHistoryPage).not.toHaveBeenCalled()
      expect(loadOne).not.toHaveBeenCalled()
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
