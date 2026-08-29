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
import type { ComputeJobRepository } from './job-repository'
import { parseRemoteJobHandle } from './remote-job-handle'
import {
  probeRemoteJobProcessOwnership,
  terminateRemoteJobProcessIfOwned
} from './remote-job-process'

type ReaperOptions = Readonly<{
  now?: () => Date
  leaseMs?: number
  retryDelayMs?: (attempt: number) => number
  makeLeaseToken?: () => string
  intervalMs?: number
  onConfirmed?: (jobId: string) => void | Promise<void>
}>

const toStatus = (
  job: ComputeJob,
  cancellation: ComputeJobOperationRecord | null
): JobStatusResult => ({
  job_id: job.job_id,
  status: job.status,
  cancellation_status:
    cancellation?.phase === 'active'
      ? 'cancelling'
      : cancellation?.outcome === 'fulfilled'
        ? 'cancelled'
        : undefined,
  exit_code: job.exit_code,
  stdout_tail: job.stdout_tail,
  stderr_tail: job.stderr_tail,
  remote_workdir: job.remote_workdir,
  harvest_error: job.harvest_error
})

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
    return toStatus(job, result.record)
  }

  async status(jobId: string, scope: ComputeJobOperationScope): Promise<JobStatusResult> {
    const job = await this.requireOwnedJob(jobId, scope)
    return toStatus(job, await this.operations.get(jobId, 'cancel'))
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
    private readonly jobs: Pick<ComputeJobRepository, 'get'>,
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    options: ReaperOptions = {}
  ) {
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
    const handle = parseRemoteJobHandle(job.remote_handle, job.remote_workdir)
    if (!handle) {
      await this.scheduleRetry(claim, 'Remote process ownership evidence is unavailable.')
      return
    }

    try {
      const connection = await this.connectionBroker.acquire(job.provider_id, {
        intent: 'job_cleanup'
      })
      const ownership = await probeRemoteJobProcessOwnership(handle.pid, handle.workdir, connection)
      if (ownership === 'mismatch' || ownership === 'absent') {
        await this.confirm(claim)
        return
      }
      if (ownership !== 'owned') {
        await this.scheduleRetry(claim, 'Remote process ownership could not be confirmed.')
        return
      }
      if (await terminateRemoteJobProcessIfOwned(handle.pid, handle.workdir, connection)) {
        await this.confirm(claim)
        return
      }
      await this.scheduleRetry(claim, 'Owned remote process termination was not confirmed.')
    } catch (error) {
      await this.scheduleRetry(
        claim,
        error instanceof Error ? error.message : 'Remote cancellation failed.'
      )
    }
  }

  private async scheduleRetry(claim: ClaimedComputeJobOperation, _error: string): Promise<void> {
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
