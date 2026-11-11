import type { ComputeJobDeletionOwner } from '@aipoch/compute/node'
import {
  ComputeJobCancellationReaper,
  createHarvestScheduler,
  JobPoller,
  type JobPollerDeps
} from '@aipoch/compute/node'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ComputeService } from './compute-service'
import type { ComputeConnectionBroker } from './connection-broker'
import { createModalJobRuntime } from './modal-job-runtime'
import type { ComputeJob } from '@aipoch/compute'
import type { ExternalComputeMode } from '../../shared/compute'
import { createKubernetesJobRuntime } from './kubernetes-job-runtime'
import { createHuggingFaceJobRuntime } from './hugging-face-job-runtime'
import { createRayJobRuntime } from './ray-job-runtime'
import { harvestJob, type HarvestDeps } from './harvest-engine'
import { broadcastJobUpdated } from './ipc'
import { createNotifyingJobPoller, emitJobNotification } from './job-notifier'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { resourceActivity } from '../resource-diagnostics/activity'

const log = createLogger('compute-integrity')

type ComputeJobRuntime = { start(): void | Promise<void>; stop(): Promise<void> }

type ComputeJobRuntimeDeps = {
  computeService: Pick<
    ComputeService,
    | 'execution'
    | 'bindJobHarvestRetry'
    | 'handleJobUpdated'
    | 'handleJobCancellationConfirmed'
    | 'startQueueReconciliation'
    | 'stopQueueReconciliation'
  > &
    Partial<Pick<ComputeService, 'bindExternalJobRuntime'>>
  jobDeletionOwner?: Pick<ComputeJobDeletionOwner, 'bindRuntime'>
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  connectionBroker: ComputeConnectionBroker
  storageRoot: string
}

