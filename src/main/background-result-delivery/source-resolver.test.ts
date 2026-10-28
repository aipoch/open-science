import { describe, expect, it, vi } from 'vitest'

import type { BackgroundResultDelivery } from '../../shared/background-result-delivery'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { JobSummary } from '../../shared/compute'
import { resolveBackgroundResultSources } from './source-resolver'

const row = (sourceId: string, sessionId = 'session-1'): BackgroundResultDelivery => ({
  id: `local-run:${sourceId}`,
  sourceKind: 'local-run',
  sourceId,
  projectId: 'project-1',
  sessionId,
  state: 'pending',
  attemptCount: 0,
  createdAt: 1,
  updatedAt: 1
})

const run = (runId: string, status: NotebookRunRecord['status']): NotebookRunRecord => ({
  runId,
  executionMode: 'background',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(42)',
  status,
  startedAt: 1,
  endedAt: 2,
  text: { stdout: '42\n', stderr: '', traceback: '', plain: ['42'] },
  outputs: [],
  artifacts: [],
  workingFiles: []
})

const computeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:cluster',
  display_name: 'Cluster',
  shape: 'scheduler_cluster',
  session_id: 'session-1',
  project_id: 'project-1',
  status: 'failed',
  intent: 'Analyze',
  created_at: 1,
  started_at: 2,
  finished_at: 3,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/scratch/job-1',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: 3,
  notification_consumed_at: undefined,
  ...overrides
})

const computeRow = (): BackgroundResultDelivery => ({
  ...row('job-1'),
  id: 'compute-job:job-1',
  sourceKind: 'compute-job'
})

