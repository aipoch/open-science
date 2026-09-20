import { JobHarvestScheduler } from './job-harvest-scheduler'
import { broadcastJobUpdated } from './ipc'
import { harvestJob } from './harvest-engine'
import { JobPoller, type JobPollerDeps } from './job-poller'
import type { ComputeJobDeletionOwner } from './job-deletion-owner'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeService } from './compute-service'
import type { ComputeConnectionBroker } from './connection-broker'
import { createLogger, errorLogFields } from '../logger'
import { ComputeJobCancellationReaper } from './compute-job-cancellation-owner'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'

const log = createLogger('compute-integrity')

type ComputeJobRuntime = { start(): void | Promise<void>; stop(): Promise<void> }

type ComputeJobRuntimeDeps = {
  computeService: Pick<
    ComputeService,
    | 'bindJobHarvestRetry'
    | 'handleJobUpdated'
    | 'handleJobCancellationConfirmed'
    | 'startQueueReconciliation'
    | 'stopQueueReconciliation'
  >
  jobDeletionOwner?: Pick<ComputeJobDeletionOwner, 'bindRuntime'>
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  connectionBroker: ComputeConnectionBroker
  storageRoot: string
}

type ComputeJobRuntimeAdapters = {
  broadcast?: typeof broadcastJobUpdated
  harvest?: typeof harvestJob
  createPoller?: (deps: JobPollerDeps) => ComputeJobRuntime & Pick<JobPoller, 'pause' | 'resume'>
  createCancellationReaper?: (
    repository: ComputeJobOperationRepository
  ) => ComputeJobRuntime & Pick<ComputeJobCancellationReaper, 'pause' | 'resume'>
}

// Owns the production poller's complete job-update contract. Main-process startup supplies only the
// long-lived compute handles; every update is routed through ComputeService, while notifications and
// harvesting retain their dedicated projections.
export const createComputeJobRuntime = (
  deps: ComputeJobRuntimeDeps,
  adapters: ComputeJobRuntimeAdapters = {}
): ComputeJobRuntime => {
  const broadcast = adapters.broadcast ?? broadcastJobUpdated
  const harvest = adapters.harvest ?? harvestJob
  let harvestAbortController = new AbortController()
  const pollerDeps: JobPollerDeps = {
    connectionBroker: deps.connectionBroker,
    hostRepository: deps.hostRepository,
    jobRepository: deps.jobRepository,
    onJobUpdated: deps.computeService.handleJobUpdated,
    broadcast,
    onIntegrityIssues: (issues) => {
      for (const issue of issues) log.warn('compute job needs attention', issue)
    },
    storageRoot: deps.storageRoot,
    harvestFn: async (job, signal) => {
      signal = signal
        ? AbortSignal.any([signal, harvestAbortController.signal])
        : harvestAbortController.signal
      if (signal.aborted) return
      const latest = await deps.jobRepository.get(job.job_id)
      if (!latest || latest.harvested_at || latest.remote_cleanup_disposition === 'cleaned') return
      await harvest(latest, {
        connectionBroker: deps.connectionBroker,
        hostRepository: deps.hostRepository,
        jobRepository: deps.jobRepository,
        storageRoot: deps.storageRoot,
        broadcast,
        publishJobUpdated: deps.computeService.handleJobUpdated,
        signal
      })
    }
  }

  const harvestScheduler = new JobHarvestScheduler(pollerDeps.harvestFn!)
  pollerDeps.harvestScheduler = harvestScheduler

  const unbindHarvestRetry = deps.computeService.bindJobHarvestRetry(async (request) => {
    if (stopRequested || harvestAbortController.signal.aborted) {
      throw new Error('Compute recovery is paused.')
    }
    const signal = harvestAbortController.signal
    const job = await deps.jobRepository.get(request.jobId)
    if (
      !job ||
      job.project_id !== request.projectId ||
      job.session_id !== request.sessionId ||
      job.provider_id !== request.providerId
    )
      throw new Error('Compute Job is unavailable.')
    signal.throwIfAborted()
    if (!['success', 'failed', 'timeout'].includes(job.status) || job.needs_attention) {
      throw new Error('Compute Job has no confirmed execution result to collect.')
    }
    if (job.harvested_at !== undefined) return
    if (job.remote_cleanup_disposition === 'cleaned' || !job.remote_workdir) {
      throw new Error('Remote results are unavailable.')
    }
    await harvestScheduler.retry(job, signal)
  })

  const poller = adapters.createPoller?.(pollerDeps) ?? new JobPoller(pollerDeps)
  const cancellationReaper = deps.operationRepository
    ? (adapters.createCancellationReaper?.(deps.operationRepository) ??
      new ComputeJobCancellationReaper(
        deps.operationRepository,
        deps.jobRepository,
        deps.connectionBroker,
        {
          onConfirmed: async (jobId) => {
            const job = await deps.jobRepository.get(jobId)
            if (!job) return
            try {
              await harvestScheduler.schedule(job)
            } finally {
              const latest = await deps.jobRepository.get(jobId)
              if (latest) await deps.computeService.handleJobCancellationConfirmed(latest)
            }
          }
        }
      ))
    : undefined
  let stopRequested = false
  const deletionRuntime = {
    pause: async (): Promise<void> => {
      harvestAbortController.abort()
      await Promise.all([poller.pause(), cancellationReaper?.pause()])
    },
    resume: (): void => {
      if (stopRequested) return
      harvestAbortController = new AbortController()
      poller.resume()
      cancellationReaper?.resume()
    }
  }
  const unbindDeletionRuntime = deps.jobDeletionOwner?.bindRuntime(deletionRuntime)
  let startTask: Promise<void> | undefined
  let stopTask: Promise<void> | undefined
  return {
    start: () => {
      if (stopRequested) return
      startTask ??= (async () => {
        await Promise.all([poller.start(), cancellationReaper?.start()])
        if (stopRequested) return
        try {
          await deps.computeService.startQueueReconciliation()
        } catch (error) {
          log.warn(
            'compute queue reconciliation remains stopped after Session limit restoration failed',
            errorLogFields(error)
          )
        }
      })()
      return startTask
    },
    stop: () => {
      stopRequested = true
      stopTask ??= (async () => {
        const failures: unknown[] = []
        const attempt = async (cleanup: () => unknown): Promise<void> => {
          try {
            await cleanup()
          } catch (error) {
            failures.push(error)
          }
        }
        await attempt(() => unbindHarvestRetry())
        await attempt(() => unbindDeletionRuntime?.())
        await attempt(() => deps.computeService.stopQueueReconciliation())
        await attempt(() => startTask)
        harvestAbortController.abort()
        await Promise.all([attempt(() => poller.stop()), attempt(() => cancellationReaper?.stop())])
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, 'Compute runtime cleanup failed.')
      })()
      return stopTask
    }
  }
}

export type { ComputeJobRuntime, ComputeJobRuntimeAdapters, ComputeJobRuntimeDeps }
