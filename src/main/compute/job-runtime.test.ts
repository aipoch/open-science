import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { JobPollerDeps } from './job-poller'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ScpRunner } from './scp-runner'
import type { SshRunner } from './ssh-runner'
import { createComputeJobRuntime } from './job-runtime'

describe('createComputeJobRuntime', () => {
  it('routes updates through the service-owned seams and delegates runtime start/stop', async () => {
    const handleJobUpdated = vi.fn()
    const start = vi.fn()
    const stop = vi.fn()
    const runner = {} as SshRunner
    const scpRunner = {} as ScpRunner
    const hostRepository = {} as ComputeHostRepository
    const jobRepository = {} as ComputeJobRepository
    const broadcast = vi.fn()
    const harvest = vi.fn(async () => undefined)
    let wiredPollerDeps: JobPollerDeps | undefined
    const createPoller = vi.fn((deps: JobPollerDeps) => {
      wiredPollerDeps = deps
      return { start, stop }
    })
    const runtime = createComputeJobRuntime(
      {
        computeService: { handleJobUpdated },
        hostRepository,
        jobRepository,
        storageRoot: '/data'
      },
      { runner, scpRunner, broadcast, harvest, createPoller }
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
      sshRunner: runner,
      scpRunner,
      hostRepository,
      jobRepository,
      storageRoot: '/data',
      broadcast
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
