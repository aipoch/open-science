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
  resume(): void
  pause(): Promise<void>
  stop(): Promise<void>
  tick(): Promise<void>
} {
  const repo = deps.jobRepository
  let controller: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let active: Promise<void> | undefined
  let stopped = false

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

  const cancelOne = async (signal: AbortSignal): Promise<void> => {
    const operations = deps.operationRepository
    if (!operations) return
    const claim = await operations.claimNext(
      'cancel',
      new Date(),
      120_000,
      randomUUID(),
      'kubernetes'
    )
    if (!claim) return
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
        return
      }
      if (await operations.fulfill(claim, new Date())) {
        const updated = await repo.get(job.job_id)
        if (updated) await deps.onJobUpdated(updated)
      }
    } catch {
      await operations.retry(claim, new Date(), new Date(Date.now() + 5000))
    }
  }
  const pass = async (signal: AbortSignal): Promise<void> => {
    await cancelOne(signal)
    for (const job of await repo.findKubernetesWork()) {
      signal.throwIfAborted()
      try {
        await reconcile(job, signal)
      } catch (error) {
        signal.throwIfAborted()
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
  }
  const tick = (): Promise<void> => {
    if (!controller) return Promise.resolve()
    return (active ??= pass(controller.signal)
      .catch(() => {
        if (!controller?.signal.aborted && controller)
          log.warn('Kubernetes job recovery pass failed.')
      })
      .finally(() => {
        active = undefined
      }))
  }
  const start = (): void => {
    if (stopped || controller) return
    controller = new AbortController()
    interval = setInterval(() => void tick(), 5000)
    interval.unref()
    void tick()
  }
  const pause = async (): Promise<void> => {
    clearInterval(interval)
    controller?.abort()
    controller = undefined
    await active
  }
  return {
    start,
    resume: start,
    pause,
    stop: async () => {
      stopped = true
      await pause()
    },
    tick
  }
}
