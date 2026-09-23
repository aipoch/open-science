import { cancellationProjection, CANCELLATION_WINDOW_MS } from './cancellation-feedback'
import { ComputeConnectionError } from './connection-broker'
import { createLogger, errorLogFields } from '../logger'
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

const log = createLogger('compute-cancellation')

class CancellationAttemptError extends Error {
  constructor(readonly failureCode: string) {
    super(failureCode)
  }
}

type ReaperOptions = Readonly<{
  dispatchTracker?: Pick<DispatchTracker, 'has'>
  now?: () => Date
  leaseMs?: number
  retryDelayMs?: (attempt: number) => number
  makeLeaseToken?: () => string
  attemptTimeoutMs?: number
  intervalMs?: number
  onConfirmed?: (jobId: string) => void | Promise<void>
}>

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
    const status = {
      ...projectJobStatus(job, undefined),
      ...cancellationProjection(result.record, this.now().getTime())
    }
    log.info('Compute Job cancellation requested', {
      jobId,
      status: status.status,
      cancellationStatus: status.cancellation_status
    })
    return status
  }

  async status(jobId: string, scope: ComputeJobOperationScope): Promise<JobStatusResult> {
    const job = await this.requireOwnedJob(jobId, scope)
    return {
      ...projectJobStatus(job, undefined),
      ...cancellationProjection(await this.operations.get(jobId, 'cancel'), this.now().getTime())
    }
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
  private readonly attemptTimeoutMs: number
  private readonly attempts = new Set<Promise<unknown>>()
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
    this.attemptTimeoutMs = Math.min(options.attemptTimeoutMs ?? 25_000, this.leaseMs - 1)
    this.onConfirmed = options.onConfirmed
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule()
    this.tickInBackground()
  }

  async stop(): Promise<void> {
    this.started = false
    this.paused = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
    await Promise.allSettled([...this.attempts])
  }

  async pause(): Promise<void> {
    this.paused = true
    await this.inFlight
    await Promise.allSettled([...this.attempts])
  }

  resume(): void {
    this.paused = false
    if (this.started) this.tickInBackground()
  }

  private schedule(): void {
    this.timer = setInterval(() => this.tickInBackground(), this.intervalMs)
    this.timer.unref?.()
  }

  private tickInBackground(): void {
    void this.tick().catch((error) => {
      log.warn('background cancellation recovery failed', errorLogFields(error))
    })
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
    const work = this.runBounded(claim)
    this.attempts.add(work)
    try {
      await work
    } finally {
      this.attempts.delete(work)
    }
    return true
  }

  private async runBounded(claim: ClaimedComputeJobOperation): Promise<void> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.reap(claim, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort()
              reject(new ComputeConnectionError('timeout'))
            },
            Math.max(
              1,
              Math.min(
                this.attemptTimeoutMs,
                (claim.operation.requestedAt ?? claim.operation.createdAt ?? this.now()).getTime() +
                  CANCELLATION_WINDOW_MS -
                  this.now().getTime()
              )
            )
          )
        })
      ])
    } catch (error) {
      await this.scheduleRetry(
        claim,
        error instanceof CancellationAttemptError
          ? error.failureCode
          : error instanceof ComputeConnectionError
            ? error.code
            : 'unconfirmed'
      )
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }

  private async reap(claim: ClaimedComputeJobOperation, signal: AbortSignal): Promise<void> {
    // The sidecar claim owns only the lease. Execution data is read through the ComputeJob
    // repository so encrypted handles/workdirs are revealed by the single persistence owner.
    const job = await this.jobs.get(claim.jobId)
    if (!job) return
    let handle = parseRemoteJobHandle(job.remote_handle, job.remote_workdir)

    if (!handle && this.dispatchTracker.has(job.job_id)) {
      throw new CancellationAttemptError('unconfirmed')
    }
    const lease = await this.connectionBroker.acquire(job.provider_id, {
      intent: 'job_cleanup',
      signal
    })
    signal.throwIfAborted()
    const connection = {
      ...lease,
      run: (command: string, options: Parameters<typeof lease.run>[1]) => {
        signal.throwIfAborted()
        return lease.run(command, { ...options, signal })
      }
    }
    if (!handle && job.execution_mode === 'slurm') {
      handle = (await recoverSlurmJob(job, connection)) ?? null
      signal.throwIfAborted()
      if (handle) await this.jobs.recordCancellationHandle(job.job_id, JSON.stringify(handle))
    }
    if (!handle && job.execution_mode !== 'slurm' && job.remote_workdir) {
      const observation = await probeRemoteLaunch(connection, job.remote_workdir)
      signal.throwIfAborted()
      if (observation.kind === 'running') {
        handle = observation.handle
        await this.jobs.recordCancellationHandle(job.job_id, JSON.stringify(handle))
      } else if (
        observation.kind === 'not_started' ||
        observation.kind === 'exited' ||
        observation.kind === 'vanished'
      ) {
        await this.confirm(claim, observation.kind === 'not_started', signal)
        return
      }
    }
    if (!handle) {
      throw new CancellationAttemptError('unconfirmed')
    }
    if (handle.driver === 'slurm') {
      if (await cancelSlurmJob(handle, connection)) {
        await this.confirm(claim, false, signal)
        return
      }
      throw new CancellationAttemptError('unconfirmed')
    }
    const ownership = await probeRemoteJobProcessOwnership(
      handle.pid,
      handle.workdir,
      connection,
      handle.scope_version === 1
    )
    if (ownership === 'mismatch' || ownership === 'absent') {
      await this.confirm(claim, false, signal)
      return
    }
    if (ownership !== 'owned') {
      throw new CancellationAttemptError('ownership_unconfirmed')
    }
    if (
      await terminateRemoteJobProcessIfOwned(
        handle.pid,
        handle.workdir,
        connection,
        handle.scope_version === 1
      )
    ) {
      await this.confirm(claim, false, signal)
      return
    }
    throw new CancellationAttemptError('termination_unconfirmed')
  }

  private async scheduleRetry(
    claim: ClaimedComputeJobOperation,
    failureCode = 'unconfirmed'
  ): Promise<void> {
    const now = this.now()
    const retried = await this.operations.retry(
      claim,
      now,
      new Date(now.getTime() + this.retryDelayMs(claim.operation.attemptCount)),
      failureCode
    )
    if (retried)
      log.warn('Compute Job cancellation unconfirmed; retry scheduled', {
        jobId: claim.jobId,
        attempt: claim.operation.attemptCount,
        reason: failureCode
      })
  }

  private async confirm(
    claim: ClaimedComputeJobOperation,
    remoteWorkdirAbsent = false,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    if (await this.operations.fulfill(claim, this.now(), remoteWorkdirAbsent)) {
      log.info('Compute Job cancellation confirmed', {
        jobId: claim.jobId,
        attempt: claim.operation.attemptCount
      })
      void Promise.resolve()
        .then(() => this.onConfirmed?.(claim.jobId))
        .catch((error) => {
          log.warn('Cancellation result delivery failed', errorLogFields(error))
        })
    }
  }
}

export { ComputeJobCancellationOwner, ComputeJobCancellationReaper }
export type { ReaperOptions }
