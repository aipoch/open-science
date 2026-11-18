import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ComputeJob } from '../../shared/compute'
import { createKubernetesBackendAdapter, type ComputeConnectionLease } from '@aipoch/compute/node'
import type { ComputeBackendHandle, ComputeBackendSubmissionRequest } from '@aipoch/compute'
import { createLogger } from '@aipoch/diagnostics/node'
import { decodeDataPath } from '../storage/data-path'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ComputeJobRepository } from './job-repository'
import { uploadKubernetesJobInputs, withKubernetesArchiveConnection } from './kubernetes-job-files'
import type { WorkspaceOwner } from './kubernetes-job-workspace'
import { createComputeRuntimeLoop, type ComputeRuntimePassResult } from './compute-runtime-loop'
import {
  nextComputeRuntimeBackoff,
  nextComputeRuntimeWakeAfter,
  type ComputeRuntimeBackoffState
} from './compute-runtime-backoff'

const log = createLogger('compute:kubernetes')
class KubernetesLaunchUncertainError extends Error {
  constructor() {
    super(
      'A Kubernetes launch was requested, but its Job could not be found. Check the cluster before submitting another job.'
    )
  }
}
const frozenInputs = z.array(
  z.object({
    kind: z.literal('upload'),
    dstFilename: z.string(),
    localPath: z.string().startsWith('$DATA/'),
    checksum: z.string().regex(/^[\da-f]{64}$/),
    sizeBytes: z.number().int().nonnegative()
  })
)

const ownerOf = (job: ComputeJob): WorkspaceOwner => ({
  jobId: job.job_id,
  sessionId: job.session_id,
  projectId: job.project_id,
  providerId: job.provider_id
})
const savedHandle = (job: ComputeJob): ComputeBackendHandle | undefined =>
  job.remote_handle
    ? { backendId: 'kubernetes', providerId: job.provider_id, value: job.remote_handle }
    : undefined

