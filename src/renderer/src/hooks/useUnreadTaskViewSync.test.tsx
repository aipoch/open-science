// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useUnreadTaskViewSync } from './useUnreadTaskViewSync'

const makeSession = (id: string, isPending = false, projectId = 'project-1'): ChatSession => ({
  id,
  projectId,
  title: id,
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  isPending
})

const Harness = ({
  isSessionContentVisible = true
}: {
  isSessionContentVisible?: boolean
}): null => {
  useUnreadTaskViewSync({ isSessionContentVisible })
  return null
}

describe('useUnreadTaskViewSync', () => {
  let container: HTMLDivElement
  let root: Root
  const syncViewState = vi.fn()
  let probeListener: ((challengeId: number) => void) | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    syncViewState.mockClear()
    probeListener = undefined
    useSessionStore.setState(createInitialSessionState())
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    window.api = {
      notifications: {
        syncViewState,
        onViewProbe: (listener: (challengeId: number) => void) => {
          probeListener = listener
          return () => {
            probeListener = undefined
          }
        }
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('publishes only visible-session state after full hydration', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-2'), makeSession('pending', true), makeSession('session-1')],
      selectedSessionId: 'session-2'
    })

    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    expect(syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-2' })
  })

  it('is a no-op in the Web renderer where the desktop-only bridge is absent', async () => {
    window.api = { notifications: {} } as unknown as Window['api']

    await expect(act(async () => root.render(<Harness />))).resolves.toBeUndefined()
    expect(syncViewState).not.toHaveBeenCalled()
  })

  it('syncs visible-session navigation and deduplicates unrelated store updates', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()

    await act(async () => {
      useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    })
    expect(syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-1' })

    syncViewState.mockClear()
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll')
    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({ ...session, updatedAt: 2 }))
      }))
    })
    expect(syncViewState).not.toHaveBeenCalled()
    expect(querySelectorAll).not.toHaveBeenCalled()
    querySelectorAll.mockRestore()

    await act(async () => {
      useSessionStore.getState().deleteSession('session-1')
    })
    expect(syncViewState).toHaveBeenCalledWith({})
  })

  it('does not report a selected session from a different project as visible', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1', false, 'project-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-2' })

    await act(async () => root.render(<Harness />))

    expect(syncViewState).toHaveBeenCalledWith({})
  })

  it('publishes hidden visibility while an app-level overlay covers the conversation', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness isSessionContentVisible={false} />))

    expect(syncViewState).toHaveBeenCalledWith({})

    syncViewState.mockClear()
    await act(async () => root.render(<Harness isSessionContentVisible />))

    expect(syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-1' })
  })

  it('stops reporting the selected session as visible while a blocking dialog is mounted', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    await act(async () => document.body.appendChild(dialog))

    expect(syncViewState).toHaveBeenCalledWith({})

    syncViewState.mockClear()
    await act(async () => dialog.remove())

    expect(syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-1' })
  })

  it('answers a main-process visibility challenge without waiting for a store mutation', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()

    await act(async () => probeListener?.(41))

    expect(syncViewState).toHaveBeenCalledWith({
      challengeId: 41,
      visibleSessionId: 'session-1'
    })
  })

  it('does not project a large session catalog over visibility IPC', async () => {
    useSessionStore.setState({
      sessions: Array.from({ length: 10_001 }, (_, index) => makeSession(`session-${index}`)),
      selectedSessionId: 'session-0'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    expect(syncViewState).toHaveBeenLastCalledWith({ visibleSessionId: 'session-0' })

    syncViewState.mockClear()
    await act(async () => probeListener?.(42))
    expect(syncViewState).toHaveBeenCalledWith({
      challengeId: 42,
      visibleSessionId: 'session-0'
    })
  })

  it('treats the Streamdown Mermaid fullscreen portal as blocking', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()

    const fullscreen = document.createElement('div')
    fullscreen.className = 'fixed inset-0 z-50 flex items-center justify-center'
    fullscreen.setAttribute('role', 'button')
    await act(async () => document.body.appendChild(fullscreen))

    expect(syncViewState).toHaveBeenCalledWith({})
    await act(async () => fullscreen.remove())
  })

  it('tracks a retained dialog changing between open and closed states', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'closed')
    document.body.appendChild(dialog)

    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()

    await act(async () => dialog.setAttribute('data-state', 'open'))
    expect(syncViewState).toHaveBeenCalledWith({})

    syncViewState.mockClear()
    await act(async () => dialog.setAttribute('data-state', 'closed'))
    expect(syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-1' })
    await act(async () => dialog.remove())
  })

  it('ignores ordinary conversation DOM mutations', async () => {
    useSessionStore.setState({
      sessions: [makeSession('session-1')],
      selectedSessionId: 'session-1'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })

    await act(async () => root.render(<Harness />))
    syncViewState.mockClear()
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll')

    const message = document.createElement('p')
    await act(async () => document.body.appendChild(message))

    expect(syncViewState).not.toHaveBeenCalled()
    expect(querySelectorAll).not.toHaveBeenCalled()
    querySelectorAll.mockRestore()
    await act(async () => message.remove())
  })
})
