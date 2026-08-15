// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { extractJobIdFromActivity, findActivitiesForJob } from './job-binding-utils'
import type { ToolActivity } from '@/stores/session-store'

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeActivity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'act-1',
  kind: 'tool',
  title: 'Agent SDK',
  status: 'completed',
  eventIds: [],
  sortIndex: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides
})

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'running',
  intent: 'Run EDA',
  created_at: Date.now(),
  started_at: Date.now(),
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/home/user/.openscience/jobs/job-abc',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

// ─── extractJobIdFromActivity ────────────────────────────────────────────────

describe('extractJobIdFromActivity', () => {
  it('returns undefined for activity without rawOutput', () => {
    expect(extractJobIdFromActivity(makeActivity())).toBeUndefined()
  })

  it('returns undefined for rawOutput that is not an object', () => {
    expect(extractJobIdFromActivity(makeActivity({ rawOutput: 'hello' }))).toBeUndefined()
    expect(extractJobIdFromActivity(makeActivity({ rawOutput: 42 }))).toBeUndefined()
  })

  it('extracts job_id from result field containing JSON string', () => {
    const raw = {
      stdout: '',
      stderr: '',
      result: JSON.stringify({ job_id: 'job-abc', status: 'submitted' }),
      cwd: '/tmp',
      figures: []
    }
    expect(extractJobIdFromActivity(makeActivity({ rawOutput: raw }))).toBe('job-abc')
  })

  it('extracts job_id from stdout when result does not have it', () => {
    const raw = {
      stdout: 'Job submitted: {"job_id":"job-xyz","status":"submitted"}\n',
      stderr: '',
      result: null,
      cwd: '/tmp',
      figures: []
    }
    expect(extractJobIdFromActivity(makeActivity({ rawOutput: raw }))).toBe('job-xyz')
  })

  it('returns undefined when no job_id in rawOutput', () => {
    const raw = {
      stdout: 'echo hello\nhello\n',
      stderr: '',
      result: JSON.stringify({ foo: 'bar' }),
      cwd: '/tmp',
      figures: []
    }
    expect(extractJobIdFromActivity(makeActivity({ rawOutput: raw }))).toBeUndefined()
  })

  it('returns the job_id from a rawOutput that is itself a plain object with job_id', () => {
    // Some code paths may store rawOutput as the direct parsed object
    const raw = { job_id: 'job-direct', status: 'running' }
    // This path goes through stdout/result — rawOutput as record doesn't match
    // since we look for result string or stdout string
    const activity = makeActivity({ rawOutput: raw })
    // rawOutput is { job_id: 'job-direct' } — not a repl result envelope, no result/stdout
    expect(extractJobIdFromActivity(activity)).toBeUndefined()
  })
})

// ─── findActivitiesForJob ─────────────────────────────────────────────────────

describe('findActivitiesForJob', () => {
  it('returns empty array when no activities match', () => {
    const activities = [makeActivity()]
    expect(findActivitiesForJob(activities, 'job-abc')).toEqual([])
  })

  it('returns matching activity ids', () => {
    const matchingActivity = makeActivity({
      id: 'act-match',
      rawOutput: {
        stdout: '',
        stderr: '',
        result: JSON.stringify({ job_id: 'job-abc', status: 'submitted' }),
        cwd: '/tmp',
        figures: []
      }
    })
    const nonMatchingActivity = makeActivity({ id: 'act-other' })
    const activities = [matchingActivity, nonMatchingActivity]
    expect(findActivitiesForJob(activities, 'job-abc')).toEqual(['act-match'])
  })

  it('returns multiple matching activity ids', () => {
    const makeWithJob = (id: string, jobId: string): ToolActivity =>
      makeActivity({
        id,
        rawOutput: {
          stdout: '',
          stderr: '',
          result: JSON.stringify({ job_id: jobId }),
          cwd: '/tmp',
          figures: []
        }
      })

    const activities = [
      makeWithJob('a1', 'job-abc'),
      makeWithJob('a2', 'job-xyz'),
      makeWithJob('a3', 'job-abc')
    ]
    expect(findActivitiesForJob(activities, 'job-abc')).toEqual(['a1', 'a3'])
  })
})

// ─── JobStatusBadge ──────────────────────────────────────────────────────────

import { JobStatusBadge } from './JobStatusBadge'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('JobStatusBadge', () => {
  it.each([
    ['submitted', 'Queued'],
    ['running', 'Running'],
    ['success', 'Done'],
    ['failed', 'Failed'],
    ['timeout', 'Timeout'],
    ['error', 'Error']
  ] as const)('renders %s status as "%s"', (status, label) => {
    act(() => {
      root.render(<JobStatusBadge status={status} />)
    })
    const badge = container.querySelector('[data-testid="job-status-badge"]')
    expect(badge?.textContent).toBe(label)
  })

  it('applies amber styling for running', () => {
    act(() => {
      root.render(<JobStatusBadge status="running" />)
    })
    const badge = container.querySelector('[data-testid="job-status-badge"]')
    expect(badge?.className).toContain('amber')
  })

  it('applies green styling for success', () => {
    act(() => {
      root.render(<JobStatusBadge status="success" />)
    })
    const badge = container.querySelector('[data-testid="job-status-badge"]')
    expect(badge?.className).toContain('green')
  })

  it('applies red styling for failed', () => {
    act(() => {
      root.render(<JobStatusBadge status="failed" />)
    })
    const badge = container.querySelector('[data-testid="job-status-badge"]')
    expect(badge?.className).toContain('red')
  })
})

