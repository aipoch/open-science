// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionHistoryLoadButton } from './SessionHistoryLoadButton'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string): string => key }) }))
afterEach(() => {
  vi.unstubAllGlobals()
  useSessionStore.setState(createInitialSessionState())
})

it('loads earlier records on click and preserves a full-load entry after the last page', async () => {
  const session = {
    id: 'session',
    projectId: 'project',
    title: 'History',
    cwd: '/workspace',
    status: 'idle' as const,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1
  }
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [
      {
        ...session,
        contentLoaded: false,
        historyPage: { revision: 1, totalItems: 160, hasMore: true, beforeCursor: 'older' }
      }
    ]
  })
  const loadHistoryPage = vi.fn().mockResolvedValue({
    projectId: 'project',
    sessionId: 'session',
    revision: 1,
    session,
    totalItems: 160,
    hasMore: false
  })
  const loadOne = vi.fn().mockResolvedValue(session)
  window.api = { sessions: { loadHistoryPage, loadOne } } as unknown as Window['api']
  const container = document.createElement('div')
  const root = createRoot(container)
  const Harness = (): React.JSX.Element => {
    const current = useSessionStore((state) => state.sessions[0])
    return <SessionHistoryLoadButton session={current} />
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(loadHistoryPage).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'session',
      beforeCursor: 'older'
    })
    expect(loadOne).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Load earlier messages')
    expect(container.textContent).toContain('Load full conversation')
    expect(useSessionStore.getState().sessions[0].contentLoaded).toBe(false)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'session' })
    expect(container.textContent).toBe('')
    expect(useSessionStore.getState().sessions[0].contentLoaded).toBeUndefined()
  } finally {
    act(() => root.unmount())
  }
})
