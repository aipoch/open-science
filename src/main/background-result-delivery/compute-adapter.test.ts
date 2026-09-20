import { describe, expect, it, vi } from 'vitest'
import type { JobSummary } from '../../shared/compute'
import type { BackgroundResultSourceRef } from '../../shared/background-result-delivery'
import {
  ComputeJobResultDeliveryAdapter,
  type ComputeJobResultDeliveryAdapterDeps
} from './compute-adapter'

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'host-1',
  display_name: 'Compute Host',
  shape: 'cpu',
  session_id: 'session-1',
  project_id: 'project-1',
  status: 'running',
  intent: 'Analyze results',
  created_at: 1,
  started_at: 2,
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

const source: BackgroundResultSourceRef = {
  sourceKind: 'compute-job',
  sourceId: 'job-1',
  projectId: 'project-1',
  sessionId: 'session-1'
}

const harness = (): {
  adapter: ComputeJobResultDeliveryAdapter
  deps: {
    [K in keyof ComputeJobResultDeliveryAdapterDeps]: ReturnType<
      typeof vi.fn<ComputeJobResultDeliveryAdapterDeps[K]>
    >
  }
} => {
  const deps = {
    register: vi.fn<ComputeJobResultDeliveryAdapterDeps['register']>().mockResolvedValue(undefined),
    enqueue: vi.fn<ComputeJobResultDeliveryAdapterDeps['enqueue']>().mockResolvedValue(undefined),
    acknowledgeObserved: vi
      .fn<ComputeJobResultDeliveryAdapterDeps['acknowledgeObserved']>()
      .mockResolvedValue('suppressed'),
    listWaiting: vi.fn<ComputeJobResultDeliveryAdapterDeps['listWaiting']>().mockResolvedValue([]),
    hasDeliveryPath: vi
      .fn<ComputeJobResultDeliveryAdapterDeps['hasDeliveryPath']>()
      .mockResolvedValue(false)
  }
  return { adapter: new ComputeJobResultDeliveryAdapter(deps), deps }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Compute Job result delivery adapter', () => {
  it.each(['queued', 'submitted', 'running'] as const)(
    'admits %s Jobs but does not deliver premature results',
    async (status) => {
      const { adapter, deps } = harness()
      const active = job({ status, notified_at: 0, harvested_at: 0 })
      await adapter.observeJob(active)
      await adapter.observeNotification(active)
      expect(await adapter.observeResult(active)).toBe('pending')
      expect(deps.register).toHaveBeenCalledExactlyOnceWith(source)
      expect(deps.enqueue).not.toHaveBeenCalled()
      expect(deps.acknowledgeObserved).not.toHaveBeenCalled()
    }
  )

  it.each(['success', 'failed', 'timeout', 'error'] as const)(
    'does not readmit a %s Job and waits for its notification marker',
    async (status) => {
      const { adapter, deps } = harness()
      await adapter.observeJob(job({ status }))
      await adapter.observeNotification(job({ status }))
      expect(deps.register).not.toHaveBeenCalled()
      expect(deps.enqueue).not.toHaveBeenCalled()
      await adapter.observeNotification(job({ status, notified_at: 0 }))
      expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(source)
    }
  )

  it.each(['success', 'failed', 'timeout'] as const)(
    'waits for harvest before acknowledging a %s result',
    async (status) => {
      const { adapter, deps } = harness()
      expect(await adapter.observeResult(job({ status }))).toBe('pending')
      expect(deps.acknowledgeObserved).not.toHaveBeenCalled()
      expect(await adapter.observeResult(job({ status, harvested_at: 0 }))).toBe('suppressed')
      expect(deps.acknowledgeObserved).toHaveBeenCalledExactlyOnceWith(source)
    }
  )

  it.each(['pending', 'suppressed', 'committed'] as const)(
    'preserves the %s disposition for an error without harvest',
    async (disposition) => {
      const { adapter, deps } = harness()
      deps.acknowledgeObserved.mockResolvedValue(disposition)
      expect(await adapter.observeResult(job({ status: 'error' }))).toBe(disposition)
      expect(deps.acknowledgeObserved).toHaveBeenCalledExactlyOnceWith(source)
    }
  )

  it('serializes admission, notification and observation without blocking another Job', async () => {
    const { adapter, deps } = harness()
    const admission = deferred()
    const entered = deferred()
    const notification = deferred()
    const enqueued = deferred()
    deps.register.mockImplementation(async (ref) => {
      if (ref.sourceId === 'job-1') {
        entered.resolve()
        await admission.promise
      }
    })
    deps.enqueue.mockImplementation(async () => {
      enqueued.resolve()
      await notification.promise
    })
    const registering = adapter.observeJob(job())
    await entered.promise
    const notifying = adapter.observeNotification(job({ status: 'success', notified_at: 3 }))
    await adapter.observeJob(job({ job_id: 'job-2' }))
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.register).toHaveBeenCalledWith({ ...source, sourceId: 'job-2' })
    admission.resolve()
    await registering
    await enqueued.promise
    const observing = adapter.observeResult(job({ status: 'success', harvested_at: 4 }))
    // An independent Job provides a completed async boundary while Job 1's notification is held.
    await adapter.observeJob(job({ job_id: 'job-3' }))
    expect(deps.acknowledgeObserved).not.toHaveBeenCalled()
    notification.resolve()
    await notifying
    expect(await observing).toBe('suppressed')
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(source)
    expect(deps.acknowledgeObserved).toHaveBeenCalledExactlyOnceWith(source)
  })

  it('propagates a failed operation and still executes the next queued operation', async () => {
    const { adapter, deps } = harness()
    const failure = new Error('Admission unavailable')
    deps.register.mockRejectedValueOnce(failure)
    const registering = adapter.observeJob(job())
    const rejected = expect(registering).rejects.toBe(failure)
    const notifying = adapter.observeNotification(job({ status: 'error', notified_at: 5 }))
    await rejected
    await notifying
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(source)
    deps.acknowledgeObserved.mockRejectedValueOnce(failure)
    await expect(adapter.observeResult(job({ status: 'error' }))).rejects.toBe(failure)
    expect(await adapter.observeResult(job({ status: 'error' }))).toBe('suppressed')
  })

  it('rejects missing Project scope before any delivery port is called', async () => {
    const { adapter, deps } = harness()
    await expect(adapter.observeJob(job({ project_id: undefined }))).rejects.toThrow(
      'has no Project scope'
    )
    await expect(
      adapter.observeNotification(job({ project_id: undefined, status: 'error', notified_at: 1 }))
    ).rejects.toThrow('has no Project scope')
    await expect(
      adapter.observeResult(job({ project_id: undefined, status: 'error' }))
    ).rejects.toThrow('has no Project scope')
    expect(deps.register).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.acknowledgeObserved).not.toHaveBeenCalled()
  })

  it('takes over only active Jobs while preserving their Project and Session identities', async () => {
    const { adapter, deps } = harness()
    await adapter.takeOver([
      job(),
      job({ job_id: 'job-2', status: 'queued', project_id: 'project-2', session_id: 'session-2' }),
      job({ job_id: 'job-3', status: 'success' })
    ])
    expect(deps.register.mock.calls).toEqual([
      [source],
      [{ ...source, sourceId: 'job-2', projectId: 'project-2', sessionId: 'session-2' }]
    ])
  })

  it('recovers waiting Jobs without inventing results for missing or active Jobs', async () => {
    const { adapter, deps } = harness()
    deps.listWaiting.mockResolvedValue([
      source,
      { ...source, sourceId: 'missing' },
      { ...source, sourceId: 'active' }
    ])
    const loadJob = vi.fn(async (id: string): Promise<JobSummary | undefined> => {
      if (id === 'missing') return undefined
      return id === 'active' ? job({ job_id: id }) : job({ status: 'success', notified_at: 0 })
    })
    await adapter.recoverWaiting(loadJob)
    expect(loadJob.mock.calls).toEqual([['job-1'], ['missing'], ['active']])
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(source)
    expect(deps.register).not.toHaveBeenCalled()
  })

  it('propagates waiting-source lookup failures', async () => {
    const { adapter, deps } = harness()
    deps.listWaiting.mockResolvedValue([source])
    const failure = new Error('Job lookup unavailable')
    await expect(adapter.recoverWaiting(vi.fn().mockRejectedValue(failure))).rejects.toBe(failure)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'returns delivery ownership %s for the exact Compute Job identity',
    async (exists) => {
      const { adapter, deps } = harness()
      deps.hasDeliveryPath.mockResolvedValue(exists)
      expect(await adapter.hasDeliveryPath('job-2')).toBe(exists)
      expect(deps.hasDeliveryPath).toHaveBeenCalledExactlyOnceWith('compute-job', 'job-2')
    }
  )
})
