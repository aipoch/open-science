import type { ComputeJob, ComputeJobStatus } from '../../shared/compute'
import type { ComputeJobRepository, UpdateJobRequest } from './job-repository'

export type ComputeJobTransitionResult = { kind: 'applied'; job: ComputeJob } | { kind: 'ignored' }

export class ComputeJobLifecycle {
  constructor(
    private readonly repository: ComputeJobRepository,
    private readonly onApplied: (job: ComputeJob) => void = () => undefined
  ) {}

  async promoteQueued(jobId: string): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['queued'], {
      status: 'submitted',
      submittedAt: new Date()
    })
  }

  async dispatchRunning(jobId: string, remoteHandle: string): Promise<ComputeJobTransitionResult> {
    return this.apply(jobId, ['submitted'], {
      status: 'running',
      remoteHandle,
      startedAt: new Date()
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
