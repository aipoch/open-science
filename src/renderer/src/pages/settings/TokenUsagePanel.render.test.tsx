// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PersistedChatMessage,
  PersistedChatSession,
  SessionUsageProjection
} from '../../../../shared/session-persistence'
import type { Project } from '../../../../shared/projects'
import { TokenUsagePanel } from './TokenUsagePanel'

const localTime = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime()

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  createdAt: number,
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides
})

const createSession = (now: number): PersistedChatSession => {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayAt = yesterday.getTime()

  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Usage session',
    cwd: '/workspace',
    status: 'idle',
    artifacts: [{ id: 'artifact-1', kind: 'managed-file', path: 'report.md' }],
    createdAt: yesterdayAt,
    updatedAt: now,
    messages: [
      message('user-yesterday', 'user', yesterdayAt),
      message('agent-yesterday', 'agent', yesterdayAt, {
        completedAt: yesterdayAt,
        artifactIds: ['artifact-1'],
        turnUsage: { inputTokens: 100, cacheTokens: 20, outputTokens: 30 }
      }),
      message('user-today', 'user', now),
      message('agent-today', 'agent', now, { turnUsageUnavailable: true })
    ]
  }
}

const createProject = (now: number): Project => ({
  id: 'project-1',
  name: 'Usage project',
  description: '',
  isExample: false,
  createdAt: now,
  updatedAt: now
})

let container: HTMLDivElement
let root: Root
const originalApi = window.api

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  window.api = originalApi
  container.remove()
  document.body.innerHTML = ''
})

