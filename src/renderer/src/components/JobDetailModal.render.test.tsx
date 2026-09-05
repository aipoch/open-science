// @vitest-environment jsdom
// Tests for JobDetailModal — tab switching, Back navigation, and session jobs list.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'
import { makeJob as makeComputeJob } from '@/test-utils/compute-job'
import { useSettingsStore } from '@/stores/settings-store'

// Mock radix Dialog to avoid portal / overlay complexity in jsdom
vi.mock('radix-ui', () => {
  const Root = ({
    open,
    children
  }: {
    open: boolean
    children: React.ReactNode
    onOpenChange?: (o: boolean) => void
  }): React.JSX.Element | null => (open ? <div data-testid="dialog-root">{children}</div> : null)

  const Portal = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="dialog-portal">{children}</div>
  )
  const Overlay = (): React.JSX.Element => <div data-testid="dialog-overlay" />
  const Content = ({
    children,
    ...rest
  }: {
    children: React.ReactNode
    [k: string]: unknown
  }): React.JSX.Element => (
    <div data-testid="dialog-content" {...rest}>
      {children}
    </div>
  )
  const Close = ({
    children
  }: {
    children: React.ReactElement
    asChild?: boolean
  }): React.JSX.Element => children
  const TooltipRoot = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <>{children}</>
  )
  const TooltipTrigger = ({ children }: { children: React.ReactElement }): React.JSX.Element =>
    children
  const TooltipContent = ({ children }: { children?: React.ReactNode }): React.JSX.Element => (
    <>{children}</>
  )

  return {
    Dialog: { Root, Portal, Overlay, Content, Close },
    Tooltip: {
      Root: TooltipRoot,
      Provider: TooltipRoot,
      Portal: TooltipRoot,
      Trigger: TooltipTrigger,
      Content: TooltipContent
    }
  }
})

// Mock FileBrowserModal
vi.mock('../pages/settings/FileBrowserModal', () => ({
  FileBrowserModal: ({
    open,
    initialProviderId
  }: {
    open: boolean
    onClose: () => void
    initialProviderId?: string
  }): React.JSX.Element | null =>
    open ? <div data-testid="file-browser-modal" data-provider={initialProviderId} /> : null
}))

// Mock Button
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    [k: string]: unknown
  }): React.JSX.Element => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  )
}))

