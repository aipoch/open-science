import type { ComputeJob } from '../../shared/compute'
import { ComputeConnectionError } from './connection-broker'

const HARVEST_CONCURRENCY_LIMIT = 2
const HARVEST_RETRY_BASE_MS = 60_000
const HARVEST_RETRY_MAX_MS = 15 * 60_000

/** A recoverable harvest failure whose message is safe to persist and display. */
export class RetryableHarvestError extends Error {}

export type HarvestFn = (job: ComputeJob, signal?: AbortSignal) => Promise<void>

/**
 * Owns harvest concurrency, in-flight de-duplication and retry backoff. The poller only needs to
 * schedule terminal jobs and wait for the scheduler to drain when its runtime is paused.
 */
export class JobHarvestScheduler {
  private readonly inFlightJobs = new Map<string, Promise<void>>()
  private readonly retries = new Map<string, { attempts: number; retryAt: number }>()
  private readonly queue: Array<{ job: ComputeJob; signal?: AbortSignal; complete: () => void }> =
    []
  private availableSlots = HARVEST_CONCURRENCY_LIMIT

  constructor(
    private readonly harvest: HarvestFn,
    private readonly now: () => number = Date.now
  ) {}

  schedule(job: ComputeJob, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    const existing = this.inFlightJobs.get(job.job_id)
    if (existing) return existing
    const retry = this.retries.get(job.job_id)
    if (retry && retry.retryAt > this.now()) return Promise.resolve()

    let complete!: () => void
    const task = new Promise<void>((resolve) => {
      complete = resolve
    })
    this.inFlightJobs.set(job.job_id, task)
    if (this.availableSlots > 0) this.run(job, signal, complete)
    else this.queue.push({ job, signal, complete })
    return task
  }

  retry(job: ComputeJob, signal?: AbortSignal): Promise<void> {
    this.retries.delete(job.job_id)
    return this.schedule(job, signal)
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlightJobs.size > 0) {
      await Promise.all([...this.inFlightJobs.values()])
    }
  }

  private run(job: ComputeJob, signal: AbortSignal | undefined, complete: () => void): void {
    if (signal?.aborted) {
      this.inFlightJobs.delete(job.job_id)
      complete()
      return
    }
    this.availableSlots--
    let retryableFailure = false
    void Promise.resolve()
      .then(() => this.harvest(job, signal))
      .catch((error) => {
        if (!(error instanceof ComputeConnectionError) && !(error instanceof RetryableHarvestError))
          return
        retryableFailure = true
        const attempts = (this.retries.get(job.job_id)?.attempts ?? 0) + 1
        const delay = Math.min(HARVEST_RETRY_BASE_MS * 2 ** (attempts - 1), HARVEST_RETRY_MAX_MS)
        this.retries.set(job.job_id, { attempts, retryAt: this.now() + delay })
      })
      .finally(() => {
        if (!retryableFailure) this.retries.delete(job.job_id)
        this.inFlightJobs.delete(job.job_id)
        complete()
        this.availableSlots++
        let next = this.queue.shift()
        while (next?.signal?.aborted) {
          this.inFlightJobs.delete(next.job.job_id)
          next.complete()
          next = this.queue.shift()
        }
        if (next) this.run(next.job, next.signal, next.complete)
      })
  }
}
