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
  it('shows the elapsed time for the active turn', () => {
    seedRunningSession(5000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" />))

    expect(container.textContent).toContain('0:05')
    expect(container.textContent).not.toContain('taking longer than usual')
  })

  it('adds a "taking longer than usual" hint past the threshold', () => {
    seedRunningSession(45_000)
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" />))

    expect(container.textContent).toContain('0:45')
    expect(container.textContent).toContain('taking longer than usual')
  })

  it('surfaces the latest agent status line when present', () => {
    seedRunningSession(3000, 'retrying request…')
    act(() => root.render(<AgentLoadingIndicator sessionId="s1" />))

    expect(container.textContent).toContain('retrying request…')
  })
})
