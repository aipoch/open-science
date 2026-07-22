// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../shared/projects'
import { useNavigationStore } from '../stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '../stores/project-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '../stores/session-store'
import { useDeepLinkNavigation } from './deep-link'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: Project = {
  id: 'project-1',
  name: 'Research',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: ChatSession = {
  id: 'session-1',
  projectId: project.id,
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const HookHarness = ({ isReady }: { isReady: boolean }): null => {
  useDeepLinkNavigation(isReady)

  return null
}

let root: Root | undefined

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
  useProjectStore.setState(createInitialProjectState())
  useSessionStore.setState(createInitialSessionState())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const renderHook = async (
  isReady: boolean
): Promise<{ rerender: (nextIsReady: boolean) => Promise<void> }> => {
  const container = document.createElement('div')
  root = createRoot(container)

  await act(async () => root?.render(createElement(HookHarness, { isReady })))

  return {
    rerender: async (nextIsReady) => {
      await act(async () => root?.render(createElement(HookHarness, { isReady: nextIsReady })))
    }
  }
}

describe('deep-link navigation', () => {
  it('opens a valid session only after projects and sessions are ready', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useSessionStore.setState({ sessions: [session] })

    const hook = await renderHook(false)

    act(() => useProjectStore.setState({ projects: [project], isLoaded: true }))
    expect(useNavigationStore.getState().view).toBe('home')

    await hook.rerender(true)

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
  })

  it('returns Home when the session parameter is missing', async () => {
    window.history.replaceState({}, '', '/?project=project-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })

    await renderHook(true)

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('')
  })

  it('returns Home when the session does not belong to the linked project', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [{ ...session, projectId: 'project-2' }] })

    await renderHook(true)

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('')
  })

  it('does not rewrite the URL when session content changes without navigation', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await renderHook(true)
    replaceState.mockClear()

    act(() => useSessionStore.setState({ sessions: [{ ...session, title: 'Updated' }] }))

    expect(replaceState).not.toHaveBeenCalled()
  })

  it('updates the URL when navigation selects another session', async () => {
    const nextSession = { ...session, id: 'session-2' }
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session, nextSession] })

    await renderHook(true)
    act(() => useNavigationStore.getState().openSession(project.id, nextSession.id))

    expect(window.location.search).toBe('?project=project-1&session=session-2')
  })

  it('stops synchronizing the URL after the hook unmounts', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await renderHook(true)
    replaceState.mockClear()
    await act(async () => root?.unmount())
    root = undefined

    act(() => useSessionStore.getState().selectSession('session-2'))

    expect(replaceState).not.toHaveBeenCalled()
  })
})
