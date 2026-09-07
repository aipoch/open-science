import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { probeRemoteLaunch } from './remote-launch-recovery'
import { randomUUID } from 'node:crypto'

import {
  ComputeHostUnavailableError,
  type ComputeJob,
  type JobStatusResult
} from '../../shared/compute'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import {
  ComputeJobOperationRepository,
  type ClaimedComputeJobOperation,
  type ComputeJobOperationRecord,
  type ComputeJobOperationScope
} from './compute-job-operation-repository'
import { projectJobStatus } from './compute-job-status'
import type { ComputeJobRepository } from './job-repository'
import { parseRemoteJobHandle } from './remote-job-handle'
import {
  probeRemoteJobProcessOwnership,
  terminateRemoteJobProcessIfOwned
} from './remote-job-process'
import { cancelSlurmJob, recoverSlurmJob } from './slurm-driver'

type ReaperOptions = Readonly<{
  dispatchTracker?: Pick<DispatchTracker, 'has'>
  now?: () => Date
  leaseMs?: number
  retryDelayMs?: (attempt: number) => number
  makeLeaseToken?: () => string
  intervalMs?: number
  onConfirmed?: (jobId: string) => void | Promise<void>
}>

const cancellationStatus = (
  cancellation: ComputeJobOperationRecord | null
): JobStatusResult['cancellation_status'] =>
  cancellation?.phase === 'active'
    ? 'cancelling'
    : cancellation?.outcome === 'fulfilled'
      ? 'cancelled'
      : undefined

class ComputeJobCancellationOwner {
  constructor(
    private readonly operations: ComputeJobOperationRepository,
    private readonly jobs: Pick<ComputeJobRepository, 'get'>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async request(jobId: string, scope: ComputeJobOperationScope): Promise<JobStatusResult> {
    const result = await this.operations.request(jobId, 'cancel', scope, this.now())
    if (!result.found) throw new ComputeHostUnavailableError()
    const job = await this.requireOwnedJob(jobId, scope)
    return projectJobStatus(job, cancellationStatus(result.record))
  }

  async status(jobId: string, scope: ComputeJobOperationScope): Promise<JobStatusResult> {
    const job = await this.requireOwnedJob(jobId, scope)
    return projectJobStatus(job, cancellationStatus(await this.operations.get(jobId, 'cancel')))
  }

  private async requireOwnedJob(
    jobId: string,
    scope: ComputeJobOperationScope
  ): Promise<ComputeJob> {
    const job = await this.jobs.get(jobId)
    if (
      !job ||
      job.project_id !== scope.projectId ||
      job.session_id !== scope.sessionId ||
      job.provider_id !== scope.providerId
    ) {
      throw new ComputeHostUnavailableError()
    }
    return job
  }
}

class ComputeJobCancellationReaper {
  private readonly dispatchTracker: Pick<DispatchTracker, 'has'>
  private readonly now: () => Date
  private readonly leaseMs: number
  private readonly retryDelayMs: (attempt: number) => number
  private readonly makeLeaseToken: () => string
  private readonly intervalMs: number
  private readonly onConfirmed?: (jobId: string) => void | Promise<void>
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined
  private started = false
  private paused = false

  constructor(
    private readonly operations: ComputeJobOperationRepository,
    private readonly jobs: Pick<ComputeJobRepository, 'get' | 'recordCancellationHandle'>,
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    options: ReaperOptions = {}
  ) {
    this.dispatchTracker = options.dispatchTracker ?? sharedDispatchTracker
    this.now = options.now ?? (() => new Date())
    this.leaseMs = options.leaseMs ?? 30_000
    this.retryDelayMs =
      options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)))
    this.makeLeaseToken = options.makeLeaseToken ?? randomUUID
    this.intervalMs = options.intervalMs ?? 1_000
    this.onConfirmed = options.onConfirmed
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  async pause(): Promise<void> {
    this.paused = true
    await this.inFlight
  }

  resume(): void {
    this.paused = false
    if (this.started) void this.tick()
  }

  private schedule(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  private tick(): Promise<void> {
    if (!this.started || this.paused) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const work = this.runOnce().then(() => undefined)
    const tracked = work.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined
    })
    this.inFlight = tracked
    return this.inFlight
  }

  async runOnce(): Promise<boolean> {
    const claim = await this.operations.claimNext(
      'cancel',
      this.now(),
      this.leaseMs,
      this.makeLeaseToken()
    )
    if (!claim) return false
    await this.reap(claim)
    return true
  }

  private async reap(claim: ClaimedComputeJobOperation): Promise<void> {
    // The sidecar claim owns only the lease. Execution data is read through the ComputeJob
    // repository so encrypted handles/workdirs are revealed by the single persistence owner.
    const job = await this.jobs.get(claim.jobId)
    if (!job) return
    let handle = parseRemoteJobHandle(job.remote_handle, job.remote_workdir)

    try {
      if (!handle && this.dispatchTracker.has(job.job_id)) {
        await this.scheduleRetry(claim)
        return
      }
      const connection = await this.connectionBroker.acquire(job.provider_id, {
        intent: 'job_cleanup'
      })
      if (!handle && job.execution_mode === 'slurm') {
        handle = (await recoverSlurmJob(job, connection)) ?? null
        if (handle) await this.jobs.recordCancellationHandle(job.job_id, JSON.stringify(handle))
      }
      if (!handle && job.execution_mode !== 'slurm' && job.remote_workdir) {
        const observation = await probeRemoteLaunch(connection, job.remote_workdir)
        if (observation.kind === 'running') {
          handle = observation.handle
          await this.jobs.recordCancellationHandle(job.job_id, JSON.stringify(handle))
        } else if (
          observation.kind === 'not_started' ||
          observation.kind === 'exited' ||
          observation.kind === 'vanished'
        ) {
          await this.confirm(claim)
          return
        }
      }
      if (!handle) {
        await this.scheduleRetry(claim)
        return
      }
      if (handle.driver === 'slurm') {
        if (await cancelSlurmJob(handle, connection)) {
          await this.confirm(claim)
          return
        }
        await this.scheduleRetry(claim)
        return
      }
      const ownership = await probeRemoteJobProcessOwnership(handle.pid, handle.workdir, connection)
      if (ownership === 'mismatch' || ownership === 'absent') {
        await this.confirm(claim)
        return
      }
      if (ownership !== 'owned') {
        await this.scheduleRetry(claim)
        return
      }
      if (await terminateRemoteJobProcessIfOwned(handle.pid, handle.workdir, connection)) {
        await this.confirm(claim)
        return
      }
      await this.scheduleRetry(claim)
    } catch {
      await this.scheduleRetry(claim)
    }
  }

  private async scheduleRetry(claim: ClaimedComputeJobOperation): Promise<void> {
    const now = this.now()
    await this.operations.retry(
      claim,
      now,
      new Date(now.getTime() + this.retryDelayMs(claim.operation.attemptCount))
    )
  }

  private async confirm(claim: ClaimedComputeJobOperation): Promise<void> {
    if (await this.operations.fulfill(claim, this.now())) {
      await this.onConfirmed?.(claim.jobId)
    }
  }
}

export { ComputeJobCancellationOwner, ComputeJobCancellationReaper }
export type { ReaperOptions }