type Dependencies = {
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  storageRoot: string
  onJobUpdated(job: ComputeJob): void | Promise<void>
  harvest(job: ComputeJob, connection: ComputeConnectionLease, signal: AbortSignal): Promise<void>
}
export function createKubernetesJobRuntime(deps: Dependencies): {
  start(): void
  wake(): Promise<void>
  resume(): void
  pause(): Promise<void>
  stop(): Promise<void>
  tick(): Promise<void>
  retry(jobId: string): Promise<void>
} {
  const repo = deps.jobRepository

  const reconcile = async (job: ComputeJob, signal: AbortSignal): Promise<void> => {
    if (
      job.harvested_at &&
      (job.harvest_error || job.left_on_remote !== '[]' || !job.file_evidence?.checksum)
    )
      return
    const owner = ownerOf(job)
    const { target, binding } = await repo.getKubernetesReservation(owner, signal)
    const adapter = createKubernetesBackendAdapter(target)
    const workspace = binding.receipt ?? (await repo.prepareKubernetesWorkspace(owner, signal))
    let handle = savedHandle(job)
    if (job.status === 'submitted' || job.status === 'running') {
      if (!handle) {
        if (binding.launchToken) {
          handle =
            (await adapter.recoverWorkspaceLaunch(workspace, binding.launchToken, signal)) ??
            undefined
          if (!handle) throw new KubernetesLaunchUncertainError()
        } else {
          if (!binding.transferImage)
            throw new Error('A trusted Kubernetes transfer image was not approved.')
          const entries = frozenInputs.parse(JSON.parse(job.input_manifest ?? '[]'))
          if (entries.length)
            await uploadKubernetesJobInputs(
              target,
              workspace,
              binding.transferImage,
              entries.map((input) => ({
                ...input,
                frozenPath: decodeDataPath(input.localPath, deps.storageRoot)!
              })),
              signal
            )
          const token = await repo.claimKubernetesLaunch(owner)
          if (!token) return
          const submission: ComputeBackendSubmissionRequest = {
            target: { providerId: job.provider_id, backendId: 'kubernetes' },
            jobId: job.job_id,
            command: job.command,
            timeoutSeconds: job.timeout_seconds,
            resourceRequest: job.resource_request,
            environment: job.environment
          }
          handle = await adapter.submitInWorkspace(submission, workspace, signal, token)
        }
        // A concurrent cancellation may fence status updates; keep the UID discoverable by the canceller.
        const linked = await repo.updateIfStatus(job.job_id, [job.status], {
          remoteHandle: handle.value,
          lastPollError: null
        })
        if (!linked) {
          await repo.recordCancellationHandle(job.job_id, handle.value)
          return
        }
        await deps.onJobUpdated(linked)
      }
      const observed = await adapter.observe(handle, signal)
      if (observed.contact !== 'live' || observed.phase === 'lost')
        throw new Error('Kubernetes Job identity or status is unavailable.')
      const terminal = observed.phase === 'succeeded' || observed.phase === 'failed'
      if (!terminal && observed.phase !== 'running') return
      const logs = await adapter.collectLogs(handle, undefined, signal).catch(() => undefined)
      signal.throwIfAborted()
      const status =
        observed.phase === 'succeeded'
          ? 'success'
          : observed.phase === 'failed'
            ? observed.message === 'DeadlineExceeded'
              ? 'timeout'
              : 'failed'
            : 'running'
      const stdout = logs?.stdout.slice(-64 * 1024)
      if (
        job.status === status &&
        !job.last_poll_error &&
        (stdout === undefined || stdout === job.stdout_tail)
      )
        return
      const updated = await repo.updateIfStatus(job.job_id, [job.status], {
        status,
        lastPollError: null,
        ...(stdout !== undefined && { stdoutTail: stdout }),
        ...(status === 'running' && !job.started_at && { startedAt: new Date() }),
        ...(terminal && {
          finishedAt: new Date(),
          exitCode: observed.exitCode,
          errorCode: status === 'timeout' ? 'timeout' : status === 'failed' ? 'job_failed' : null
        })
      })
      if (updated) await deps.onJobUpdated(updated)
      return
    }
    if (!job.harvested_at) {
      if (!binding.transferImage)
        throw new Error('A trusted Kubernetes transfer image was not approved.')
      await withKubernetesArchiveConnection(
        target,
        workspace,
        binding.transferImage,
        (lease) => deps.harvest(job, lease, signal),
        signal
      )
      return
    }
    if (handle && (await adapter.cleanup(handle, signal)).outcome !== 'cleaned') return
    if ((await repo.releasePublishedKubernetesWorkspace(owner, signal)) === 'confirmed') {
      const cleaned = await repo.get(job.job_id)
      if (cleaned) await deps.onJobUpdated(cleaned)
    }
  }

  const cancelOne = async (signal: AbortSignal): Promise<boolean> => {
    const operations = deps.operationRepository
    if (!operations) return false
    const claim = await operations.claimNext(
      'cancel',
      new Date(),
      120_000,
      randomUUID(),
      'kubernetes'
    )
    if (!claim) return false
    try {
      const job = await repo.get(claim.jobId)
      if (!job || job.execution_mode !== 'kubernetes')
        throw new Error('Kubernetes cancellation job is unavailable.')
      const owner = ownerOf(job)
      const { binding, target } = await repo.getKubernetesReservation(owner, signal)
      const workspace = binding.receipt ?? (await repo.prepareKubernetesWorkspace(owner, signal))
      const adapter = createKubernetesBackendAdapter(target)
      let handle = savedHandle(job)
      if (!handle && binding.launchToken) {
        handle =
          (await adapter.recoverWorkspaceLaunch(workspace, binding.launchToken, signal)) ??
          undefined
        if (!handle) throw new Error('Cannot reconcile launched Job for cancellation.')
        await repo.recordCancellationHandle(job.job_id, handle.value)
      }
      if (handle && (await adapter.cancel(handle, signal)).outcome !== 'confirmed') {
        await operations.retry(claim, new Date(), new Date(Date.now() + 5000))
        return true
      }
      if (await operations.fulfill(claim, new Date())) {
        const updated = await repo.get(job.job_id)
        if (updated) await deps.onJobUpdated(updated)
      }
    } catch {
      await operations.retry(claim, new Date(), new Date(Date.now() + 5000))
      return true
    }
    return true
  }
  const failures = new Map<string, ComputeRuntimeBackoffState>()
  const keepsActiveCadence = (job: ComputeJob): boolean =>
    job.status === 'submitted' || job.status === 'running' || !job.harvested_at
  const pass = async (signal: AbortSignal): Promise<ComputeRuntimePassResult> => {
    const cancelled = await cancelOne(signal)
    const jobs = await repo.findKubernetesWork()
    const ids = new Set(jobs.map((job) => job.job_id))
    for (const id of failures.keys()) if (!ids.has(id)) failures.delete(id)
    let ready = false
    for (const job of jobs) {
      signal.throwIfAborted()
      const previous = failures.get(job.job_id)
      if (previous && previous.retryAt > Date.now()) continue
      try {
        await reconcile(job, signal)
        failures.delete(job.job_id)
        ready ||= keepsActiveCadence(job)
      } catch (error) {
        signal.throwIfAborted()
        failures.set(job.job_id, nextComputeRuntimeBackoff(previous, Date.now()))
        const message =
          error instanceof KubernetesLaunchUncertainError
            ? error.message
            : 'Kubernetes job recovery is pending. Check the approved target and its remote resources.'
        if (job.last_poll_error !== message) {
          const updated = await repo.updateIfStatus(job.job_id, [job.status], {
            lastPollError: message
          })
          if (updated) await deps.onJobUpdated(updated)
        }
      }
    }
    const nextWakeAfterMs = nextComputeRuntimeWakeAfter(failures.values(), Date.now())
    return {
      hasWork: cancelled || ready,
      ...(nextWakeAfterMs === undefined ? {} : { nextWakeAfterMs })
    }
  }
  const loop = createComputeRuntimeLoop({
    run: pass,
    activeIntervalMs: 5000,
    onError: () => log.warn('Kubernetes job recovery pass failed.')
  })
  return {
    ...loop,
    retry: async (jobId: string) => {
      await loop.wake(() => failures.delete(jobId))
    }
  }
}
