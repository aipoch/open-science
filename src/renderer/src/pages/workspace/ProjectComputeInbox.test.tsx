// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { createComputeOutputPreviewKey, type JobSummary } from '../../../../shared/compute'
import type { NotebookProjectActivity } from '../../../../shared/notebook'
import {
  createProjectComputePreviewItem,
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { ProjectComputeInbox } from './ProjectComputeInbox'
import { PreviewPanelSurface } from './PreviewPanel'

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

  type Snapshot = NotebookProjectActivity | JobSummary[]
  type Listener = (event: { projectId: string; project_id: string }) => void
  const refreshHarness = async (
    source: 'notebook' | 'jobs'
  ): Promise<{
    read: Mock<() => Promise<Snapshot>>
    snapshot: (label: string) => Snapshot
    container: HTMLDivElement
    emit: (projectId?: string, listener?: Listener) => void
    listeners: Listener[]
    unsubscribe: Mock
  }> => {
    vi.useFakeTimers()
    const snapshot = (label: string): Snapshot =>
      source === 'jobs'
        ? [computeJob({ intent: label })]
        : {
            kernels: [
              {
                projectId: 'project-1',
                sessionId: 'session-current',
                processKey: 'python:research',
                kind: 'python',
                environment: label,
                status: 'running',
                lastActivityAt: Date.now()
              }
            ],
            backgroundRuns: []
          }
    const read = vi.fn<() => Promise<Snapshot>>().mockResolvedValue(snapshot('initial result'))
    const listeners: Array<(event: { projectId: string; project_id: string }) => void> = []
    const unsubscribe = vi.fn()
    const subscribe = (listener: Listener): (() => void) => {
      listeners.push(listener)
      return unsubscribe
    }
    Object.assign(window, {
      api: {
        notebook: {
          getProjectActivity:
            source === 'notebook'
              ? read
              : vi.fn().mockResolvedValue({ kernels: [], backgroundRuns: [] }),
          onChanged: source === 'notebook' ? subscribe : () => () => undefined
        },
        compute: {
          jobsList: source === 'jobs' ? read : vi.fn().mockResolvedValue([]),
          onJobUpdated: source === 'jobs' ? subscribe : () => () => undefined
        }
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ProjectComputeInbox />))
    const emit = (projectId = 'project-1', listener = listeners.at(-1)!): void =>
      listener({ projectId, project_id: projectId })
    return { read, snapshot, container, emit, listeners, unsubscribe }
  }

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

  describe.each(['notebook', 'jobs'] as const)('%s event refresh', (source) => {
    it('coalesces in-flight events and publishes the final snapshot without overlapping reads', async () => {
      const h = await refreshHarness(source)
      let resolve!: (value: ReturnType<typeof h.snapshot>) => void
      h.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      act(() => {
        for (let i = 0; i < 20; i++) h.emit()
      })
      expect(h.read).toHaveBeenCalledTimes(2)
      h.read.mockResolvedValue(h.snapshot('terminal result'))
      await act(async () => resolve(h.snapshot('stale result')))
      expect(h.read).toHaveBeenCalledTimes(3)
      expect(h.container.textContent).toContain('terminal result')
      expect(h.container.textContent).not.toContain('stale result')
    })

    it('retains successful data and retries failed reads without requiring another event', async () => {
      const h = await refreshHarness(source)
      h.read
        .mockRejectedValueOnce(new Error('temporary transport failure'))
        .mockResolvedValue(h.snapshot('terminal result'))
      await act(async () => h.emit())
      expect(h.container.textContent).toContain('initial result')
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      expect(h.container.textContent).toContain('terminal result')
      expect(h.read).toHaveBeenCalledTimes(3)
    })

    it('bounds retries and lets a later event restart refresh', async () => {
      const h = await refreshHarness(source)
      h.read.mockRejectedValue(new Error('offline'))
      await act(async () => h.emit())
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(h.read).toHaveBeenCalledTimes(5)
      h.read.mockResolvedValue(h.snapshot('reconnected result'))
      await act(async () => h.emit())
      expect(h.container.textContent).toContain('reconnected result')
    })

    it('ignores old project responses and callbacks and cancels retries on unmount', async () => {
      const h = await refreshHarness(source)
      let resolve!: (value: ReturnType<typeof h.snapshot>) => void
      h.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      act(() => h.emit())
      const oldListener = h.listeners[0]!
      h.read.mockResolvedValue(h.snapshot('new project result'))
      await act(async () => useNavigationStore.setState({ activeProjectId: 'project-2' }))
      expect(h.unsubscribe).toHaveBeenCalledOnce()
      await act(async () => {
        resolve(h.snapshot('old project result'))
        h.emit('project-1', oldListener)
      })
      expect(h.read).toHaveBeenCalledTimes(3)
      expect(h.container.textContent).toContain('new project result')
      expect(h.container.textContent).not.toContain('old project result')
      h.read.mockRejectedValue(new Error('offline'))
      await act(async () => h.emit('project-2'))
      act(() => {
        root?.unmount()
        root = undefined
      })
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(h.read).toHaveBeenCalledTimes(4)
      expect(h.unsubscribe).toHaveBeenCalledTimes(2)
    })
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

  it('opens another Session’s archived text and downloads an unsupported file from the Compute tab', async () => {
    const h = await refreshHarness('jobs')
    vi.useRealTimers()
    const path = 'hpc/job-1/featured/results.bin'
    const textPath = 'hpc/job-2/featured/report.txt'
    h.read.mockResolvedValue([
      computeJob({ harvested_at: Date.now(), featured_files: [path] }),
      computeJob({ job_id: 'job-2', harvested_at: Date.now(), featured_files: [textPath] })
    ])
    const content = 'Archived result from the other Session'
    const acquire = vi
      .fn()
      .mockResolvedValue({ id: 'output', size: content.length, url: 'https://preview.test/output' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(content, { status: 206 }))
    )
    const save = vi.fn().mockResolvedValue({ saved: true })
    Object.assign(window.api, {
      saveManagedFile: save,
      previewResources: { acquire, release: vi.fn().mockResolvedValue(undefined) },
      getRuntimeVersions: () => ({ electron: '39.8.10' })
    })
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectComputePreviewItem())
    await act(async () => root?.render(<PreviewPanelSurface />))
    const output = [...h.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'results.bin'
    )
    expect(output).toBeDefined()
    await act(async () => output!.click())
    const key = createComputeOutputPreviewKey({
      projectId: 'project-1',
      sessionId: 'session-attention',
      jobId: 'job-1',
      path
    })
    const workbench = usePreviewWorkbenchStore.getState()
    expect(workbench.items.find((item) => item.id === workbench.activeItemId)).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-attention',
      path: key,
      source: 'compute-output'
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('session-current')
    expect(h.container.textContent).toContain("This file type isn't supported for preview")
    expect(h.container.querySelector('[aria-label^="Edit "]')).toBeNull()
    const download = h.container.querySelector<HTMLButtonElement>(
      '[aria-label="Download results.bin"]'
    )
    expect(download).not.toBeNull()
    await act(async () => download!.click())
    expect(save).toHaveBeenCalledWith({
      source: 'compute-output',
      path: key,
      suggestedName: 'results.bin'
    })
    const computeTab = [...h.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === 'Compute'
    )
    await act(async () => computeTab!.click())
    const textFile = [...h.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'report.txt'
    )
    await act(async () => textFile!.click())
    expect(h.container.textContent).toContain(content)
    expect(h.container.querySelector('[aria-label="Edit report.txt"]')).toBeNull()
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-attention',
        source: 'compute-output',
        path: createComputeOutputPreviewKey({
          projectId: 'project-1',
          sessionId: 'session-attention',
          jobId: 'job-2',
          path: textPath
        })
      })
    )
  })

  it('distinguishes identically named targets in compact and expanded layouts', async () => {
    const h = await refreshHarness('jobs')
    const jobs = [
      computeJob({
        job_id: 'ray-job',
        provider_id: 'ray:1',
        execution_mode: 'ray_jobs',
        display_name: 'Research',
        harvested_at: Date.now(),
        featured_files: ['hpc/ray-job/featured/report.csv']
      }),
      computeJob({
        job_id: 'modal-job',
        provider_id: 'modal:8d820b1a-ff41-494c-812b-f80ee28eb733',
        display_name: 'Research',
        featured_files: ['hpc/modal-job/featured/unpublished.csv']
      }),
      computeJob({ job_id: 'legacy-job', provider_id: 'ssh:old', display_name: 'Legacy' })
    ]
    h.read.mockResolvedValueOnce(jobs)
    await act(async () => h.emit('project-1'))
    const buttons = [...h.container.querySelectorAll('button')].map((button) =>
      button.textContent?.trim()
    )
    expect(buttons.filter((name) => name === 'report.csv')).toHaveLength(1)
    expect(buttons).not.toContain('unpublished.csv')
    const labels = ['Ray Jobs · Research', 'Modal Sandboxes · Research', 'Legacy']
    const details = h.container.querySelectorAll('details')
    expect(details).toHaveLength(labels.length)
    labels.forEach((label, index) => {
      expect(details[index].querySelector('summary')?.textContent).toContain(label)
      const wideTarget = [...details[index].nextElementSibling!.querySelectorAll('dt')].find(
        (term) => term.textContent === 'Target'
      )
      expect(wideTarget?.nextElementSibling?.textContent).toBe(label)
    })
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
    ).toEqual(['Session', 'Kernel', 'Status', 'Task', 'Session', 'Target', 'Status', 'Updated'])
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

  it.each([
    { execution_mode: 'direct_ssh' as const, expected: 'Unable to confirm cancellation' },
    { execution_mode: undefined, expected: 'Unable to confirm cancellation' },
    { execution_mode: 'slurm' as const, expected: 'Running' }
  ])(
    'keeps an old $execution_mode cancellation failure visible and openable as $expected',
    async ({ execution_mode, expected }) => {
      vi.useFakeTimers()
      const now = Date.parse('2026-09-07T08:00:00.000Z')
      vi.setSystemTime(now)
      const openSession = vi.fn()
      useNavigationStore.setState({ openSession })
      const oldJob = computeJob({
        execution_mode,
        status: 'running',
        created_at: now - 72 * 60 * 60 * 1_000,
        started_at: now - 72 * 60 * 60 * 1_000,
        finished_at: undefined,
        cancellation_status: 'failed',
        cancellation_error: {
          code: 'cancel_confirmation_failed',
          message: 'Remote cancellation could not be confirmed.'
        }
      })
      const jobsList = vi.fn().mockResolvedValue([oldJob])
      let onJobUpdated: ((job: JobSummary) => void) | undefined
      Object.assign(window, {
        api: {
          notebook: {
            getProjectActivity: vi.fn().mockResolvedValue({ kernels: [], backgroundRuns: [] }),
            onChanged: vi.fn(() => () => undefined)
          },
          compute: {
            jobsList,
            onJobUpdated: (listener: typeof onJobUpdated) => {
              onJobUpdated = listener
              return () => undefined
            }
          }
        }
      })
      const container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)

      await act(async () => root?.render(<ProjectComputeInbox />))

      // Mobile and desktop both report the unresolved cancellation, without expiring it
      // as a completed job or removing the route to its Session and Retry action.
      expect(container.querySelector('summary')?.textContent).toContain(expected)
      expect(container.querySelector('dl.hidden')?.textContent).toContain(expected)
      const goToSession = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Go to Session"]'
      )!
      expect(goToSession.disabled).toBe(false)
      act(() => goToSession.click())
      expect(openSession).toHaveBeenCalledWith('project-1', 'session-attention', 'user')
      await act(async () => vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1_000))
      expect(jobsList).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('Fit remote model')

      const retryingJob: JobSummary = {
        ...oldJob,
        cancellation_status: 'cancelling',
        cancellation_error: undefined
      }
      jobsList.mockResolvedValue([retryingJob])
      await act(async () => onJobUpdated?.(retryingJob))
      expect(container.querySelector('summary')?.textContent).toContain('Cancelling')
      expect(container.textContent).not.toContain('Unable to confirm cancellation')
    }
  )

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
