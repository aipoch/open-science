import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'

export type ComputeJobTransitionResult = { kind: 'applied'; job: ComputeJob } | { kind: 'ignored' }

export class ComputeJobLifecycle {
  constructor(
    private readonly repository: ComputeJobRepository,
    private readonly onApplied: (job: ComputeJob) => void = () => undefined
  ) {}

  async promoteQueued(jobId: string): Promise<ComputeJobTransitionResult> {
    const job = await this.repository.updateIfStatus(jobId, ['queued'], {
      status: 'submitted',
      submittedAt: new Date()
    })
    if (!job) return { kind: 'ignored' }

    try {
      this.onApplied(job)
    } catch {
      // The persisted transition is authoritative; an observer cannot roll it back or block dispatch.
    }
    return { kind: 'applied', job }
  }
}
