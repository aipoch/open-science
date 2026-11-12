// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import {
  openResearchFilmNotification,
  useResearchFilmNoticeStore
} from '@/stores/research-film-notice-store'
import { ResearchFilmNotificationHost } from './ResearchFilmNotificationHost'

vi.mock('./research-video-button', () => ({
  ResearchVideoButton: ({ branchId }: { branchId?: string }) => <div data-film-branch={branchId} />
}))
let root: Root
let container: HTMLDivElement
const target = { projectId: 'p', sessionId: 's', branchId: 'other' }
const fixture = (): ChatSession => {
  const graph = createLinearConversationGraph({
    sessionId: 's',
    createdAt: 1,
    updatedAt: 1,
    messages: []
  })
  graph.branches.push({ id: 'other', agentFrameId: graph.rootFrameId, createdAt: 1, updatedAt: 1 })
  return {
    id: 's',
    projectId: 'p',
    title: 'Film',
    cwd: '/work',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    conversationGraph: graph
  } as ChatSession
}
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  useSessionStore.setState({ sessions: [fixture()], selectedSessionId: 's' })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'p',
    userNavigationRevision: 0
  })
  useResearchFilmNoticeStore.setState({
    visible: {},
    target: { ...target, token: 1, navigationRevision: 0 }
  })
  useNotificationInboxStore.setState({ items: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useResearchFilmNoticeStore.setState({ visible: {}, target: undefined })
  vi.restoreAllMocks()
})

it('waits for lazy session content, selects the source branch, and opens its film', async () => {
  const loaded = fixture()
  useSessionStore.setState({
    sessions: [{ ...loaded, conversationGraph: undefined, contentLoaded: false }]
  })
  await act(async () => root.render(<ResearchFilmNotificationHost />))
  expect(container.querySelector('[data-film-branch]')).toBeNull()
  await act(async () => useSessionStore.setState({ sessions: [loaded] }))
  expect(container.querySelector('[data-film-branch]')?.getAttribute('data-film-branch')).toBe(
    'other'
  )
  expect(useSessionStore.getState().sessions[0].conversationGraph?.frames[0].activeBranchId).toBe(
    'other'
  )
  await act(async () => useNavigationStore.setState({ userNavigationRevision: 1 }))
  expect(container.querySelector('[data-film-branch]')).toBeNull()
})

it.each(['missing', 'busy'] as const)(
  'does not open the wrong film when the source branch is %s',
  async (reason) => {
    const session = fixture()
    if (reason === 'missing') session.conversationGraph!.branches.pop()
    else session.branchSwitchBlocked = true
    useSessionStore.setState({ sessions: [session] })
    await act(async () => root.render(<ResearchFilmNotificationHost />))
    expect(container.querySelector('[data-film-branch]')).toBeNull()
    expect(document.body.textContent).toContain('Could not open the research film branch.')
  }
)

it('waits for the existing navigation leave guard before requesting the film window', () => {
  useResearchFilmNoticeStore.setState({ target: undefined })
  let accepted: (() => void) | undefined
  const original = useNavigationStore.getState().openSessionById
  useNavigationStore.setState({
    openSessionById: (_id, _origin, callback) => {
      accepted = callback
      return false
    }
  })
  try {
    openResearchFilmNotification(target)
    expect(useResearchFilmNoticeStore.getState().target).toBeUndefined()
    accepted?.()
    expect(useResearchFilmNoticeStore.getState().target).toMatchObject(target)
  } finally {
    useNavigationStore.setState({ openSessionById: original })
  }
})
