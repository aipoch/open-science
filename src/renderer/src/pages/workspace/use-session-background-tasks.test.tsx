// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePackageOperationStore } from '../../stores/package-operation-store'
import type { BackgroundResultActivityItem } from '../../../../shared/background-result-delivery'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import {
  useSessionBackgroundTasks,
  type SessionBackgroundTasks
} from './use-session-background-tasks'

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

const delivery = (
  overrides: Partial<BackgroundResultActivityItem> = {}
): BackgroundResultActivityItem => ({
  id: 'delivery-1',
  sourceKind: 'local-run',
  sourceId: 'run-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  executionType: 'python',
  title: 'QC',
  lane: 'Python',
  status: 'pending-delivery',
  active: false,
  needsAttention: false,
  updatedAt: Date.now() - 1_000,
  ...overrides
})

const jobDelivery = (
  overrides: Partial<BackgroundResultActivityItem> = {}
): BackgroundResultActivityItem =>
  delivery({
    id: 'delivery-job-1',
    sourceKind: 'compute-job',
    sourceId: 'job-1',
    executionType: 'compute-job',
    title: 'Remote sweep',
    lane: 'Cluster One',
    ...overrides
  })

const runningJob = {
  job_id: 'job-1',
  provider_id: 'host-1',
  display_name: 'Cluster One',
  shape: 'cpu',
  session_id: 'session-1',
  project_id: 'project-1',
  status: 'running',
  intent: 'Fit remote model',
  created_at: Date.now() - 5_000,
  started_at: Date.now() - 4_000,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/remote/job-1',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  result_delivery_path: 'agent-result-delivery'
}

const emptyDeliveryApi = (): {
  getSessionActivity: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
} => ({
  getSessionActivity: vi.fn().mockResolvedValue({ active: [], awaitingAgent: [] }),
  onChanged: vi.fn(() => () => undefined)
})

// Probe component exposing the hook output for assertions. The snapshot is captured in an
// effect (never during render) so the react-hooks purity rules hold.
let latest: SessionBackgroundTasks | undefined
const Probe = ({
  sessionId,
  projectId,
  notebook
}: {
  sessionId: string | undefined
  projectId: string | undefined
  notebook: NotebookSessionReference | undefined
}): React.JSX.Element => {
  const tasks = useSessionBackgroundTasks(sessionId, projectId, notebook)
  useEffect(() => {
    latest = tasks
  })
  return <div data-testid="probe" />
}

const stubApi = (api: unknown): void => {
  vi.stubGlobal('window', {
    ...window,
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    api
  })
}