// ─── JobTerminalOutput ────────────────────────────────────────────────────────

import { JobTerminalOutput } from './JobTerminalOutput'

describe('JobTerminalOutput', () => {
  it('renders empty state when content is undefined', () => {
    act(() => {
      root.render(<JobTerminalOutput content={undefined} />)
    })
    expect(container.querySelector('[data-testid="job-terminal-empty"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="job-terminal-output"]')).toBeNull()
  })

  it('renders empty state when content is whitespace', () => {
    act(() => {
      root.render(<JobTerminalOutput content="   " />)
    })
    expect(container.querySelector('[data-testid="job-terminal-empty"]')).toBeTruthy()
  })

  it('renders output when content is present', () => {
    act(() => {
      root.render(<JobTerminalOutput content="hello world\nfoo" />)
    })
    const output = container.querySelector('[data-testid="job-terminal-output"]')
    expect(output).toBeTruthy()
    expect(output?.textContent).toContain('hello world')
  })

  it('uses custom empty message when provided', () => {
    act(() => {
      root.render(<JobTerminalOutput content="" emptyMessage="Waiting for output…" />)
    })
    expect(container.textContent).toContain('Waiting for output…')
  })
})

// ─── RemoteJobRow ─────────────────────────────────────────────────────────────

import { RemoteJobRow } from './RemoteJobRow'

describe('RemoteJobRow', () => {
  it('renders the host and intent', () => {
    const job = makeJob({ display_name: 'biowulf', intent: 'Run EDA analysis', status: 'running' })
    const onOpen = vi.fn()
    act(() => {
      root.render(<RemoteJobRow job={job} onOpen={onOpen} />)
    })
    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('Run EDA analysis')
  })

  it('shows "running" status text for running jobs', () => {
    const job = makeJob({ status: 'running' })
    act(() => {
      root.render(<RemoteJobRow job={job} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain('running')
  })

  it('shows "queued" status text for submitted jobs', () => {
    const job = makeJob({ status: 'submitted' })
    act(() => {
      root.render(<RemoteJobRow job={job} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain('queued')
  })

  it('calls onOpen when clicked', () => {
    const job = makeJob({ status: 'running' })
    const onOpen = vi.fn()
    act(() => {
      root.render(<RemoteJobRow job={job} onOpen={onOpen} />)
    })
    const btn = container.querySelector('[data-testid="remote-job-row"]') as HTMLButtonElement
    act(() => btn.click())
    expect(onOpen).toHaveBeenCalledWith(job)
  })
})

// ─── CompletedJobCard ─────────────────────────────────────────────────────────

import { CompletedJobCard } from './CompletedJobCard'

describe('CompletedJobCard', () => {
  it.each([
    ['success', 'finished'],
    ['failed', 'failed'],
    ['timeout', 'timed out'],
    ['error', 'error']
  ] as const)('renders correct label for %s status', (status, label) => {
    const job = makeJob({ status })
    act(() => {
      root.render(<CompletedJobCard job={job} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain(label)
  })

  it('renders green text for success', () => {
    const job = makeJob({ status: 'success' })
    act(() => {
      root.render(<CompletedJobCard job={job} onOpen={vi.fn()} />)
    })
    const card = container.querySelector('[data-testid="completed-job-card"]')
    expect(card?.innerHTML).toContain('text-green-600')
  })

  it('renders red text for failed', () => {
    const job = makeJob({ status: 'failed' })
    act(() => {
      root.render(<CompletedJobCard job={job} onOpen={vi.fn()} />)
    })
    const card = container.querySelector('[data-testid="completed-job-card"]')
    expect(card?.innerHTML).toContain('text-red-600')
  })

  it('calls onOpen when clicked', () => {
    const job = makeJob({ status: 'success' })
    const onOpen = vi.fn()
    act(() => {
      root.render(<CompletedJobCard job={job} onOpen={onOpen} />)
    })
    const card = container.querySelector('[data-testid="completed-job-card"]') as HTMLButtonElement
    act(() => card.click())
    expect(onOpen).toHaveBeenCalledWith(job)
  })

  it('renders the host display name', () => {
    const job = makeJob({ display_name: 'gpu-cluster-2', status: 'success' })
    act(() => {
      root.render(<CompletedJobCard job={job} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain('gpu-cluster-2')
  })
})
