// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { RemoteJobBadge } from './RemoteJobBadge'
import { formatDuration } from './remote-job-badge-utils'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'

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

describe('RemoteJobBadge — 0 running', () => {
  it('renders nothing when there are no running jobs', () => {
    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })
    expect(container.firstChild).toBeNull()
  })

  it('hides when the only job is in a terminal state', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ status: 'success' }))

    act(() => {
      root.render(<RemoteJobBadge sessionId="sess-test" />)
    })
    expect(container.firstChild).toBeNull()
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
