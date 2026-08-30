import type { ComputeJob, ComputeJobStatus } from '../../shared/compute'
import type { ComputeJobOwner, ComputeJobRepository, UpdateJobRequest } from './job-repository'

export type ComputeJobTransitionResult = { kind: 'applied'; job: ComputeJob } | { kind: 'ignored' }

type ActiveJobStatus = Extract<ComputeJobStatus, 'submitted' | 'running'>
type PollTails = { stdoutTail: string | null; stderrTail: string | null }
type PolledJobFinish = PollTails & {
  status: Extract<ComputeJobStatus, 'success' | 'failed' | 'timeout'>
  exitCode?: number
  errorCode: string | null
}

export class ComputeJobLifecycle {
  constructor(
    private readonly repository: ComputeJobRepository,
    private readonly onApplied: (job: ComputeJob) => void = () => undefined
  ) {}

  beginOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    return this.repository.beginOwnerDeletion(owner)
  }

  deleteOwnerRows(owner: ComputeJobOwner): Promise<void> {
    return this.repository.deleteByOwner(owner)
  }

  abortOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    return this.repository.abortOwnerDeletion(owner)
  }

  async promoteQueued(jobId: string): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['queued'], {
      status: 'submitted',
      submittedAt: new Date()
    })
  }

  async dispatchRunning(
    jobId: string,
    remoteHandle: string,
    startedAt = new Date(),
    remoteWorkdir?: string
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['submitted'], {
      status: 'running',
      remoteHandle,
      startedAt,
      ...(remoteWorkdir === undefined ? {} : { remoteWorkdir })
    })
  }

  async recoverRemoteHandle(
    jobId: string,
    observedStatus: ActiveJobStatus,
    remoteHandle: string,
    startedAt = new Date()
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, [observedStatus], {
      ...(observedStatus === 'submitted' ? { status: 'running' as const, startedAt } : {}),
      remoteHandle,
      lastPollError: null,
      retryAfterUserAction: false
    })
  }

  async dispatchError(
    jobId: string,
    failure: { errorCode: string; stderrTail?: string }
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['submitted'], {
      status: 'error',
      errorCode: failure.errorCode,
      ...(failure.stderrTail === undefined ? {} : { stderrTail: failure.stderrTail }),
      finishedAt: new Date()
    })
  }

  async recoverInterruptedDispatch(jobId: string): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['submitted'], {
      status: 'error',
      errorCode: 'dispatch_failed',
      stderrTail: 'dispatch interrupted by restart',
      finishedAt: new Date()
    })
  }

  async failRemoteHandleRecovery(
    jobId: string,
    observedStatus: ActiveJobStatus,
    diagnostic: string
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, [observedStatus], {
      status: 'error',
      errorCode: 'dispatch_failed',
      lastPollError: diagnostic,
      retryAfterUserAction: false,
      finishedAt: new Date()
    })
  }

  async finishPolled(jobId: string, result: PolledJobFinish): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['submitted', 'running'], {
      status: result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      errorCode: result.errorCode,
      lastPollError: null,
      retryAfterUserAction: false,
      finishedAt: new Date()
    })
  }

  async observeRunning(
    jobId: string,
    observedStatus: ActiveJobStatus,
    tails: PollTails
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, [observedStatus], {
      ...(observedStatus === 'submitted' ? { status: 'running' as const } : {}),
      ...tails,
      lastPollError: null
    })
  }

  async recordPollError(
    jobId: string,
    observedStatus: ActiveJobStatus,
    message: string,
    retryAfterUserAction = true
  ): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, [observedStatus], {
      lastPollError: message,
      retryAfterUserAction
    })
  }

  private async apply(
    jobId: string,
    expectedStatuses: readonly ComputeJobStatus[],
    updates: UpdateJobRequest
  ): Promise<ComputeJobTransitionResult> {
    const job = await this.repository.updateIfStatus(jobId, expectedStatuses, updates)
    if (!job) return { kind: 'ignored' }
    try {
      this.onApplied(job)
    } catch {
      // The persisted transition is authoritative; an observer cannot roll it back or block dispatch.
    }
    return { kind: 'applied', job }
  }
}