describe('resolveBackgroundResultSources', () => {
  it('delivers external cancellation before collection with the same Agent conclusion', async () => {
    const job = computeJob({ error_code: 'job_cancelled' })
    const [resolved] = await resolveBackgroundResultSources([computeRow()], {
      loadNotebookRuns: async () => [],
      loadComputeJobs: async () => new Map([['job-1', job]])
    })
    expect(resolved).toMatchObject({
      availability: 'terminal',
      activity: { active: false },
      outcome: { status: 'cancelled', result_final: true, job_id: 'job-1' }
    })
    expect(resolved?.outcome).not.toHaveProperty('error')
    expect(resolved?.outcome).not.toHaveProperty('cancellation_status')
  })

  it('delivers complete unavailable errors and failed cancellation together', async () => {
    const job = computeJob({
      status: 'error',
      error_code: 'job_status_unavailable',
      error_message: 'The remote process may still be running.',
      cancellation_status: 'failed',
      cancellation_error: { code: 'cancel_confirmation_failed', message: 'No confirmation source.' }
    })
    const [resolved] = await resolveBackgroundResultSources([computeRow()], {
      loadNotebookRuns: async () => [],
      loadComputeJobs: async () => new Map([['job-1', job]])
    })
    expect(resolved?.outcome).toMatchObject({
      status: 'error',
      result_final: true,
      error: {
        code: 'job_status_unavailable',
        message: 'The remote process may still be running.'
      },
      cancellation: { status: 'failed', error: { code: 'cancel_confirmation_failed' } }
    })
  })

  it('uses the settled failure snapshot after that operation has been reopened', async () => {
    const failure = {
      jobId: 'job-1',
      operationId: 'op-1',
      revision: 4,
      jobStatus: 'running' as const,
      error: { code: 'cancel_request_rejected', message: 'Original permission denial.' }
    }
    const event: BackgroundResultDelivery = {
      ...computeRow(),
      id: 'compute-cancellation:op-1:4',
      sourceKind: 'compute-cancellation',
      sourceId: 'op-1:4',
      sourceSnapshot: failure
    }
    const currentJob = computeJob({ status: 'running', cancellation_status: 'cancelling' })
    const [resolved] = await resolveBackgroundResultSources([event], {
      loadNotebookRuns: async () => [],
      loadComputeJobs: async () => new Map([['op-1:4', currentJob]])
    })
    expect(resolved).toMatchObject({
      availability: 'terminal',
      outcome: {
        status: 'running',
        result_final: false,
        event: 'cancellation_failed',
        revision: 4,
        cancellation: { status: 'failed', error: failure.error }
      }
    })
  })

  it.each(['success', 'cancelled', 'error'] as const)(
    'keeps historical rejection facts coherent after the job becomes %s',
    async (status) => {
      const event: BackgroundResultDelivery = {
        ...computeRow(),
        id: 'compute-cancellation:op-1:4',
        sourceKind: 'compute-cancellation',
        sourceId: 'op-1:4',
        sourceSnapshot: {
          jobId: 'job-1',
          operationId: 'op-1',
          revision: 4,
          jobStatus: 'running',
          error: { code: 'cancel_request_rejected', message: 'Original permission denial.' }
        }
      }
      const currentJob = computeJob({
        status: status === 'cancelled' ? 'failed' : status,
        cancellation_status: status === 'cancelled' ? 'cancelled' : undefined
      })
      const [resolved] = await resolveBackgroundResultSources([event], {
        loadNotebookRuns: async () => [],
        loadComputeJobs: async () => new Map([['op-1:4', currentJob]])
      })
      expect(resolved?.outcome).toMatchObject({
        status: 'running',
        result_final: false,
        event: 'cancellation_failed',
        cancellation: { status: 'failed' }
      })
    }
  )
  it('loads each Notebook Session once and resolves exact Run identities', async () => {
    const loadNotebookRuns = vi.fn(
      async ({ sources }: { sources: readonly BackgroundResultDelivery[] }) =>
        sources.map(({ sourceId }) => run(sourceId, 'completed'))
    )
    const resolved = await resolveBackgroundResultSources([row('run-1'), row('run-2')], {
      loadNotebookRuns,
      loadComputeJobs: vi.fn(async () => new Map())
    })
    expect(loadNotebookRuns).toHaveBeenCalledOnce()
    expect(resolved.map(({ availability }) => availability)).toEqual(['terminal', 'terminal'])
    expect(resolved[0]?.outcome).toMatchObject({ runId: 'run-1', resultSummary: 'stdout:\n42' })
    expect(resolved[0]?.activity).toEqual({
      id: 'local-run:run-1',
      sourceKind: 'local-run',
      sourceId: 'run-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      executionType: 'python',
      lane: 'Python',
      status: 'pending-delivery',
      active: false,
      needsAttention: false,
      outcomeStatus: 'completed',
      updatedAt: 1
    })
    expect(resolved[0]?.activity).not.toHaveProperty('attemptCount')
    expect(resolved[0]?.activity).not.toHaveProperty('claimToken')
    expect(resolved[0]?.activity).not.toHaveProperty('continuationMessageId')
  })

  it('batches exact Notebook lookups within the authority query limit', async () => {
    const deliveries = Array.from({ length: 21 }, (_, index) => row(`run-${index + 1}`))
    const loadNotebookRuns = vi.fn(
      async ({ sources }: { sources: readonly BackgroundResultDelivery[] }) =>
        sources.map(({ sourceId }) => run(sourceId, 'completed'))
    )

    const resolved = await resolveBackgroundResultSources(deliveries, {
      loadNotebookRuns,
      loadComputeJobs: vi.fn(async () => new Map())
    })

    expect(loadNotebookRuns).toHaveBeenCalledTimes(2)
    expect(loadNotebookRuns.mock.calls.map(([group]) => group.sources.length)).toEqual([20, 1])
    expect(resolved).toHaveLength(21)
    expect(resolved.every(({ availability }) => availability === 'terminal')).toBe(true)
  })

  it('distinguishes an active authority from a confirmed missing source', async () => {
    const resolved = await resolveBackgroundResultSources([row('active'), row('missing')], {
      loadNotebookRuns: async () => [run('active', 'running')],
      loadComputeJobs: async () => new Map()
    })
    expect(resolved.map(({ availability }) => availability)).toEqual(['not-ready', 'missing'])
  })

  it('treats an unreadable authority as temporarily unavailable, not missing', async () => {
    const resolved = await resolveBackgroundResultSources([row('run-1')], {
      loadNotebookRuns: async () => {
        throw new Error('temporarily unreadable')
      },
      loadComputeJobs: async () => new Map()
    })
    expect(resolved[0]?.availability).toBe('unavailable')
  })
})
