import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { JobPollerDeps } from './job-poller'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeConnectionBroker } from './connection-broker'
import { createComputeJobRuntime } from './job-runtime'

describe('createComputeJobRuntime', () => {
  it('routes updates through the service-owned seams and delegates runtime start/stop', async () => {
    const handleJobUpdated = vi.fn()
    const start = vi.fn()
    const stop = vi.fn()
    const pause = vi.fn(async () => undefined)
    const resume = vi.fn()
    const unbind = vi.fn()
    const jobDeletionOwner = { bindRuntime: vi.fn(() => unbind) }
    const connectionBroker = {} as ComputeConnectionBroker
    const hostRepository = {} as ComputeHostRepository
    const jobRepository = {} as ComputeJobRepository
    const broadcast = vi.fn()
    const harvest = vi.fn(async () => undefined)
    let wiredPollerDeps: JobPollerDeps | undefined
    const createPoller = vi.fn((deps: JobPollerDeps) => {
      wiredPollerDeps = deps
      return { start, stop, pause, resume }
    })
    const runtime = createComputeJobRuntime(
      {
        computeService: { handleJobUpdated },
        jobDeletionOwner,
        hostRepository,
        jobRepository,
        connectionBroker,
        storageRoot: '/data'
      },
      { broadcast, harvest, createPoller }
    )
    const pollerDeps = wiredPollerDeps
    expect(pollerDeps).toBeDefined()
    const job = {
      job_id: 'job-1',
      provider_id: 'ssh:cluster',
      status: 'success'
    } as ComputeJob

    pollerDeps?.onJobUpdated?.(job)
    await pollerDeps?.harvestFn?.(job)
    runtime.start()
    runtime.stop()

    expect(handleJobUpdated).toHaveBeenCalledWith(job)
    expect(harvest).toHaveBeenCalledWith(job, {
      connectionBroker,
      hostRepository,
      jobRepository,
      storageRoot: '/data',
      broadcast
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(jobDeletionOwner.bindRuntime).toHaveBeenCalledWith({ start, stop, pause, resume })
    expect(unbind).toHaveBeenCalledOnce()
  })
})
