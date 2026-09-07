// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type { JobSummary } from '../../../../shared/compute'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { ProjectComputeInbox } from './ProjectComputeInbox'

vi.mock('react-i18next', () => createI18nTestStub())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = (id: string, title: string): ChatSession => ({
  id,
  projectId: 'project-1',
  title,
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

const computeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:cluster-one',
  display_name: 'Cluster One',
  shape: 'scheduler_cluster',
  session_id: 'session-attention',
  project_id: 'project-1',
  status: 'success',
  intent: 'Fit remote model',
  created_at: Date.now() - 60_000,
  started_at: Date.now() - 50_000,
  finished_at: Date.now() - 10_000,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: '/scratch/job-1',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

describe('Project Compute inbox', () => {
  let root: Root | undefined

  beforeEach(() => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    useSessionStore.setState({
      sessions: [
        session('session-current', 'Current analysis'),
        session('session-attention', 'Needs review')
      ],
      selectedSessionId: 'session-current'
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows only the latest Kernel per Session with its matching active background Run', async () => {
    const getProjectActivity = vi.fn().mockResolvedValue({
      kernels: [
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          processKey: 'r:previous',
          kind: 'r',
          environment: 'previous',
          status: 'idle',
          lastActivityAt: Date.now() - 10_000
        },
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          processKey: 'python:research',
          kind: 'python',
          environment: 'research',
          status: 'running',
          lastActivityAt: Date.now() - 1_000
        }
      ],
      backgroundRuns: [
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          runId: 'run-1',
          executionType: 'python',
          processKey: 'python:research',
          title: 'Donor-level QC',
          acceptedAt: Date.now() - 5_000
        },
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          runId: 'run-earlier',
          executionType: 'python',
          processKey: 'python:research',
          title: 'Earlier donor QC',
          acceptedAt: Date.now() - 7_000
        },
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          runId: 'run-previous',
          executionType: 'r',
          processKey: 'r:previous',
          title: 'Previous export',
          acceptedAt: Date.now() - 8_000
        },
        {
          projectId: 'project-1',
          sessionId: 'session-attention',
          runId: 'run-unattached',
          executionType: 'python',
          title: 'Unattached task',
          acceptedAt: Date.now() - 3_000
        }
      ]
    })
    const jobsList = vi.fn().mockResolvedValue([])
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          notebook: {
            getProjectActivity,
            onChanged: vi.fn(() => () => undefined)
          },
          compute: { jobsList, onJobUpdated: vi.fn(() => () => undefined) }
        }
      })
    )
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectComputeInbox />))
    await vi.waitFor(() => expect(container.textContent).toContain('Donor-level QC'))

    expect(container.textContent).toContain('Active kernels')
    expect(container.textContent).toContain('Current analysis')
    expect(container.textContent).toContain('Python · research')
    expect(container.textContent).toContain('Running')
    expect(container.textContent).toContain('Background')
    expect(container.textContent).not.toContain('R · previous')
    expect(container.textContent).not.toContain('Earlier donor QC')
    expect(container.textContent).not.toContain('Previous export')
    expect(container.textContent).not.toContain('Unattached task')
    expect(container.textContent).not.toContain('Background tasks')
    expect(getProjectActivity).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('presents responsive Compute rows and navigates to each Kernel or Job Session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-09-07T08:00:00.000Z'))
    const openSession = vi.fn()
    useNavigationStore.setState({ openSession })
    const getProjectActivity = vi.fn().mockResolvedValue({
      kernels: [
        {
          projectId: 'project-1',
          sessionId: 'session-current',
          processKey: 'python:research',
          kind: 'python',
          environment: 'research',
          status: 'running',
          lastActivityAt: Date.now() - 1_000
        }
      ],
      backgroundRuns: []
    })
    const jobsList = vi.fn().mockResolvedValue([computeJob()])
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          notebook: { getProjectActivity, onChanged: vi.fn(() => () => undefined) },
          compute: { jobsList, onJobUpdated: vi.fn(() => () => undefined) }
        }
      })
    )
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectComputeInbox />))
    await vi.waitFor(() => expect(container.textContent).toContain('Fit remote model'))

    expect(
      Array.from(container.querySelectorAll('[role="columnheader"]'), (cell) => cell.textContent)
    ).toEqual(['Session', 'Kernel', 'Status', 'Task', 'Session', 'Host', 'Status', 'Updated'])
    const navigationButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Go to Session"]')
    )
    expect(navigationButtons).toHaveLength(2)
    expect(navigationButtons.every((button) => button.title === 'Go to Session')).toBe(true)
    expect(navigationButtons.every((button) => button.textContent === '')).toBe(true)
    const jobDetails = container.querySelector('details')
    expect(jobDetails?.open).toBe(false)
    act(() => jobDetails?.querySelector('summary')?.click())
    expect(jobDetails?.open).toBe(true)
    act(() => navigationButtons[0]?.click())
    act(() => navigationButtons[1]?.click())
    expect(openSession).toHaveBeenNthCalledWith(1, 'project-1', 'session-current', 'user')
    expect(openSession).toHaveBeenNthCalledWith(2, 'project-1', 'session-attention', 'user')
    expect(jobsList).toHaveBeenCalledWith({
      projectId: 'project-1',
      since: Date.parse('2026-09-05T08:00:00.000Z')
    })
  })

  it('refreshes once when the earliest completed Compute Job leaves the 48-hour window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = Date.parse('2026-09-07T08:00:00.000Z')
    vi.setSystemTime(now)
    const expiringJob = computeJob({ finished_at: now - 48 * 60 * 60 * 1_000 + 1_000 })
    const jobsList = vi.fn().mockResolvedValueOnce([expiringJob]).mockResolvedValueOnce([])
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          notebook: {
            getProjectActivity: vi.fn().mockResolvedValue({ kernels: [], backgroundRuns: [] }),
            onChanged: vi.fn(() => () => undefined)
          },
          compute: { jobsList, onJobUpdated: vi.fn(() => () => undefined) }
        }
      })
    )
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectComputeInbox />))
    await vi.waitFor(() => expect(container.textContent).toContain('Fit remote model'))

    await act(async () => vi.advanceTimersByTimeAsync(1_001))
    await vi.waitFor(() => expect(jobsList).toHaveBeenCalledTimes(2))
    expect(container.textContent).not.toContain('Fit remote model')
  })

  it('refreshes Kernel and Compute Job queries only from their matching Project events', async () => {
    const calls: string[] = []
    let notebookChanged: ((event: { projectId: string }) => void) | undefined
    let jobUpdated: ((job: { project_id?: string }) => void) | undefined
    const getProjectActivity = vi.fn(async () => {
      calls.push('notebook-query')
      return { kernels: [], backgroundRuns: [] }
    })
    const jobsList = vi.fn(async () => {
      calls.push('jobs-query')
      return []
    })
    const onNotebookChanged = vi.fn((listener: typeof notebookChanged) => {
      calls.push('notebook-subscribe')
      notebookChanged = listener
      return () => undefined
    })
    const onJobUpdated = vi.fn((listener: typeof jobUpdated) => {
      calls.push('jobs-subscribe')
      jobUpdated = listener
      return () => undefined
    })
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          notebook: { getProjectActivity, onChanged: onNotebookChanged },
          compute: { jobsList, onJobUpdated }
        }
      })
    )
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectComputeInbox />))
    await vi.waitFor(() => expect(jobsList).toHaveBeenCalledOnce())

    expect(calls.indexOf('notebook-subscribe')).toBeLessThan(calls.indexOf('notebook-query'))
    expect(calls.indexOf('jobs-subscribe')).toBeLessThan(calls.indexOf('jobs-query'))
    act(() => notebookChanged?.({ projectId: 'project-2' }))
    act(() => jobUpdated?.({ project_id: 'project-2' }))
    expect(getProjectActivity).toHaveBeenCalledOnce()
    expect(jobsList).toHaveBeenCalledOnce()

    act(() => notebookChanged?.({ projectId: 'project-1' }))
    await vi.waitFor(() => expect(getProjectActivity).toHaveBeenCalledTimes(2))
    expect(jobsList).toHaveBeenCalledOnce()

    act(() => jobUpdated?.({ project_id: 'project-1' }))
    await vi.waitFor(() => expect(jobsList).toHaveBeenCalledTimes(2))
    expect(getProjectActivity).toHaveBeenCalledTimes(2)
  })
})
