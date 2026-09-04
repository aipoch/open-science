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
    const handleJobCancellationConfirmed = vi.fn(async () => undefined)
    const startQueueReconciliation = vi.fn()
    const stopQueueReconciliation = vi.fn(async () => undefined)
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
        computeService: {
          handleJobUpdated,
          handleJobCancellationConfirmed,
          startQueueReconciliation,
          stopQueueReconciliation
        },
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
    await runtime.start()
    await runtime.stop()

    expect(handleJobUpdated).toHaveBeenCalledWith(job)
    expect(harvest).toHaveBeenCalledWith(job, {
      connectionBroker,
      hostRepository,
      jobRepository,
      storageRoot: '/data',
      broadcast,
      publishJobUpdated: handleJobUpdated
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(startQueueReconciliation).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stopQueueReconciliation).toHaveBeenCalledTimes(1)
    expect(jobDeletionOwner.bindRuntime).toHaveBeenCalledWith({
      pause: expect.any(Function),
      resume: expect.any(Function)
    })
    expect(unbind).toHaveBeenCalledOnce()
  })

  it('keeps queued promotion stopped when Session limit restoration fails', async () => {
    const start = vi.fn()
    const stop = vi.fn(async () => undefined)
    const startQueueReconciliation = vi.fn(async () => {
      throw new Error('Session catalog unavailable')
    })
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(async () => undefined),
          startQueueReconciliation,
          stopQueueReconciliation: vi.fn(async () => undefined)
        },
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {} as ComputeJobRepository,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot: '/data'
      },
      {
        createPoller: () => ({
          start,
          stop,
          pause: vi.fn(async () => undefined),
          resume: vi.fn()
        })
      }
    )

    await expect(runtime.start()).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledOnce()
    expect(startQueueReconciliation).toHaveBeenCalledOnce()
    await runtime.stop()
    expect(stop).toHaveBeenCalledOnce()
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
      computeService: {
        handleJobUpdated: vi.fn(),
        handleJobCancellationConfirmed: vi.fn(async () => undefined),
        startQueueReconciliation: vi.fn(),
        stopQueueReconciliation: vi.fn(async () => undefined)
      },
      hostRepository: {} as ComputeHostRepository,
      jobRepository,
      connectionBroker: {} as ComputeConnectionBroker,
      storageRoot: '/data'
    })

    await runtime.start()
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

  it('closes queue reconciliation before aborting and draining lifecycle workers', async () => {
    const events: string[] = []
    let releaseReconciliation!: () => void
    const stopQueueReconciliation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push('reconciliation-stopping')
          releaseReconciliation = () => {
            events.push('reconciliation-stopped')
            resolve()
          }
        })
    )
    const stopPoller = vi.fn(async () => {
      events.push('poller-stopped')
    })
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(async () => undefined),
          startQueueReconciliation: vi.fn(),
          stopQueueReconciliation
        },
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {} as ComputeJobRepository,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot: '/data'
      },
      {
        createPoller: () => ({
          start: vi.fn(),
          stop: stopPoller,
          pause: vi.fn(async () => undefined),
          resume: vi.fn()
        })
      }
    )

    const stopping = runtime.stop()
    await vi.waitFor(() => expect(stopQueueReconciliation).toHaveBeenCalledOnce())
    expect(stopPoller).not.toHaveBeenCalled()
    releaseReconciliation()
    await stopping

    expect(events).toEqual(['reconciliation-stopping', 'reconciliation-stopped', 'poller-stopped'])
  })

  it('does not reopen queue reconciliation when stop overlaps poller startup', async () => {
    let releasePollerStart!: () => void
    const pollerStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePollerStart = resolve
        })
    )
    const startQueueReconciliation = vi.fn(async () => undefined)
    const stopQueueReconciliation = vi.fn(async () => undefined)
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(async () => undefined),
          startQueueReconciliation,
          stopQueueReconciliation
        },
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {} as ComputeJobRepository,
        connectionBroker: {} as ComputeConnectionBroker,
        storageRoot: '/data'
      },
      {
        createPoller: () => ({
          start: pollerStart,
          stop: vi.fn(async () => undefined),
          pause: vi.fn(async () => undefined),
          resume: vi.fn()
        })
      }
    )

    const starting = runtime.start()
    await vi.waitFor(() => expect(pollerStart).toHaveBeenCalledOnce())
    const stopping = runtime.stop()
    await vi.waitFor(() => expect(stopQueueReconciliation).toHaveBeenCalledOnce())
    releasePollerStart()
    await Promise.all([starting, stopping])

    expect(startQueueReconciliation).not.toHaveBeenCalled()
  })

  it('cancels in-flight polling and harvest work when the runtime stops', async () => {
    const runningJob = {
      job_id: 'job-running',
      provider_id: 'ssh:cluster',
      status: 'running',
      remote_handle: JSON.stringify({
        pid: 1234,
        exit_code_path: '~/.openscience/jobs/job-running/exit_code',
        stdout_path: '~/.openscience/jobs/job-running/stdout',
        stderr_path: '~/.openscience/jobs/job-running/stderr',
        workdir: '~/.openscience/jobs/job-running'
      }),
      remote_workdir: '~/.openscience/jobs/job-running'
    } as ComputeJob
    const terminalJob = {
      ...runningJob,
      job_id: 'job-terminal',
      status: 'success'
    } as ComputeJob
    let pollSignal: AbortSignal | undefined
    let harvestSignal: AbortSignal | undefined
    let releasePoll!: () => void
    let releaseHarvest!: () => void
    const run = vi.fn(
      () =>
        new Promise<{
          exitCode: number
          stdout: string
          stderr: string
          timedOut: boolean
          truncated: boolean
        }>((resolve) => {
          releasePoll = () =>
            resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false })
        })
    )
    const connectionBroker = {
      acquire: vi.fn(async (_providerId: string, request: { signal?: AbortSignal }) => {
        pollSignal = request.signal
        request.signal?.addEventListener('abort', () => releasePoll(), { once: true })
        return { run }
      })
    } as unknown as ComputeConnectionBroker
    const harvest = vi.fn(
      (_job: ComputeJob, deps: unknown) =>
        new Promise<void>((resolve) => {
          harvestSignal = (deps as { signal?: AbortSignal }).signal
          releaseHarvest = resolve
          harvestSignal?.addEventListener('abort', () => releaseHarvest(), { once: true })
        })
    )
    const jobRepository = {
      findTerminalUnharvested: vi.fn(async () => [terminalJob]),
      findNotificationReadyUnnotified: vi.fn(async () => []),
      findNonTerminal: vi.fn(async () => [runningJob])
    } as unknown as ComputeJobRepository
    const runtime = createComputeJobRuntime(
      {
        computeService: {
          handleJobUpdated: vi.fn(),
          handleJobCancellationConfirmed: vi.fn(async () => undefined),
          startQueueReconciliation: vi.fn(),
          stopQueueReconciliation: vi.fn(async () => undefined)
        },
        hostRepository: {} as ComputeHostRepository,
        jobRepository,
        connectionBroker,
        storageRoot: '/data'
      },
      { harvest }
    )

    await runtime.start()
    await vi.waitFor(() => {
      expect(harvest).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledOnce()
    })

    const stopping = runtime.stop()
    try {
      await vi.waitFor(() => {
        expect(pollSignal?.aborted).toBe(true)
        expect(harvestSignal?.aborted).toBe(true)
      })
      await stopping
    } finally {
      releasePoll()
      releaseHarvest()
      await stopping
    }
  })
})
