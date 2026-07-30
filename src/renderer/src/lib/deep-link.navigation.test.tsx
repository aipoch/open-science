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

type HookHarnessProps = {
  isHydrated: boolean
  isReady: boolean
}

const HookHarness = ({ isHydrated, isReady }: HookHarnessProps): null => {
  useDeepLinkNavigation({ isHydrated, isReady })

  return null
}

let root: Root | undefined

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    userNavigationRevision: 0,
    explicitNavigationRevision: 0
  })
  useProjectStore.setState(createInitialProjectState())
  useSessionStore.setState(createInitialSessionState())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const renderHook = async (
  readiness: HookHarnessProps
): Promise<{ rerender: (nextReadiness: HookHarnessProps) => Promise<void> }> => {
  const container = document.createElement('div')
  root = createRoot(container)

  await act(async () => root?.render(createElement(HookHarness, readiness)))

  return {
    rerender: async (nextReadiness) => {
      await act(async () => root?.render(createElement(HookHarness, nextReadiness)))
    }
  }
}

describe('deep-link navigation', () => {
  it('preserves notification navigation when no deep-link target was supplied', async () => {
    window.history.replaceState({}, '', '/')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })
    act(() => useNavigationStore.getState().openSession(project.id, session.id, 'automatic'))

    await renderHook({ isHydrated: true, isReady: true })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
  })

  it('preserves notification navigation over a deferred startup deep link', async () => {
    const notificationProject: Project = {
      ...project,
      id: 'project-2',
      name: 'Notification research'
    }
    const notificationSession: ChatSession = {
      ...session,
      id: 'session-2',
      projectId: notificationProject.id,
      title: 'Notification session'
    }
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({
      projects: [project, notificationProject],
      isLoaded: false
    })
    useSessionStore.setState({ sessions: [session, notificationSession] })

    await renderHook({ isHydrated: true, isReady: true })

    act(() =>
      useNavigationStore
        .getState()
        .openSession(notificationProject.id, notificationSession.id, 'notification')
    )
    act(() => useProjectStore.setState({ isLoaded: true }))

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: notificationProject.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(notificationSession.id)
  })

  it('opens an already-hydrated session during partial recovery', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useSessionStore.setState({ sessions: [session] })

    const hook = await renderHook({ isHydrated: false, isReady: false })

    act(() => useProjectStore.setState({ projects: [project], isLoaded: true }))
    expect(useNavigationStore.getState().view).toBe('home')

    await hook.rerender({ isHydrated: true, isReady: false })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
  })

  it('retains an unresolved target until a retry completes the Session scan', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })

    const hook = await renderHook({ isHydrated: true, isReady: false })

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('?project=project-1&session=session-1')

    act(() => useSessionStore.setState({ sessions: [session] }))
    await hook.rerender({ isHydrated: true, isReady: true })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(window.location.search).toBe('?project=project-1&session=session-1')
  })

  it('retains an unresolved target until a Project load with an empty error is retried', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({
      projects: [],
      isLoaded: true,
      loadError: ''
    })
    useSessionStore.setState({ sessions: [session] })

    await renderHook({ isHydrated: true, isReady: true })

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('?project=project-1&session=session-1')

    await act(async () =>
      useProjectStore.setState({ projects: [project], isLoaded: true, loadError: undefined })
    )

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
    expect(window.location.search).toBe('?project=project-1&session=session-1')
  })

  it('does not replay an unresolved target after the user navigates elsewhere', async () => {
    const otherProject: Project = { ...project, id: 'project-2', name: 'Other research' }
    const otherSession: ChatSession = {
      ...session,
      id: 'session-2',
      projectId: otherProject.id,
      title: 'Other session'
    }
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project, otherProject], isLoaded: true })
    useSessionStore.setState({ sessions: [otherSession] })

    const hook = await renderHook({ isHydrated: true, isReady: false })

    expect(window.location.search).toBe('?project=project-1&session=session-1')

    act(() => useNavigationStore.getState().openSession(otherProject.id, otherSession.id, 'user'))
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: otherProject.id
    })

    act(() => useSessionStore.setState({ sessions: [session, otherSession] }))
    await hook.rerender({ isHydrated: true, isReady: true })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: otherProject.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(otherSession.id)
    expect(window.location.search).toBe('?project=project-2&session=session-2')
  })

  it('returns Home when the session parameter is missing', async () => {
    window.history.replaceState({}, '', '/?project=project-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })

    await renderHook({ isHydrated: true, isReady: false })

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('')
  })

  it('returns Home when the session does not belong to the linked project', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [{ ...session, projectId: 'project-2' }] })

    await renderHook({ isHydrated: true, isReady: true })

    expect(useNavigationStore.getState().view).toBe('home')
    expect(window.location.search).toBe('')
  })

  it('does not rewrite the URL when session content changes without navigation', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await renderHook({ isHydrated: true, isReady: true })
    replaceState.mockClear()

    act(() => useSessionStore.setState({ sessions: [{ ...session, title: 'Updated' }] }))

    expect(replaceState).not.toHaveBeenCalled()
  })

  it('updates the URL when navigation selects another session', async () => {
    const nextSession = { ...session, id: 'session-2' }
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session, nextSession] })

    await renderHook({ isHydrated: true, isReady: true })
    act(() => useNavigationStore.getState().openSession(project.id, nextSession.id, 'user'))

    expect(window.location.search).toBe('?project=project-1&session=session-2')
  })

  it('stops synchronizing the URL after the hook unmounts', async () => {
    window.history.replaceState({}, '', '/?project=project-1&session=session-1')
    useProjectStore.setState({ projects: [project], isLoaded: true })
    useSessionStore.setState({ sessions: [session] })
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await renderHook({ isHydrated: true, isReady: true })
    replaceState.mockClear()
    await act(async () => root?.unmount())
    root = undefined

    act(() => useSessionStore.getState().selectSession('session-2'))

    expect(replaceState).not.toHaveBeenCalled()
  })
})