type ComputeJobRuntimeAdapters = {
  onCancellationFailed?: (
    job: import('../../shared/compute').ComputeJob,
    failure: Omit<
      import('../../shared/background-result-delivery').ComputeCancellationFailureSnapshot,
      'jobStatus'
    >
  ) => Promise<void>
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
    onIntegrityIssues: (issues) => {
      for (const issue of issues) log.warn('compute job needs attention', issue)
    },
    harvestFn: async (job, signal) => {
      signal = signal
        ? AbortSignal.any([signal, harvestAbortController.signal])
        : harvestAbortController.signal
      if (signal.aborted) return
      const latest = await deps.jobRepository.get(job.job_id)
      if (!latest || latest.harvested_at || latest.remote_cleanup_disposition === 'cleaned') return
      await resourceActivity.run(() =>
        harvest(latest, {
          connectionBroker: deps.connectionBroker,
          hostRepository: deps.hostRepository,
          jobRepository: deps.jobRepository,
          storageRoot: deps.storageRoot,
          broadcast,
          publishJobUpdated: deps.computeService.handleJobUpdated,
          signal
        })
      )
    }
  }

  type ExternalRuntime = ReturnType<typeof createKubernetesJobRuntime> & {
    retry?(jobId: string): Promise<void>
    manualCleanup?(job: ComputeJob): Promise<void>
  }
  const external = new Map<ExternalComputeMode, ExternalRuntime>()
  if (deps.computeService.bindExternalJobRuntime && deps.operationRepository) {
    const dependencies = {
      jobRepository: deps.jobRepository,
      operationRepository: deps.operationRepository,
      storageRoot: deps.storageRoot,
      onJobUpdated: deps.computeService.handleJobUpdated
    }
    const harvestExternal = (
      job: ComputeJob,
      files: Pick<
        HarvestDeps,
        'workspaceConnection' | 'rayOutputs' | 'modalOutputs' | 'hostedOutputs'
      >,
      signal: AbortSignal
    ): Promise<void> =>
      resourceActivity.run(() =>
        harvest(job, {
          connectionBroker: deps.connectionBroker,
          hostRepository: deps.hostRepository,
          jobRepository: deps.jobRepository,
          storageRoot: deps.storageRoot,
          broadcast,
          publishJobUpdated: deps.computeService.handleJobUpdated,
          ...files,
          signal
        })
      )
    external.set(
      'kubernetes',
      createKubernetesJobRuntime({
        ...dependencies,
        harvest: (job, workspaceConnection, signal) =>
          harvestExternal(job, { workspaceConnection }, signal)
      })
    )
    external.set(
      'hugging_face_jobs',
      createHuggingFaceJobRuntime({
        ...dependencies,
        harvest: (job, hostedOutputs, signal) => harvestExternal(job, { hostedOutputs }, signal)
      })
    )
    external.set(
      'ray_jobs',
      createRayJobRuntime({
        ...dependencies,
        harvest: (job, rayOutputs, signal) => harvestExternal(job, { rayOutputs }, signal)
      })
    )
    external.set(
      'modal_sandbox',
      createModalJobRuntime({
        ...dependencies,
        harvest: (job, modalOutputs, signal) => harvestExternal(job, { modalOutputs }, signal)
      })
    )
  }
  const activeCleanups = new Map<string, Promise<void>>()
  const unbindExternal = Array.from(external, ([mode, runtime]) => {
    const cleanup = runtime.manualCleanup
    return deps.computeService.bindExternalJobRuntime!(
      mode,
      () => runtime.tick(),
      cleanup &&
        ((job) => {
          if (stopRequested || harvestAbortController.signal.aborted)
            throw new Error('Compute recovery is paused.')
          const active = activeCleanups.get(job.job_id)
          if (active) return active
          const task = resourceActivity
            .run(async () => {
              const current = await deps.jobRepository.get(job.job_id)
              if (
                !current ||
                current.project_id !== job.project_id ||
                current.session_id !== job.session_id ||
                current.provider_id !== job.provider_id ||
                current.execution_mode !== mode
              )
                throw new Error('Compute Job cleanup scope does not match.')
              if (current.remote_cleanup_disposition === 'cleaned') return
              if (current.remote_handle !== job.remote_handle)
                throw new Error('Compute Job cleanup information has changed.')
              harvestAbortController.signal.throwIfAborted()
              await cleanup(current)
            })
            .finally(() => activeCleanups.delete(job.job_id))
          activeCleanups.set(job.job_id, task)
          return task
        })
    )
  })
  const runtimes = Array.from(external.values())
  const harvestScheduler = createHarvestScheduler(pollerDeps.harvestFn!)
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
    if (
      job.execution_mode &&
      job.execution_mode !== 'slurm' &&
      job.execution_mode !== 'direct_ssh'
    ) {
      const runtime = external.get(job.execution_mode)
      if (!runtime) throw new Error('Compute recovery is unavailable.')
      await (runtime.retry ? runtime.retry(job.job_id) : runtime.tick())
      return
    }
    await harvestScheduler.retry(job, signal)
  })

  const poller =
    adapters.createPoller?.(pollerDeps) ??
    createNotifyingJobPoller({
      ...pollerDeps,
      execution: deps.computeService.execution,
      jobRepository: deps.jobRepository,
      hostRepository: deps.hostRepository,
      storageRoot: deps.storageRoot,
      broadcast
    })
  const cancellationReaper = deps.operationRepository
    ? (adapters.createCancellationReaper?.(deps.operationRepository) ??
      deps.computeService.execution.createCancellationReaper(
        deps.operationRepository,
        deps.jobRepository,
        deps.connectionBroker,
        {
          onConfirmed: async (jobId) => {
            const job = await deps.jobRepository.get(jobId)
            if (!job) return
            // Execution settlement must be observable independently of result collection. A slow
            // download must neither hold the cancellation reaper nor delay releasing queue slots.
            // The shared scheduler owns collection, deduplication, and its shutdown drain.
            if (job.status !== 'error')
              void harvestScheduler.schedule(job, harvestAbortController.signal)
            await deps.computeService.handleJobCancellationConfirmed(job)
            await emitJobNotification(job, {
              jobRepository: deps.jobRepository,
              hostRepository: deps.hostRepository,
              storageRoot: deps.storageRoot,
              broadcast
            })
          },
          onFailed: async (jobId, failure) => {
            const job = await deps.jobRepository.get(jobId)
            if (!job) return
            deps.computeService.handleJobUpdated(job)
            await adapters.onCancellationFailed?.(job, { ...failure, jobId })
          }
        }
      ))
    : undefined
  let stopRequested = false
  const deletionRuntime = {
    pause: async (): Promise<void> => {
      harvestAbortController.abort()
      await Promise.all([
        poller.pause(),
        cancellationReaper?.pause(),
        ...runtimes.map((r) => r.pause())
      ])
      await Promise.allSettled(activeCleanups.values())
      await harvestScheduler.waitForIdle()
    },
    resume: (): void => {
      if (stopRequested) return
      harvestAbortController = new AbortController()
      for (const r of runtimes) r.resume()
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
        await Promise.all([
          poller.start(),
          cancellationReaper?.start(),
          ...runtimes.map((r) => r.start())
        ])
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
        for (const unbind of unbindExternal) await attempt(unbind)
        await attempt(() => unbindHarvestRetry())
        await attempt(() => unbindDeletionRuntime?.())
        await attempt(() => deps.computeService.stopQueueReconciliation())
        await attempt(() => startTask)
        harvestAbortController.abort()
        await Promise.all([
          attempt(() => poller.stop()),
          attempt(() => cancellationReaper?.stop()),
          ...runtimes.map((r) => attempt(() => r.stop()))
        ])
        await Promise.allSettled(activeCleanups.values())
        await attempt(() => harvestScheduler.waitForIdle())
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, 'Compute runtime cleanup failed.')
      })()
      return stopTask
    }
  }
}

export type { ComputeJobRuntime, ComputeJobRuntimeAdapters, ComputeJobRuntimeDeps }
