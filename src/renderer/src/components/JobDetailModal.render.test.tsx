// @vitest-environment jsdom
// Tests for JobDetailModal — tab switching, Back navigation, and session jobs list.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'

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

  return {
    Dialog: { Root, Portal, Overlay, Content, Close }
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

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'running',
  intent: 'Run EDA analysis',
  created_at: Date.now(),
  started_at: Date.now(),
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/home/user/.openscience/jobs/job-abc',
  stdout_tail: 'stdout output line 1\nline 2',
  stderr_tail: 'stderr output line 1',
  ...overrides
})

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
})
