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
    const stop = vi.fn(async () => undefined)
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
    await runtime.stop()

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

  it('waits for already-started polling work when the runtime stops', async () => {
    let releaseRecovery!: () => void
    const findTerminalUnharvested = vi.fn(
      () =>
        new Promise<ComputeJob[]>((resolve) => {
          releaseRecovery = () => resolve([])
        })
    )
    const jobRepository = {
      findTerminalUnharvested,
      findErrorUnnotified: vi.fn(async () => []),
      findNonTerminal: vi.fn(async () => [])
    } as unknown as ComputeJobRepository
    const runtime = createComputeJobRuntime({
      computeService: { handleJobUpdated: vi.fn() },
      hostRepository: {} as ComputeHostRepository,
      jobRepository,
      connectionBroker: {} as ComputeConnectionBroker,
      storageRoot: '/data'
    })

    runtime.start()
    await vi.waitFor(() => expect(findTerminalUnharvested).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = Promise.resolve(runtime.stop()).then(() => {
      stopped = true
    })
    await Promise.resolve()

    expect(stopped).toBe(false)

    releaseRecovery()
    await stopping
    expect(stopped).toBe(true)
  })
})
