// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { AgentLoadingIndicator } from './WorkspaceAgentLoadingRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

// A running session whose turn started `startedAgoMs` ago, optionally with a latest agent status line.
const seedRunningSession = (startedAgoMs: number, agentStatus?: string): void => {
  const session: ChatSession = {
    id: 's1',
    projectId: 'p1',
    title: 's1',
    cwd: '/workspace',
    status: 'running',
    messages: [],
    activeRun: { promptMessageId: 'm1', startedAt: Date.now() - startedAgoMs },
    agentStatus,
    createdAt: 0,
    updatedAt: 0
  }
  useSessionStore.setState({ sessions: [session], selectedSessionId: 's1' })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
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
  it('starts elapsed time when the indicator mounts', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:00')
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
    expect(container.textContent).not.toContain('taking longer than usual')
    const statusRow = container.querySelector('[role="status"] > div')
    expect(statusRow?.classList.contains('text-text-000/70')).toBe(true)
    expect(statusRow?.classList.contains('text-text-300')).toBe(false)
  })

  it('adds a "taking longer than usual" hint after the indicator stays visible', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:00')
    expect(container.textContent).not.toContain('taking longer than usual')

    act(() => {
      vi.advanceTimersByTime(21_000)
    })

    expect(container.textContent).toContain('0:21')
    expect(container.textContent).toContain('taking longer than usual')
  })

  it('updates the elapsed time live while the turn runs', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:00')

    // The row ticks once a second; advancing the clock should move the label forward.
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(container.textContent).toContain('0:03')
    expect(container.textContent).not.toContain('0:00')
  })

  it('crosses into the "taking longer than usual" hint as time passes the threshold', () => {
    // The active turn age does not count toward this mount's slow-hint threshold.
    seedRunningSession(18_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('0:00')
    expect(container.textContent).not.toContain('taking longer than usual')

    // Advance past 20s: the label keeps ticking and the slow hint appears.
    act(() => {
      vi.advanceTimersByTime(21_000)
    })

    expect(container.textContent).toContain('0:21')
    expect(container.textContent).toContain('taking longer than usual')
  })

  it('resets elapsed time after the indicator unmounts and mounts again', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(container.textContent).toContain('0:08')

    act(() => root.render(null))
    act(() => {
      vi.advanceTimersByTime(5000)
      root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />)
    })

    expect(container.textContent).toContain('0:00')
    expect(container.textContent).not.toContain('0:13')
  })

  it('surfaces the latest agent status line when present', () => {
    seedRunningSession(3000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />))

    expect(container.textContent).toContain('retrying request…')
    const statusLine = container.querySelector<HTMLElement>('[title="retrying request…"]')
    expect(statusLine?.classList.contains('text-text-000/70')).toBe(true)
    expect(statusLine?.classList.contains('text-text-300/80')).toBe(false)
  })

  it('shows tool interaction without elapsed time or a slow hint', () => {
    seedRunningSession(45_000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="interacting-with-tools" />))

    expect(container.textContent).toContain('Interacting with tools')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.textContent).not.toContain('· Interacting with tools')
    expect(container.textContent).not.toContain('0:00')
    expect(container.textContent).not.toContain('taking longer than usual')
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
    expect(container.textContent).toContain('0:08')

    act(() => root.render(<AgentLoadingIndicator sessionId="s1" phase="interacting-with-tools" />))
    expect(container.textContent).not.toContain('0:08')

    act(() => {
      vi.advanceTimersByTime(5000)
      root.render(<AgentLoadingIndicator sessionId="s1" phase="thinking" />)
    })

    expect(container.textContent).toContain('0:00')
    expect(container.textContent).not.toContain('0:13')
  })
})
