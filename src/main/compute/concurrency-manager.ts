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

  constructor(
    private readonly jobRepository: ComputeJobRepository,
    private readonly hostRepository: ComputeHostRepository,
    private readonly dispatchJob: (jobId: string) => Promise<void>
  ) {}

  // Set session-level concurrency limit (stored in memory, not persisted).
  setSessionLimit(sessionId: string, limit: number): void {
    this.sessionLimits.set(sessionId, limit)
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

    // 2. Check session limit (if set) - only count active jobs (submitted + running), not queued
    const sessionLimit = this.sessionLimits.get(sessionId)
    let sessionLimitViolated = false
    if (sessionLimit !== undefined) {
      const activeInSession = await this.jobRepository.countActiveBySession(sessionId)
      if (activeInSession >= sessionLimit) {
        sessionLimitViolated = true
      }
    }

    // 3. Check provider ceiling - only count active jobs (submitted + running), not queued
    const host = await this.hostRepository.get(providerId)
    const providerCeiling = host?.concurrencyLimit ?? DEFAULT_PROVIDER_CEILING
    const activeOnProvider = await this.jobRepository.countActiveByProvider(providerId)
    const providerCeilingViolated = activeOnProvider >= providerCeiling

    // 4. Determine result
    if (sessionLimitViolated || providerCeilingViolated) {
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
