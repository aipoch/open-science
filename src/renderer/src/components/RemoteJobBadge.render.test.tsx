// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { RemoteJobBadge } from './RemoteJobBadge'
import { formatDuration, jobRowDuration } from './remote-job-badge-utils'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'

// Radix's tooltip open/close relies on pointer + rAF timing that jsdom does not drive, so its
// portaled content never mounts under synthetic events. Render the primitives inline (content
// always visible) so tests can assert RemoteJobBadge's own tooltip JSX rather than Radix internals.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children
}))

let container: HTMLDivElement
let root: Root

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-test',
  status: 'running',
  intent: 'Salary analysis — EDA',
  created_at: Date.now() - 60_000,
  started_at: Date.now() - 60_000,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionJobStore.setState(createInitialSessionJobState())
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('formatDuration', () => {
  it('renders seconds only when under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(0)).toBe('0s')
  })

  it('renders minutes and seconds for ≥ 60s', () => {
    expect(formatDuration(213_000)).toBe('3m 33s')
    expect(formatDuration(60_000)).toBe('1m 0s')
  })
})

describe('jobRowDuration', () => {
  it('labels a queued job "queued" instead of an elapsed time (it has not started)', () => {
    const now = Date.now()
    const queued = makeJob({ status: 'queued', started_at: undefined, created_at: now - 5_000 })
    expect(jobRowDuration(queued, now)).toBe('queued')
  })

  it('renders the elapsed duration for a running job', () => {
    const now = Date.now()
    const running = makeJob({ status: 'running', started_at: now - 90_000 })
    expect(jobRowDuration(running, now)).toBe('1m 30s')
  })
})

describe('RemoteJobBadge — 0 running', () => {
  it('renders nothing when there are no running jobs', () => {
    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })
    expect(container.firstChild).toBeNull()
  })

  it('renders gray badge with "N jobs" when all jobs are finished', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j1', status: 'success' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j2', status: 'failed' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    expect(container.textContent).toContain('2 jobs')
    expect(container.textContent).not.toContain('running')

    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()
    // Gray style check: should not have the amber --session-waiting color
    const style = btn?.getAttribute('style')
    expect(style).not.toContain('--session-waiting')
  })
})

describe('RemoteJobBadge — N running', () => {
  it('renders the badge with running count and elapsed time', () => {
    // Seed two running jobs
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'job-1', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'job-2', status: 'running' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    expect(container.textContent).toContain('2 running')
  })

  it('counts submitted jobs as running', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j1', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j2', status: 'submitted' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j3', status: 'success' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    // Should count both running and submitted as "running"
    expect(container.textContent).toContain('2 running')
  })

  it('ignores jobs for other sessions', () => {
    useSessionJobStore
      .getState()
      .applyUpdate(makeJob({ session_id: 'sess-other', status: 'running' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    expect(container.firstChild).toBeNull()
  })

  it('has an accessible aria-label describing the count', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ status: 'running' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    const btn = container.querySelector('button')
    expect(btn?.getAttribute('aria-label')).toContain('running remote job')
  })
})

describe('RemoteJobBadge — queued jobs (concurrency limit)', () => {
  it('counts queued jobs alongside running in an active amber badge', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'r1', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'queued' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q2', status: 'queued' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    expect(container.textContent).toContain('1 running')
    expect(container.textContent).toContain('2 queued')

    // Badge stays amber/active (carries the --session-waiting style), not gray idle.
    const btn = container.querySelector('button')
    expect(btn?.getAttribute('style')).toContain('--session-waiting')
  })

  it('stays amber and shows "N queued" when every in-flight job is queued (no running)', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'queued' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q2', status: 'queued' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    // Active (amber), not the gray idle badge.
    expect(container.textContent).toContain('2 queued')
    expect(container.textContent).not.toContain('running')
    const btn = container.querySelector('button')
    expect(btn?.getAttribute('style')).toContain('--session-waiting')

    // The accessible label must not claim jobs are "running" when none are.
    expect(btn?.getAttribute('aria-label')).not.toContain('running')
    expect(btn?.getAttribute('aria-label')).toContain('queued')
  })

  it('drops the queued segment once a queued job is dispatched to running', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'r1', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'queued' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })
    expect(container.textContent).toContain('1 running')
    expect(container.textContent).toContain('1 queued')

    // A slot frees up: the queued job is promoted to running.
    act(() => {
      useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'running' }))
    })

    expect(container.textContent).toContain('2 running')
    expect(container.textContent).not.toContain('queued')
  })

  it('falls back to the gray "N jobs" badge once every job is terminal', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'r1', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'queued' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    // Both jobs finish.
    act(() => {
      useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'r1', status: 'success' }))
      useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'q1', status: 'failed' }))
    })

    expect(container.textContent).toContain('2 jobs')
    expect(container.textContent).not.toContain('running')
    expect(container.textContent).not.toContain('queued')
    const btn = container.querySelector('button')
    expect(btn?.getAttribute('style')).not.toContain('--session-waiting')
  })

  it('lists queued jobs in the tooltip with a "queued" label instead of an elapsed time', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'r1', status: 'running' }))
    useSessionJobStore
      .getState()
      .applyUpdate(makeJob({ job_id: 'q1', status: 'queued', intent: 'Train model' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })

    // Tooltip content renders inline (primitives mocked above). The queued job appears as a row
    // with its intent and a literal "queued" label rather than an elapsed duration.
    expect(container.textContent).toContain('Train model')
    expect(container.textContent).toContain('queued')
  })
})

describe('RemoteJobBadge — click interaction', () => {
  it('triggers onOpenJobList when clicked', () => {
    const handleOpen = vi.fn()
    useSessionJobStore.getState().applyUpdate(makeJob({ status: 'running' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" onOpenJobList={handleOpen} />)
    })

    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()

    act(() => {
      btn?.click()
    })

    expect(handleOpen).toHaveBeenCalledTimes(1)
  })
})
