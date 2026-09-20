import { describe, expect, it, vi } from 'vitest'

import type { BackgroundResultDelivery } from '../../shared/background-result-delivery'
import type { NotebookRunRecord } from '../../shared/notebook'
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

describe('resolveBackgroundResultSources', () => {
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
