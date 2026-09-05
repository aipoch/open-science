// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '@/stores/notebook-env-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { AgentLoadingIndicator } from './WorkspaceAgentLoadingRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

// A running session whose turn started `startedAgoMs` ago, optionally with a latest agent status line.
const seedRunningSession = (startedAgoMs: number, agentStatus?: string): void => {
  const startedAt = Date.now() - startedAgoMs
  const session: ChatSession = {
    id: 's1',
    projectId: 'p1',
    title: 's1',
    cwd: '/workspace',
    status: 'running',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Prompt',
        status: 'complete',
        eventIds: [],
        createdAt: startedAt,
        updatedAt: startedAt
      }
    ],
    activeRun: { promptMessageId: 'm1', startedAt },
    agentStatus,
    createdAt: 0,
    updatedAt: 0
  }
  useSessionStore.setState({ sessions: [session], selectedSessionId: 's1' })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  useSessionStore.setState(createInitialSessionState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('WorkspaceAgentLoadingRow', () => {
  it('shows session environment preparation after the approval request is settled', () => {
    useNotebookEnvStore.setState({
      progress: {
        phase: 'create-r',
        event: { code: 'environment-create', environment: 'default-r' },
        progress: 0.45,
        scope: 'r',
        sessionId: 's1',
        language: 'r'
      }
    })

    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="waiting-for-approval" />))

    expect(container.textContent).toContain('Creating default-r environment…')
    expect(container.textContent).toContain('45%')
    expect(container.textContent).not.toContain('Waiting for your approval')
  })

  it('keeps a visible approval request ahead of environment preparation', () => {
    useNotebookEnvStore.setState({
      progress: {
        phase: 'create-r',
        event: { code: 'environment-create', environment: 'default-r' },
        progress: 0.45,
        scope: 'r',
        sessionId: 's1',
        language: 'r'
      }
    })

    act(() =>
      root.render(
        <AgentLoadingIndicator
          sessionId="s1"
          phase="waiting-for-approval"
          visiblePermissionPending
        />
      )
    )

    expect(container.textContent).toContain('Waiting for your approval')
    expect(container.textContent).not.toContain('Creating default-r environment…')
  })

  it('starts elapsed time from the Session timeline', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:05')
    expect(container.textContent).toContain('Thinking')
    const indicator = container.querySelector('[data-testid="open-science-thinking-indicator"]')
    expect(indicator).not.toBeNull()
    expect(
      container.querySelectorAll(
        '[data-testid="open-science-thinking-indicator"] .open-science-thinking-indicator__dot'
      )
    ).toHaveLength(5)
    expect(indicator?.getAttribute('aria-hidden')).toBe('true')
    expect(indicator?.classList.contains('text-text-300')).toBe(true)
    const status = container.querySelector('[role="status"]')
    const thinkingLabel = Array.from(status?.querySelectorAll('span') ?? []).find(
      (element) => element.textContent === 'Thinking'
    )
    expect(thinkingLabel?.getAttribute('aria-hidden')).toBeNull()
    const statusRow = container.querySelector('[role="status"] > div')
    expect(statusRow?.classList.contains('text-text-000/70')).toBe(true)
    expect(statusRow?.classList.contains('text-text-300')).toBe(false)
  })

  it('shows only the elapsed time even after a long silent wait', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:45')
  })

  it('updates the elapsed time live while the turn runs', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:05')

    // The row ticks once a second; advancing the clock should move the label forward.
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(container.textContent).toContain('0:08')
    expect(container.textContent).not.toContain('0:05')
  })

  it('keeps elapsed time after navigating away and returning', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(container.textContent).toContain('0:53')

    act(() => root.render(null))
    act(() => {
      vi.advanceTimersByTime(5000)
      root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />)
    })

    expect(container.textContent).toContain('0:58')
    expect(container.textContent).not.toContain('0:00')
  })

  it('keeps an independent elapsed time when switching Sessions', () => {
    seedRunningSession(5000)
    const firstSession = useSessionStore.getState().sessions[0]
    useSessionStore.setState({
      sessions: [
        firstSession,
        {
          ...firstSession,
          id: 's2',
          title: 's2',
          activeRun: { promptMessageId: 'm1', startedAt: Date.now() - 10_000 }
        }
      ]
    })
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:05')

    act(() => {
      vi.advanceTimersByTime(2000)
      root.render(<AgentLoadingIndicator sessionId="s2" phase="thinking" />)
    })
    expect(container.textContent).toContain('0:12')

    act(() => {
      vi.advanceTimersByTime(2000)
      root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />)
    })
    expect(container.textContent).toContain('0:09')
  })

  it('surfaces the latest agent status line when present', () => {
    seedRunningSession(3000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('retrying request…')
    const statusLine = container.querySelector<HTMLElement>('[title="retrying request…"]')
    expect(statusLine?.classList.contains('text-text-000/70')).toBe(true)
    expect(statusLine?.classList.contains('text-text-300/80')).toBe(false)
  })

  it('shows tool interaction without elapsed time', () => {
    seedRunningSession(45_000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="interacting-with-tools" />))

    expect(container.textContent).toContain('Interacting with tools')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.textContent).not.toContain('· Interacting with tools')
    expect(container.textContent).not.toContain('0:00')
    expect(container.textContent).not.toContain('retrying request…')
  })

  it.each([
    ['waiting-for-approval', 'Waiting for your approval'],
    ['waiting-for-response', 'Waiting for your response']
  ] as const)('shows the %s message without elapsed time', (phase, label) => {
    seedRunningSession(45_000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase={phase} />))

    expect(container.textContent).toContain(label)
    expect(container.textContent).not.toContain('Interacting with tools')
    expect(container.textContent).not.toContain('0:45')
    expect(container.textContent).not.toContain('retrying request…')
  })

  it('reuses the thinking indicator for Session resume progress', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="resuming" />))

    expect(container.textContent).toContain('Resuming session')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.textContent).not.toContain('Interacting with tools')
    expect(
      container.querySelector('[data-testid="open-science-thinking-indicator"]')
    ).not.toBeNull()
  })

  it('restarts thinking time when tool interaction returns to thinking', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(container.textContent).toContain('0:53')

    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="interacting-with-tools" />))
    expect(container.textContent).not.toContain('0:53')

    act(() => {
      vi.advanceTimersByTime(5000)
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 's1'
            ? {
                ...session,
                activities: [
                  {
                    id: 'tool-1',
                    kind: 'tool',
                    title: 'Read files',
                    status: 'completed',
                    eventIds: ['tool-event-1'],
                    sortIndex: 2,
                    promptMessageId: 'm1',
                    createdAt: Date.now() - 1000,
                    updatedAt: Date.now()
                  }
                ]
              }
            : session
        )
      }))
      root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />)
    })

    expect(container.textContent).toContain('0:00')

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(container.textContent).toContain('0:03')
  })
})