const makeJob = (
  overrides: Parameters<typeof makeComputeJob>[0] = {}
): ReturnType<typeof makeComputeJob> => {
  const now = Date.now()
  return makeComputeJob({
    job_id: 'job-abc',
    session_id: 'sess-1',
    project_id: 'project-1',
    status: 'running',
    intent: 'Run EDA analysis',
    created_at: now,
    started_at: now,
    remote_workdir: '/home/user/.openscience/jobs/job-abc',
    stdout_tail: 'stdout output line 1\nline 2',
    stderr_tail: 'stderr output line 1',
    ...overrides
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionJobStore.setState(createInitialSessionJobState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('JobDetailModal — detail view', () => {
  it('requests cancellation with the complete owner tuple and disables while cancelling', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob()
    const jobsCancel = vi.fn(async () => ({
      job_id: job.job_id,
      status: job.status,
      cancellation_status: 'cancelling' as const
    }))
    const jobsList = vi.fn(async () => [{ ...job, cancellation_status: 'cancelling' as const }])
    ;(
      window as unknown as {
        api: { compute: { jobsCancel: typeof jobsCancel; jobsList: typeof jobsList } }
      }
    ).api = {
      compute: { jobsCancel, jobsList }
    }
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="job-cancel"]') as HTMLButtonElement).click()
    })

    expect(jobsCancel).toHaveBeenCalledWith({
      jobId: job.job_id,
      providerId: job.provider_id,
      sessionId: job.session_id,
      projectId: job.project_id
    })
    expect(
      (container.querySelector('[data-testid="job-cancel"]') as HTMLButtonElement).disabled
    ).toBe(true)
    expect(container.textContent).toContain('Cancelling')
  })

  it('refreshes details by fetching the Session job list', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ status: 'running', stdout_tail: 'old output' })
    const refreshed = makeJob({ status: 'success', stdout_tail: 'fresh output' })
    const jobsList = vi.fn(async () => [refreshed])
    ;(window as unknown as { api: { compute: { jobsList: typeof jobsList } } }).api = {
      compute: { jobsList }
    }
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="job-detail-refresh"]') as HTMLButtonElement).click()
    })

    expect(jobsList).toHaveBeenCalledWith({ sessionId: 'sess-1' })
    expect(container.textContent).toContain('fresh output')
  })

  it('offers a retry action after cancellation fails', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob()
    const jobsCancel = vi.fn().mockRejectedValue(new Error('cancel unavailable'))
    const jobsList = vi.fn(async () => [job])
    ;(
      window as unknown as {
        api: { compute: { jobsCancel: typeof jobsCancel; jobsList: typeof jobsList } }
      }
    ).api = { compute: { jobsCancel, jobsList } }
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="job-cancel"]') as HTMLButtonElement).click()
    })
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => retry?.click())

    expect(container.textContent).toContain('Unable to cancel remote job.')
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
      'cancel unavailable'
    )
    expect(jobsCancel).toHaveBeenCalledTimes(2)
  })

  it('shows a retry control for hydration and harvest failures', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      status: 'success',
      harvest_error: 'harvest pending: host_unreachable'
    })
    const state = useSessionJobStore.getState()
    const jobsList = vi.fn(async () => [job])
    ;(window as unknown as { api: { compute: { jobsList: typeof jobsList } } }).api = {
      compute: { jobsList }
    }
    useSessionJobStore.setState({
      ...state,
      jobsById: new Map([[job.job_id, job]]),
      loadErrorBySession: new Map([['sess-1', 'database busy']])
    })

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('Unable to load remote jobs.')
    expect(container.textContent).toContain(
      'Harvest pending. Open Science will retry automatically.'
    )
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retry).toBeDefined()
    await act(async () => retry?.click())
    expect(jobsList).toHaveBeenCalledWith({ sessionId: 'sess-1' })
  })

  it('renders job meta info when opened with a job', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ intent: 'Run EDA analysis', display_name: 'biowulf' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('Run EDA analysis')
    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('job-abc')
  })

  it('keeps quarantined persisted jobs visible with an explicit diagnostic', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      status: 'error',
      raw_status: 'future_state',
      needs_attention: true,
      integrity_issues: [
        {
          jobId: 'job-abc',
          sessionId: 'sess-1',
          projectId: 'project-1',
          code: 'unknown-status',
          disposition: 'quarantined',
          rawStatus: 'future_state'
        }
      ]
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('Saved remote job data needs attention')
    expect(container.textContent).toContain('unknown-status')
    expect(container.textContent).toContain('future_state')
  })

  it('offers recovery for a background authentication failure', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const openSettingsToComputeAuthentication = vi.fn()
    useSettingsStore.setState({ openSettingsToComputeAuthentication })
    const job = makeJob({ last_poll_error: 'authentication_failed' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })
    const manage = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Manage credentials'
    )
    act(() => manage?.click())

    expect(openSettingsToComputeAuthentication).toHaveBeenCalledWith(
      'ssh:biowulf',
      'authentication_failed'
    )
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('renders stdout tab content by default', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      stdout_tail: 'this is stdout output',
      stderr_tail: 'this is stderr output'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    // By default stdout is active
    const output = container.querySelector('[data-testid="job-terminal-output"]')
    expect(output?.textContent).toContain('this is stdout output')
  })

  it('switches to stderr tab when clicked', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      stdout_tail: 'stdout content',
      stderr_tail: 'stderr content'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    const stderrTab = container.querySelector('[data-testid="tab-stderr"]') as HTMLButtonElement
    act(() => stderrTab.click())

    const output = container.querySelector('[data-testid="job-terminal-output"]')
    expect(output?.textContent).toContain('stderr content')
  })

  it('shows Back button that navigates to session jobs list', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob()
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    const backBtn = container.querySelector('[data-testid="job-detail-back"]') as HTMLButtonElement
    act(() => backBtn.click())

    // After Back, should show session jobs list
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
  })

  it('renders remote workdir link', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ remote_workdir: '/home/user/.openscience/jobs/job-abc' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('/home/user/.openscience/jobs/job-abc')
  })

  it('opens FileBrowserModal when workdir link is clicked', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      remote_workdir: '/home/user/.openscience/jobs/job-abc',
      provider_id: 'ssh:biowulf'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    // Find the workdir link button
    const workdirBtn = container.querySelector(
      '[data-testid="job-meta"] button'
    ) as HTMLButtonElement
    act(() => workdirBtn.click())

    const browser = container.querySelector('[data-testid="file-browser-modal"]')
    expect(browser).toBeTruthy()
    expect(browser?.getAttribute('data-provider')).toBe('ssh:biowulf')
  })
})

describe('JobDetailModal — session jobs list view', () => {
  it('shows list of session jobs when opened without initialJob', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job1 = makeJob({ job_id: 'job-1', intent: 'Intent 1', session_id: 'sess-1' })
    const job2 = makeJob({ job_id: 'job-2', intent: 'Intent 2', session_id: 'sess-1' })
    const otherSessionJob = makeJob({ job_id: 'job-other', session_id: 'sess-other' })
    useSessionJobStore.getState().applyUpdate(job1)
    useSessionJobStore.getState().applyUpdate(job2)
    useSessionJobStore.getState().applyUpdate(otherSessionJob)

    act(() => {
      root.render(<JobDetailModal open={false} sessionId="sess-1" onClose={vi.fn()} />)
    })

    // Modal is closed — nothing rendered
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeNull()
  })

  it('shows session jobs list with jobs from this session', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job1 = makeJob({ job_id: 'job-1', intent: 'Intent A', session_id: 'sess-1' })
    const job2 = makeJob({ job_id: 'job-2', intent: 'Intent B', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job1)
    useSessionJobStore.getState().applyUpdate(job2)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
    expect(container.textContent).toContain('Intent A')
    expect(container.textContent).toContain('Intent B')
  })

  it('clicking a job row in the list opens its detail view', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ job_id: 'job-list-test', intent: 'From list', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    // Should be in list view
    const listView = container.querySelector('[data-testid="session-jobs-list"]')
    expect(listView).toBeTruthy()

    // Click on the job row
    const jobRow = container.querySelector('[data-testid="session-job-row"]') as HTMLButtonElement
    act(() => jobRow.click())

    // Should now be in detail view
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeNull()
  })

  it('returns to the session jobs list when the same modal is reopened', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ job_id: 'job-reopen', intent: 'Reopen test', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })
    const jobRow = container.querySelector('[data-testid="session-job-row"]') as HTMLButtonElement
    act(() => jobRow.click())
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeTruthy()

    act(() => {
      root.render(<JobDetailModal open={false} sessionId="sess-1" onClose={vi.fn()} />)
    })
    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeNull()
  })
})
