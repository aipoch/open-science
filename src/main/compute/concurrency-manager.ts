import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

export type SessionStatus = {
  session_limit: number | null
  active_count: number
  queued_count: number
  provider_ceilings: Record<string, number>
}

// Default provider ceiling when ComputeHost.concurrencyLimit is null/undefined.
const DEFAULT_PROVIDER_CEILING = 10

// Global queue limit (max queued jobs across all sessions).
const GLOBAL_QUEUE_LIMIT = 100

// Enforces session-level and provider-level concurrency limits for compute jobs.
// Stores session limits in memory, decides whether jobs should queue or dispatch,
// and automatically dispatches queued jobs when slots become available.
export class ConcurrencyManager {
  // In-memory storage of session limits: sessionId -> limit
  private sessionLimits: Map<string, number> = new Map()

  // Flag to prevent concurrent execution of tryDispatchNext
  private dispatching: boolean = false

  // In-process serialization lock for admit(). The decision (read counts → pick status) and the
  // job-row commit must be atomic: without this, two concurrent submitJob calls could both read the
  // same active count, both decide 'submitted', and overrun a provider ceiling or session limit.
  // JS is single-threaded, so chaining commit work onto this promise fully serializes the critical
  // section — the row written by one admit is visible to the DB counts read by the next.
  private admitLock: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly jobRepository: ComputeJobRepository,
    private readonly hostRepository: ComputeHostRepository,
    private readonly dispatchJob: (jobId: string) => Promise<void>
  ) {}

  // Set session-level concurrency limit (stored in memory, not persisted).
  setSessionLimit(sessionId: string, limit: number): void {
    this.sessionLimits.set(sessionId, limit)
  }

  // Runs `fn` while holding the admit lock, serializing it against every other runExclusive call.
  // The lock is advanced regardless of whether `fn` resolves or rejects so one failure can't wedge
  // the chain.
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.admitLock.then(fn, fn)
    this.admitLock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Returns true when a new active job for this (session, provider) would exceed the session limit
  // or the provider ceiling — i.e. the job should be queued rather than dispatched immediately.
  // Only active jobs (submitted + running) count; queued jobs do not occupy a slot.
  private async overActiveLimits(sessionId: string, providerId: string): Promise<boolean> {
    const sessionLimit = this.sessionLimits.get(sessionId)
    if (sessionLimit !== undefined) {
      const activeInSession = await this.jobRepository.countActiveBySession(sessionId)
      if (activeInSession >= sessionLimit) return true
    }

    const host = await this.hostRepository.get(providerId)
    const providerCeiling = host?.concurrencyLimit ?? DEFAULT_PROVIDER_CEILING
    const activeOnProvider = await this.jobRepository.countActiveByProvider(providerId)
    return activeOnProvider >= providerCeiling
  }

  // Atomically decides the initial status and commits the job row inside one critical section.
  // `commit` MUST perform the DB row create with the passed status; its write becomes visible to
  // the counts read by the next admit before the lock releases, so concurrent callers cannot both
  // pass the same slot. Returns the committed status, or 'queue_full' WITHOUT committing when the
  // global queue is at capacity (the caller must not create a row in that case).
  async admit(
    params: { sessionId: string; providerId: string },
    commit: (status: 'submitted' | 'queued') => Promise<void>
  ): Promise<'submitted' | 'queued' | 'queue_full'> {
    return this.runExclusive(async () => {
      const globalQueuedCount = await this.jobRepository.countQueuedJobs()
      if (globalQueuedCount >= GLOBAL_QUEUE_LIMIT) return 'queue_full'

      const status: 'submitted' | 'queued' = (await this.overActiveLimits(
        params.sessionId,
        params.providerId
      ))
        ? 'queued'
        : 'submitted'

      await commit(status)
      return status
    })
  }

  // Check limits and decide: dispatch now, queue, or reject (queue full).
  // Returns:
  // - 'queue_full': global queue at capacity (100 jobs)
  // - 'should_queue': either session limit or provider ceiling reached
  // - 'can_dispatch': both limits allow, job can be dispatched immediately
  async enqueue(params: {
    jobId: string
    sessionId: string
    providerId: string
  }): Promise<'can_dispatch' | 'should_queue' | 'queue_full'> {
    const { sessionId, providerId } = params

    // 1. Check global queue limit
    const globalQueuedCount = await this.jobRepository.countQueuedJobs()
    if (globalQueuedCount >= GLOBAL_QUEUE_LIMIT) {
      return 'queue_full'
    }

    // 2. Check session limit + provider ceiling (only active jobs count, not queued).
    if (await this.overActiveLimits(sessionId, providerId)) {
      return 'should_queue'
    }

    return 'can_dispatch'
  }

  // Called when a job reaches a terminal state. Attempts to dispatch the next eligible queued job.
  async onJobCompleted(): Promise<void> {
    await this.tryDispatchNext()
  }

  // Query session status (active/queued counts, limits, provider ceilings).
  async getStatus(sessionId: string): Promise<SessionStatus> {
    const sessionLimit = this.sessionLimits.get(sessionId) ?? null
    const activeCount = await this.jobRepository.countActiveBySession(sessionId)

    // Find all jobs for this session to compute queued count and provider ceilings
    const allJobs = await this.jobRepository.findBySession(sessionId)
    const queuedJobs = allJobs.filter((job) => job.status === 'queued')
    const queuedCount = queuedJobs.length

    // Collect unique providers and their ceilings
    const providerIds = new Set<string>(allJobs.map((job) => job.provider_id))
    const providerCeilings: Record<string, number> = {}

    for (const providerId of providerIds) {
      const host = await this.hostRepository.get(providerId)
      providerCeilings[providerId] = host?.concurrencyLimit ?? DEFAULT_PROVIDER_CEILING
    }

    return {
      session_limit: sessionLimit,
      active_count: activeCount,
      queued_count: queuedCount,
      provider_ceilings: providerCeilings
    }
  }

  // Internal: attempt to dispatch the next eligible queued job(s).
  // Processes queued jobs in FIFO order (createdAt ASC) and dispatches any that satisfy both limits.
  private async tryDispatchNext(): Promise<void> {
    // Prevent concurrent execution - if already dispatching, return immediately
    if (this.dispatching) {
      return
    }

    this.dispatching = true
    try {
      const queuedJobs = await this.jobRepository.findQueuedJobs()

      for (const job of queuedJobs) {
        // Re-check session limit for this job's session - only count active jobs
        const sessionLimit = this.sessionLimits.get(job.session_id)
        let sessionLimitOk = true
        if (sessionLimit !== undefined) {
          const activeInSession = await this.jobRepository.countActiveBySession(job.session_id)
          sessionLimitOk = activeInSession < sessionLimit
        }

        // Re-check provider ceiling for this job's provider - only count active jobs
        const host = await this.hostRepository.get(job.provider_id)
        const providerCeiling = host?.concurrencyLimit ?? DEFAULT_PROVIDER_CEILING
        const activeOnProvider = await this.jobRepository.countActiveByProvider(job.provider_id)
        const providerCeilingOk = activeOnProvider < providerCeiling

        // Dispatch if both limits allow
        if (sessionLimitOk && providerCeilingOk) {
          try {
            await this.jobRepository.update(job.job_id, { status: 'submitted' })
            await this.dispatchJob(job.job_id)
          } catch {
            // If dispatch fails, mark job as error and continue to next queued job
            await this.jobRepository.update(job.job_id, {
              status: 'error',
              errorCode: 'dispatch_failed',
              finishedAt: new Date()
            })
          }
        }
        // Otherwise skip this job and continue to next
      }
    } finally {
      this.dispatching = false
    }
  }
}
