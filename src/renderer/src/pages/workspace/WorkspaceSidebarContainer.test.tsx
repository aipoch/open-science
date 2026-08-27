// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'

const persistenceMocks = vi.hoisted(() => ({
  hydratePersistedSessionIfPresent: vi.fn(),
  loadPersistedSession: vi.fn()
}))

vi.mock('@/lib/session-persistence/session-persistence', () => persistenceMocks)

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: ({
    onPreviewSession
  }: {
    onPreviewSession?: (sessionId: string) => Promise<void> | void
  }) => (
    <button type="button" onClick={() => void onPreviewSession?.('lazy-session')}>
      Preview Session
    </button>
  )
}))

import { WorkspaceSidebarContainer } from './WorkspaceSidebarContainer'

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

beforeEach(() => {
  persistenceMocks.hydratePersistedSessionIfPresent.mockReset()
  persistenceMocks.loadPersistedSession.mockReset()
  useSessionStore.setState({ sessions: [lazySession] })
})

describe('WorkspaceSidebarContainer Session previews', () => {
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
