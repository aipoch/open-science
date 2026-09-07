// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import { makeJob } from '@/test-utils/compute-job'
import { SessionBackgroundActivity } from './SessionBackgroundActivity'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notebook: NotebookSessionReference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  runJsonPath: '/notebook/run.json'
}

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  agentFrameId: 'frame-1',
  executionMode: 'background',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'donor_level_qc()',
  status: 'running',
  startedAt: Date.now() - 5_000,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: [],
  environment: 'Python 3.12',
  ...overrides
})

const job = (overrides: Partial<JobSummary> = {}): JobSummary =>
  makeJob({
    job_id: 'job-1',
    provider_id: 'host-1',
    display_name: 'Cluster One',
    session_id: 'session-1',
    project_id: 'project-1',
    status: 'running',
    intent: 'Fit remote model',
    created_at: Date.now() - 5_000,
    started_at: Date.now() - 4_000,
    ...overrides
  })

type Props = Parameters<typeof SessionBackgroundActivity>[0]

const baseProps = (overrides: Partial<Props> = {}): Props => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  notebook,
  runs: [],
  jobs: [],
  now: Date.now(),
  onOpenNotebook: vi.fn(),
  ...overrides
})

let roots: Root[] = []

const renderLedger = async (props: Props): Promise<HTMLElement> => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<SessionBackgroundActivity {...props} />)
  })
  return container
}

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === text) as
    HTMLButtonElement | undefined

describe('Session background activity ledger', () => {
  afterEach(() => {
    act(() => {
      for (const root of roots) root.unmount()
    })
    roots = []
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('renders Compute Jobs in their own section with View all jobs and delegated Cancel', async () => {
    const jobsCancel = vi.fn().mockResolvedValue({ status: 'running' })
    const openComputeJob = vi.fn()
    const openJobList = vi.fn()
    vi.stubGlobal('window', {
      ...window,
      api: { compute: { jobsCancel } }
    })

    const container = await renderLedger(
      baseProps({ jobs: [job()], onOpenComputeJob: openComputeJob, onOpenJobList: openJobList })
    )

    expect(container.querySelector('[aria-label="Background tasks"]')).not.toBeNull()
    expect(container.textContent).toContain('Compute jobs · 1')
    expect(container.textContent).not.toContain('Local runs')
    expect(container.textContent).toContain('Remote · Cluster One')

    act(() => buttonByText(container, 'Open')?.click())
    expect(openComputeJob).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'job-1' }))

    act(() => buttonByText(container, 'Cancel')?.click())
    expect(jobsCancel).toHaveBeenCalledWith({
      jobId: 'job-1',
      providerId: 'host-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })

    act(() => buttonByText(container, 'View all jobs')?.click())
    expect(openJobList).toHaveBeenCalledWith('session-1')
  })

  it('keeps a terminal Compute Job openable without an extra status group', async () => {
    const openComputeJob = vi.fn()
    const terminalJob = job({ status: 'success', finished_at: Date.now() })
    const container = await renderLedger(
      baseProps({ jobs: [terminalJob], onOpenComputeJob: openComputeJob })
    )

    expect(container.textContent).not.toContain('History')
    expect(container.textContent).toContain('Completed')
    expect(container.textContent).toContain('Fit remote model')

    act(() => buttonByText(container, 'Open')?.click())
    expect(openComputeJob).toHaveBeenCalledWith(terminalJob)
  })

  it('renders Local runs in their own section and delegates active Cancel', async () => {
    const cancelBackgroundRun = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('window', {
      ...window,
      api: { notebook: { cancelBackgroundRun } }
    })

    const container = await renderLedger(
      baseProps({ runs: [run(), run({ runId: 'run-2' })], onOpenNotebook: open })
    )

    expect(container.textContent).toContain('Local runs · 2')
    expect(container.textContent).not.toContain('Active')
    expect(container.textContent).toContain('donor_level_qc()')
    expect(container.textContent).not.toContain('Compute jobs')

    act(() => buttonByText(container, 'Open')?.click())
    expect(open).toHaveBeenCalledWith(notebook, 'run-1')

    act(() => buttonByText(container, 'Cancel')?.click())
    expect(cancelBackgroundRun).toHaveBeenCalledWith({
      ...notebook,
      runId: 'run-1',
      agentFrameId: 'frame-1'
    })
    expect(container.textContent).toContain('Cancelling')
  })

  it('clears optimistic cancelling state after the task becomes terminal', async () => {
    vi.stubGlobal('window', {
      ...window,
      api: { notebook: { cancelBackgroundRun: vi.fn().mockResolvedValue(undefined) } }
    })
    const container = await renderLedger(baseProps({ runs: [run()] }))

    act(() => buttonByText(container, 'Cancel')?.click())
    expect(container.textContent).toContain('Cancelling')

    await act(async () => {
      roots
        .at(-1)
        ?.render(
          <SessionBackgroundActivity
            {...baseProps({ runs: [run({ status: 'completed', endedAt: Date.now() })] })}
          />
        )
    })

    expect(container.textContent).toContain('Completed')
    expect(container.textContent).not.toContain('Cancelling')
  })

  it('shows a JavaScript REPL Run with its persistent lane and active controls', async () => {
    vi.stubGlobal('window', {
      ...window,
      api: { notebook: { cancelBackgroundRun: vi.fn().mockResolvedValue(undefined) } }
    })

    const container = await renderLedger(
      baseProps({
        runs: [
          run({
            runId: 'repl-run-1',
            kernelKind: 'repl',
            script: 'await host.llm("summarize")',
            environment: undefined
          })
        ]
      })
    )

    expect(container.textContent).toContain('Persistent REPL')
    expect(container.textContent).toContain('Running')
    expect(container.textContent).toMatch(/0m \d{2}s/u)
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Open',
      'Cancel'
    ])
  })

  it('shows Shell Commands with bounded slot state', async () => {
    vi.stubGlobal('window', {
      ...window,
      api: { notebook: { cancelBackgroundRun: vi.fn().mockResolvedValue(undefined) } }
    })

    const container = await renderLedger(
      baseProps({
        runs: [
          run({
            runId: 'shell-running',
            kernelKind: 'bash',
            script: 'long-command',
            shellConcurrency: { limit: 2, slot: 1 }
          }),
          run({
            runId: 'shell-queued',
            kernelKind: 'bash',
            script: 'next-command',
            status: 'queued',
            shellConcurrency: { limit: 2 }
          })
        ]
      })
    )

    expect(container.textContent).toContain('Shell slot 1 of 2')
    expect(container.textContent).toContain('Waiting for shell slot')
    expect(container.textContent).not.toContain('Compute Job')
    expect(container.textContent).not.toContain('View all jobs')
  })

  it('shows only the execution outcome for terminal Local runs', async () => {
    const container = await renderLedger(
      baseProps({
        runs: [run({ status: 'completed', endedAt: Date.now() })]
      })
    )

    expect(container.textContent).toContain('Completed')
    expect(container.textContent).not.toMatch(/Awaiting Agent|Needs Agent|Pending delivery/u)
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Open'
    ])
  })

  it('renders nothing when both sections are empty', async () => {
    const container = await renderLedger(baseProps())
    expect(container.textContent).toBe('')
  })
})