describe('useSessionBackgroundTasks', () => {
  let root: Root | undefined

  const mount = async (
    sessionId: string | undefined,
    projectId: string | undefined,
    notebookRef: NotebookSessionReference | undefined
  ): Promise<void> => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe sessionId={sessionId} projectId={projectId} notebook={notebookRef} />)
    })
  }

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    usePackageOperationStore.setState({ operation: null })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    latest = undefined
  })

  it('pauses Notebook polling while its Session is exporting and resumes after release', async () => {
    vi.useFakeTimers()
    const state = vi.fn().mockResolvedValue({ runs: [run()] })
    stubApi({
      backgroundResultDelivery: emptyDeliveryApi(),
      notebook: { state, onChanged: vi.fn(() => () => undefined) }
    })
    await mount('session-1', 'project-1', notebook)
    expect(state).toHaveBeenCalledTimes(1)
    await act(async () => {
      usePackageOperationStore.getState().receive({
        id: 'export-1',
        kind: 'export',
        state: 'awaiting-selection',
        session: { projectId: 'project-1', sessionId: 'session-1' },
        progress: { phase: 'selecting' }
      })
    })
    state.mockClear()
    state.mockRejectedValue(
      new Error('This Session is locked while its research package is being exported.')
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(state).not.toHaveBeenCalled()
    expect(latest?.runs).toHaveLength(1)
    state.mockResolvedValue({ runs: [] })
    await act(async () => {
      usePackageOperationStore.getState().receive(null)
    })
    expect(state).toHaveBeenCalledTimes(1)
    expect(latest?.runs).toHaveLength(0)
  })

  it('collects background Runs, deliveries, and Compute Jobs with a unified summary', async () => {
    const runStart = Date.now() - 5_000
    stubApi({
      backgroundResultDelivery: emptyDeliveryApi(),
      notebook: {
        state: vi.fn().mockResolvedValue({
          runs: [
            run({ startedAt: runStart }),
            run({ runId: 'foreground', executionMode: 'foreground' })
          ]
        }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      },
      compute: {
        jobsList: vi.fn().mockResolvedValue([runningJob]),
        onJobUpdated: vi.fn(() => () => undefined),
        jobsCancel: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(latest?.runs).toHaveLength(1))

    expect(latest?.runs[0]?.runId).toBe('run-1')
    expect(latest?.jobs).toHaveLength(1)
    expect(latest?.summary.activeCount).toBe(2)
    expect(latest?.summary.totalTasks).toBe(2)
    expect(latest?.summary.oldestActiveStartedAt).toBe(runStart)
  })

  it('keeps observing Compute Jobs and their deliveries without a Notebook', async () => {
    const state = vi.fn().mockResolvedValue({ runs: [] })
    stubApi({
      backgroundResultDelivery: {
        getSessionActivity: vi
          .fn()
          .mockResolvedValue({ active: [], awaitingAgent: [jobDelivery()] }),
        onChanged: vi.fn(() => () => undefined)
      },
      notebook: { state, onChanged: vi.fn(() => () => undefined), cancelBackgroundRun: vi.fn() },
      compute: {
        jobsList: vi
          .fn()
          .mockResolvedValue([{ ...runningJob, status: 'success', finished_at: Date.now() }]),
        onJobUpdated: vi.fn(() => () => undefined),
        jobsCancel: vi.fn()
      }
    })

    await mount('session-1', 'project-1', undefined)
    await vi.waitFor(() => expect(latest?.jobs).toHaveLength(1))

    expect(state).not.toHaveBeenCalled()
    expect(latest?.runs).toHaveLength(0)
    expect(latest?.summary.activeCount).toBe(0)
    expect(latest?.summary.totalTasks).toBe(1)
  })

  it('orders active work before rows awaiting delivery', async () => {
    stubApi({
      backgroundResultDelivery: {
        getSessionActivity: vi.fn().mockResolvedValue({ active: [], awaitingAgent: [delivery()] }),
        onChanged: vi.fn(() => () => undefined)
      },
      notebook: {
        state: vi.fn().mockResolvedValue({
          runs: [
            run({ status: 'completed', endedAt: Date.now() }),
            run({ runId: 'live-run', startedAt: Date.now() - 1_000 })
          ]
        }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(latest?.runs).toHaveLength(2))

    expect(latest?.runs.map((item) => item.runId)).toEqual(['live-run', 'run-1'])
  })

  it('keeps terminal Rows only while a delivery awaits', async () => {
    stubApi({
      backgroundResultDelivery: emptyDeliveryApi(),
      notebook: {
        state: vi.fn().mockResolvedValue({
          runs: [run({ status: 'completed', endedAt: Date.now() })]
        }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(latest).toBeDefined())
    expect(latest?.runs).toHaveLength(0)
    expect(latest?.summary.totalTasks).toBe(0)
  })

  it('keeps terminal Compute Jobs after delivery while hiding terminal Local Runs', async () => {
    const jobsList = vi
      .fn()
      .mockResolvedValue([{ ...runningJob, status: 'success', finished_at: Date.now() }])
    stubApi({
      backgroundResultDelivery: emptyDeliveryApi(),
      notebook: {
        state: vi.fn().mockResolvedValue({
          runs: [run({ status: 'completed', endedAt: Date.now() })]
        }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      },
      compute: {
        jobsList,
        onJobUpdated: vi.fn(() => () => undefined),
        jobsCancel: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(jobsList).toHaveBeenCalledOnce())

    expect(latest?.runs).toHaveLength(0)
    expect(latest?.jobs.map((item) => item.job_id)).toEqual(['job-1'])
    expect(latest?.summary).toMatchObject({ activeCount: 0, totalTasks: 1 })
  })

  it('clears the previous Session snapshot immediately when the Session changes', async () => {
    const jobsList = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'session-1' ? [runningJob] : []
    )
    stubApi({
      backgroundResultDelivery: emptyDeliveryApi(),
      notebook: {
        state: vi.fn().mockResolvedValue({ runs: [run()] }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      },
      compute: {
        jobsList,
        onJobUpdated: vi.fn(() => () => undefined),
        jobsCancel: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(latest?.summary.totalTasks).toBe(2))

    await act(async () => {
      root?.render(<Probe sessionId="session-2" projectId="project-1" notebook={undefined} />)
    })

    expect(latest?.runs).toEqual([])
    await vi.waitFor(() => expect(latest?.summary.totalTasks).toBe(0))
  })

  it('subscribes before hydrate and refreshes only for delivery events in its Project', async () => {
    const calls: string[] = []
    let changed: ((event: { projectId: string }) => void) | undefined
    const getSessionActivity = vi.fn(async () => {
      calls.push('query')
      return { active: [], awaitingAgent: [] }
    })
    const onChanged = vi.fn((listener: typeof changed) => {
      calls.push('subscribe')
      changed = listener
      return () => undefined
    })
    stubApi({
      backgroundResultDelivery: { getSessionActivity, onChanged },
      notebook: {
        state: vi.fn().mockResolvedValue({ runs: [] }),
        onChanged: vi.fn(() => () => undefined),
        cancelBackgroundRun: vi.fn()
      }
    })

    await mount('session-1', 'project-1', notebook)
    await vi.waitFor(() => expect(getSessionActivity).toHaveBeenCalledOnce())

    expect(calls.slice(0, 2)).toEqual(['subscribe', 'query'])
    act(() => changed?.({ projectId: 'project-2' }))
    expect(getSessionActivity).toHaveBeenCalledOnce()
    act(() => changed?.({ projectId: 'project-1' }))
    await vi.waitFor(() => expect(getSessionActivity).toHaveBeenCalledTimes(2))
  })
})
