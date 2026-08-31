import type { ComputeJob } from '../../shared/compute'
import { ComputeConnectionError } from './connection-broker'

const HARVEST_CONCURRENCY_LIMIT = 2
const HARVEST_RETRY_BASE_MS = 60_000
const HARVEST_RETRY_MAX_MS = 15 * 60_000

export type HarvestFn = (job: ComputeJob, signal?: AbortSignal) => Promise<void>

/**
 * Owns harvest concurrency, in-flight de-duplication and retry backoff. The poller only needs to
 * schedule terminal jobs and wait for the scheduler to drain when its runtime is paused.
 */
export class JobHarvestScheduler {
  private readonly inFlightJobs = new Set<string>()
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly retries = new Map<string, { attempts: number; retryAt: number }>()
  private readonly queue: Array<{ job: ComputeJob; signal?: AbortSignal }> = []
  private availableSlots = HARVEST_CONCURRENCY_LIMIT

  constructor(
    private readonly harvest: HarvestFn,
    private readonly now: () => number = Date.now
  ) {}

  schedule(job: ComputeJob, signal?: AbortSignal): void {
    if (signal?.aborted) return
    const retry = this.retries.get(job.job_id)
    if (retry && retry.retryAt > this.now()) return
    if (this.inFlightJobs.has(job.job_id)) return

    this.inFlightJobs.add(job.job_id)
    if (this.availableSlots > 0) this.run(job, signal)
    else this.queue.push({ job, signal })
  }

  async waitForIdle(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks])
    }
  }

  private run(job: ComputeJob, signal?: AbortSignal): void {
    if (signal?.aborted) {
      this.inFlightJobs.delete(job.job_id)
      return
    }
    this.availableSlots--
    let retryableFailure = false
    const task = this.harvest(job, signal)
      .catch((error) => {
        if (!(error instanceof ComputeConnectionError)) return
        retryableFailure = true
        const attempts = (this.retries.get(job.job_id)?.attempts ?? 0) + 1
        const delay = Math.min(HARVEST_RETRY_BASE_MS * 2 ** (attempts - 1), HARVEST_RETRY_MAX_MS)
        this.retries.set(job.job_id, { attempts, retryAt: this.now() + delay })
      })
      .finally(() => {
        if (!retryableFailure) this.retries.delete(job.job_id)
        this.inFlightJobs.delete(job.job_id)
        this.availableSlots++
        let next = this.queue.shift()
        while (next?.signal?.aborted) {
          this.inFlightJobs.delete(next.job.job_id)
          next = this.queue.shift()
        }
        if (next) this.run(next.job, next.signal)
      })

    this.activeTasks.add(task)
    void task.then(
      () => this.activeTasks.delete(task),
      () => this.activeTasks.delete(task)
    )
  }
}