describe('TokenUsagePanel', () => {
  it('waits for the SQLite projection before displaying initial usage totals', async () => {
    const now = localTime(2026, 8, 15, 18)
    let resolveUsage: ((projection: SessionUsageProjection) => void) | undefined
    const loadUsage = vi.fn(
      () =>
        new Promise<SessionUsageProjection>((resolve) => {
          resolveUsage = resolve
        })
    )
    window.api = { sessions: { loadUsage } } as unknown as Window['api']

    act(() => {
      root.render(
        <TokenUsagePanel
          sessions={[createSession(now)]}
          projects={[createProject(now)]}
          now={now}
        />
      )
    })

    expect(document.body.querySelector('[data-slot="token-usage-loading"]')?.textContent).toBe(
      'Loading…'
    )
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')).toBeNull()

    await act(async () => {
      resolveUsage?.({
        sessionCreatedAt: [now],
        projectCreatedAt: [now],
        artifactCreatedAt: [],
        runsAt: [now],
        usageEvents: [
          {
            timestamp: now,
            inputTokens: 900,
            cacheTokens: 90,
            outputTokens: 9,
            rootRunUsage: true
          }
        ],
        totalArtifacts: 0
      })
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-slot="token-usage-loading"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total tokens999'
    )
  })

  it('shows a retryable error instead of partial hydrated usage when the projection fails', async () => {
    const now = localTime(2026, 8, 15, 18)
    const projection: SessionUsageProjection = {
      sessionCreatedAt: [now],
      projectCreatedAt: [now],
      artifactCreatedAt: [],
      runsAt: [],
      usageEvents: [],
      totalArtifacts: 0
    }
    const loadUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce(projection)
    window.api = { sessions: { loadUsage } } as unknown as Window['api']

    await act(async () => {
      root.render(
        <TokenUsagePanel
          sessions={[createSession(now)]}
          projects={[createProject(now)]}
          now={now}
        />
      )
    })

    expect(document.body.querySelector('[data-slot="token-usage-summary"]')).toBeNull()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load token usage.'
    )

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button')?.click()
    })

    expect(loadUsage).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total sessions1'
    )
  })

  it('keeps the loaded projection stable while Session revisions change', async () => {
    const now = localTime(2026, 8, 15, 18)
    const projection = (inputTokens: number): SessionUsageProjection => ({
      sessionCreatedAt: [now],
      projectCreatedAt: [now],
      artifactCreatedAt: [],
      runsAt: [now],
      usageEvents: [
        {
          timestamp: now,
          inputTokens,
          cacheTokens: 0,
          outputTokens: 0,
          rootRunUsage: true
        }
      ],
      totalArtifacts: 0
    })
    const loadUsage = vi.fn().mockResolvedValue(projection(10))
    window.api = { sessions: { loadUsage } } as unknown as Window['api']
    const persisted = { ...createSession(now), revision: 1 }

    await act(async () => {
      root.render(
        <TokenUsagePanel sessions={[persisted]} projects={[createProject(now)]} now={now} />
      )
    })
    expect(loadUsage).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(
        <TokenUsagePanel
          sessions={[{ ...persisted, revision: 2 }]}
          projects={[createProject(now)]}
          now={now}
        />
      )
    })

    expect(loadUsage).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total tokens10'
    )
  })

  it('keeps the loaded projection stable while the Project catalog changes', async () => {
    const now = localTime(2026, 8, 15, 18)
    const projection = (projectCreatedAt: number[]): SessionUsageProjection => ({
      sessionCreatedAt: [],
      projectCreatedAt,
      artifactCreatedAt: [],
      runsAt: [],
      usageEvents: [],
      totalArtifacts: 0
    })
    const loadUsage = vi.fn().mockResolvedValue(projection([now]))
    window.api = { sessions: { loadUsage } } as unknown as Window['api']

    await act(async () => {
      root.render(<TokenUsagePanel sessions={[]} projects={[createProject(now)]} now={now} />)
    })
    expect(loadUsage).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(
        <TokenUsagePanel
          sessions={[]}
          projects={[
            createProject(now),
            { ...createProject(now), id: 'project-2', name: 'Second project' }
          ]}
          now={now}
        />
      )
    })

    expect(loadUsage).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total projects1'
    )
  })

  it('refreshes on demand without replacing the loaded projection with a loading state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 15, 18))
    const now = Date.now()
    const projection = (inputTokens: number): SessionUsageProjection => ({
      sessionCreatedAt: [now],
      projectCreatedAt: [now],
      artifactCreatedAt: [],
      runsAt: [now],
      usageEvents: [
        {
          timestamp: now,
          inputTokens,
          cacheTokens: 0,
          outputTokens: 0,
          rootRunUsage: true
        }
      ],
      totalArtifacts: 0
    })
    let resolveRefresh: ((value: SessionUsageProjection) => void) | undefined
    const loadUsage = vi
      .fn()
      .mockResolvedValueOnce(projection(10))
      .mockImplementationOnce(
        () =>
          new Promise<SessionUsageProjection>((resolve) => {
            resolveRefresh = resolve
          })
      )
    window.api = { sessions: { loadUsage } } as unknown as Window['api']

    await act(async () => {
      root.render(
        <TokenUsagePanel sessions={[createSession(now)]} projects={[createProject(now)]} />
      )
    })

    expect(document.body.textContent).toContain('Updated now')

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click()
    })

    expect(loadUsage).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-slot="token-usage-loading"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total tokens10'
    )
    expect(document.body.textContent).toContain('Refreshing…')

    await act(async () => {
      resolveRefresh?.(projection(20))
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Refreshing…')
    expect(document.body.textContent).toContain('Updated now')
    expect(document.body.querySelector('[data-slot="token-usage-summary"]')?.textContent).toContain(
      'Total tokens20'
    )

    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000)
    })

    expect(document.body.textContent).toContain('Updated 2 minutes ago')
  })

  it('renders the stat strip, 30-day charts, coverage, and period controls', () => {
    const now = localTime(2026, 8, 15, 18)

    act(() => {
      root.render(
        <TokenUsagePanel
          sessions={[createSession(now)]}
          projects={[createProject(now)]}
          now={now}
        />
      )
    })

    const summary = document.body.querySelector('[data-slot="token-usage-summary"]')
    expect(summary?.textContent).toContain('Total tokens')
    expect(summary?.textContent).toContain('150')
    expect(summary?.textContent).toContain('Total sessions')
    expect(summary?.textContent).toContain('New projects')
    expect(summary?.textContent).toContain('Total artifacts')
    expect(summary?.textContent).toContain('New runs')
    expect(summary?.textContent).toContain('Cache share')
    expect(
      Array.from(summary?.lastElementChild?.children ?? [], (column) =>
        Array.from(column.querySelectorAll('[data-stat-label]'), (label) => label.textContent)
      )
    ).toEqual([
      ['New sessions', 'Total sessions'],
      ['New projects', 'Total projects'],
      ['New runs', 'Total runs'],
      ['New artifacts', 'Total artifacts']
    ])
    expect(
      document.body.querySelector('[data-slot="token-usage-coverage"]')?.textContent
    ).toContain('1 of 2 runs')
    expect(
      document.body.querySelectorAll('[aria-label="Daily activity for the last 30 days"] button')
    ).toHaveLength(30)
    expect(document.body.querySelectorAll('[data-slot="token-usage-bars"] button')).toHaveLength(30)
    expect(
      document.body.querySelector('[data-slot="token-usage-30-day-total"]')?.textContent
    ).toContain('Total tokens150')
    expect(
      Array.from(
        document.body.querySelectorAll('[data-slot="token-usage-axis"] span'),
        (label) => label.textContent
      )
    ).toEqual(['200', '100', '0'])
    expect(document.body.querySelector('[data-slot="token-usage-bars"]')?.className).not.toContain(
      'overflow-x-auto'
    )
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.textContent
    ).toContain('Last 30 days')
  })

  it('updates the selected period and exposes the compact heatmap metric selector', () => {
    const now = localTime(2026, 8, 15, 18)
    act(() => {
      root.render(
        <TokenUsagePanel
          sessions={[createSession(now)]}
          projects={[createProject(now)]}
          now={now}
        />
      )
    })

    const today = document.body.querySelector<HTMLButtonElement>('[aria-label="Today"]')
    act(() => today?.click())

    const summary = document.body.querySelector('[data-slot="token-usage-summary"]')
    expect(summary?.textContent).toContain('Total tokens0')
    expect(summary?.textContent).toContain('New runs1')

    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Daily activity metric"]')
        ?.textContent
    ).toContain('Total tokens')
  })

  it('uses rounded compact axis labels for large daily totals', () => {
    const now = localTime(2026, 8, 15, 18)
    const usageSession = createSession(now)
    const agentMessage = usageSession.messages.find(
      (candidate) => candidate.id === 'agent-yesterday'
    )
    if (agentMessage) {
      agentMessage.turnUsage = {
        inputTokens: 5_900_000_000,
        cacheTokens: 100_000_000,
        outputTokens: 100_000_000
      }
    }

    act(() => {
      root.render(
        <TokenUsagePanel sessions={[usageSession]} projects={[createProject(now)]} now={now} />
      )
    })

    expect(
      Array.from(
        document.body.querySelectorAll('[data-slot="token-usage-axis"] span'),
        (label) => label.textContent
      )
    ).toEqual(['7B', '3.5B', '0'])
  })

  it('refreshes the 30-day window at the next local day when now is not injected', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 15, 23, 59, 59, 500))

    act(() => {
      root.render(<TokenUsagePanel sessions={[]} projects={[]} />)
    })

    const latestDayLabel = (): string | null =>
      document.body
        .querySelectorAll<HTMLButtonElement>(
          '[aria-label="Daily activity for the last 30 days"] button'
        )
        .item(29)
        .getAttribute('aria-label')

    expect(latestDayLabel()).toContain('Aug 15, 2026')

    act(() => vi.advanceTimersByTime(1_500))

    expect(latestDayLabel()).toContain('Aug 16, 2026')
  })
})
