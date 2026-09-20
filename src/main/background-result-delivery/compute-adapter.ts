import type {
  AgentResultFollowUpDelivery,
  BackgroundResultSourceRef
} from '../../shared/background-result-delivery'
import type { JobSummary } from '../../shared/compute'

const isNonTerminal = (job: JobSummary): boolean =>
  job.status === 'queued' || job.status === 'submitted' || job.status === 'running'

const computeJobSourceRef = (job: JobSummary): BackgroundResultSourceRef => {
  if (!job.project_id) throw new Error(`Compute Job ${job.job_id} has no Project scope.`)
  return {
    sourceKind: 'compute-job',
    sourceId: job.job_id,
    projectId: job.project_id,
    sessionId: job.session_id
  }
}

type ComputeJobResultDeliveryAdapterDeps = Readonly<{
  register(source: BackgroundResultSourceRef): Promise<unknown>
  enqueue(source: BackgroundResultSourceRef): Promise<unknown>
  acknowledgeObserved(source: BackgroundResultSourceRef): Promise<AgentResultFollowUpDelivery>
  listWaiting(): Promise<readonly BackgroundResultSourceRef[]>
  hasDeliveryPath(sourceKind: 'compute-job', sourceId: string): Promise<boolean>
}>

class ComputeJobResultDeliveryAdapter {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: ComputeJobResultDeliveryAdapterDeps) {}

  private serialize(jobId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(jobId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.chains.set(jobId, next)
    const cleanup = (): void => {
      if (this.chains.get(jobId) === next) this.chains.delete(jobId)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  observeJob(job: JobSummary): Promise<void> {
    if (!isNonTerminal(job)) return Promise.resolve()
    return this.serialize(job.job_id, async () => {
      await this.deps.register(computeJobSourceRef(job))
    })
  }

  observeNotification(job: JobSummary): Promise<void> {
    if (isNonTerminal(job) || job.notified_at === undefined) return Promise.resolve()
    return this.serialize(job.job_id, async () => {
      await this.deps.enqueue(computeJobSourceRef(job))
    })
  }

  observeResult(job: JobSummary): Promise<AgentResultFollowUpDelivery> {
    if (isNonTerminal(job) || (job.status !== 'error' && job.harvested_at === undefined)) {
      return Promise.resolve('pending')
    }
    let disposition: AgentResultFollowUpDelivery = 'pending'
    return this.serialize(job.job_id, async () => {
      disposition = await this.deps.acknowledgeObserved(computeJobSourceRef(job))
    }).then(() => disposition)
  }

  async takeOver(jobs: readonly JobSummary[]): Promise<void> {
    await Promise.all(jobs.filter(isNonTerminal).map((job) => this.observeJob(job)))
  }

  async recoverWaiting(loadJob: (jobId: string) => Promise<JobSummary | undefined>): Promise<void> {
    for (const source of await this.deps.listWaiting()) {
      const job = await loadJob(source.sourceId)
      if (job) await this.observeNotification(job)
    }
  }

  hasDeliveryPath(jobId: string): Promise<boolean> {
    return this.deps.hasDeliveryPath('compute-job', jobId)
  }
}

export { ComputeJobResultDeliveryAdapter, computeJobSourceRef, isNonTerminal }
export type { ComputeJobResultDeliveryAdapterDeps }
