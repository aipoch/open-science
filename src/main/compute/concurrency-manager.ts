import type { ComputeJobOwner, ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeJob } from '../../shared/compute'
import { createLogger, errorLogFields } from '../logger'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'

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
const log = createLogger('compute-concurrency')
const TERMINAL_JOB_STATUSES: ReadonlySet<ComputeJob['status']> = new Set([
  'success',
  'failed',
  'timeout',
  'error'
])

type DispatchQueuedJob = (jobId: string, onJobUpdated: (job: ComputeJob) => void) => Promise<void>

type SessionConcurrencyLimitPersistence = {
  load(): Promise<readonly (readonly [sessionId: string, limit: number])[]>
  save(sessionId: string, limit: number): Promise<void>
}

// Enforces session-level and provider-level concurrency limits for compute jobs.
// Restores durable session limits into memory, decides whether jobs should queue or dispatch, and
// automatically dispatches queued jobs when slots become available.
export class ConcurrencyManager {
  private sessionLimits: Map<string, number> = new Map()

  private reconciliationRequested: boolean = false
  private reconciliationTask: Promise<void> | undefined
  private queueStopped: boolean
  private queueLifecycleRevision = 0

  // In-process serialization lock for admit(). The decision (read counts → pick status) and the
  // job-row commit must be atomic: without this, two concurrent submitJob calls could both read the
  // same active count, both decide 'submitted', and overrun a provider ceiling or session limit.
  // JS is single-threaded, so chaining commit work onto this promise fully serializes the critical
  // section — the row written by one admit is visible to the DB counts read by the next.
  private admitLock: Promise<unknown> = Promise.resolve()
  private readonly lifecycle: ComputeJobLifecycle
  private readonly pausedProjects = new Set<string>()
  private readonly pausedSessions = new Set<string>()
  private readonly ownerOperations = new Map<Promise<unknown>, ComputeJobOwner>()

  constructor(
    private readonly jobRepository: ComputeJobRepository,
    private readonly hostRepository: ComputeHostRepository,
    private readonly dispatchJob: DispatchQueuedJob,
    private readonly publishJobUpdated: (job: ComputeJob) => void = () => undefined,
    lifecycle?: ComputeJobLifecycle,
    private readonly dispatchTracker: Pick<
      DispatchTracker,
      'begin' | 'end'
    > = sharedDispatchTracker,
    private readonly sessionLimitPersistence?: SessionConcurrencyLimitPersistence
  ) {
    this.lifecycle = lifecycle ?? new ComputeJobLifecycle(jobRepository, this.handleJobUpdated)
    // A production manager with durable Session limits fails closed until startup restoration has
    // completed. Isolated callers without persistence retain the existing immediately-active seam.
    this.queueStopped = sessionLimitPersistence !== undefined
  }

  // Owns the complete update policy used by ComputeService: publish every persisted projection, then
  // free and refill queue capacity for terminal states. Dispatcher and poller both receive this bound
  // handler, and the manager's own fallback persistence uses it below.
  handleJobUpdated = (job: ComputeJob): void => {
    this.publishJobUpdated(job)
    if (TERMINAL_JOB_STATUSES.has(job.status)) this.requestQueueReconciliation()
  }

  // Serialize the durable write and live projection with admissions so a successful setting cannot
  // be followed by a late admission made against the previous value.
  async setSessionLimit(sessionId: string, limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }

    let previousLimit: number | undefined
    await this.runExclusive(async () => {
      await this.sessionLimitPersistence?.save(sessionId, limit)
      previousLimit = this.sessionLimits.get(sessionId)
      this.sessionLimits.set(sessionId, limit)
    })

    if (previousLimit !== undefined && limit > previousLimit) {
      this.requestQueueReconciliation()
    }
  }

  // Projects a limit that was already committed through Session persistence. Session creation uses
  // this path so inherited limits become authoritative in the current process without writing the
  // same Session a second time.
  async projectPersistedSessionLimit(sessionId: string, limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }

    let previousLimit: number | undefined
    await this.runExclusive(async () => {
      previousLimit = this.sessionLimits.get(sessionId)
      this.sessionLimits.set(sessionId, limit)
    })

    if (previousLimit !== undefined && limit > previousLimit) {
      this.requestQueueReconciliation()
    }
  }

  async clearProjectedSessionLimits(sessionIds: readonly string[]): Promise<void> {
    await this.runExclusive(async () => {
      for (const sessionId of sessionIds) this.sessionLimits.delete(sessionId)
    })
  }

  // Provider limits are durable host configuration. Own the production mutation here so it shares
  // the same lock as admission and queued-job promotion; raising the ceiling then wakes the FIFO queue.
  async setProviderLimit(providerId: string, limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(`Concurrent job limit must be an integer in the range 1..500 (got ${limit}).`)
    }

    let previousLimit = DEFAULT_PROVIDER_CEILING
    await this.runExclusive(async () => {
      const host = await this.hostRepository.get(providerId)
      if (!host) throw new Error(`No compute host found with provider id "${providerId}".`)
      previousLimit = host.concurrencyLimit ?? DEFAULT_PROVIDER_CEILING
      await this.hostRepository.updateConcurrencyLimit(providerId, limit)
    })

    if (limit > previousLimit) this.requestQueueReconciliation()
  }

  async pauseOwner(owner: ComputeJobOwner): Promise<void> {
    if (owner.sessionId === undefined) this.pausedProjects.add(owner.projectId)
    else this.pausedSessions.add(this.sessionOwnerKey(owner.projectId, owner.sessionId))

    while (true) {
      const operations = [...this.ownerOperations].flatMap(([operation, candidate]) =>
        this.ownerMatches(owner, candidate) ? [operation] : []
      )
      if (operations.length === 0) return
      await Promise.allSettled(operations)
    }
  }

  resumeOwner(owner: ComputeJobOwner): void {
    if (owner.sessionId === undefined) this.pausedProjects.delete(owner.projectId)
    else this.pausedSessions.delete(this.sessionOwnerKey(owner.projectId, owner.sessionId))
    this.requestQueueReconciliation()
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
      const shouldQueue = await this.overActiveLimits(params.sessionId, params.providerId)
      if (!shouldQueue) {
        await commit('submitted')
        return 'submitted'
      }

      const globalQueuedCount = await this.jobRepository.countQueuedJobs()
      if (globalQueuedCount >= GLOBAL_QUEUE_LIMIT) return 'queue_full'
      await commit('queued')
      return 'queued'
    })
  }

  // Check limits and decide: dispatch now, queue, or reject (queue full).
  // Returns:
  // - 'queue_full': global queue at capacity (100 jobs)
  // - 'should_queue': either session limit or provider ceiling reached
  // - 'can_dispatch': both limits allow, job can be dispatched immediately
  //
  // ADVISORY ONLY for the submit path. submitJob() calls this before the approval gate purely to
  // reject early on a full global queue; its 'should_queue'/'can_dispatch' returns are NOT the
  // authoritative admission decision, because reading the count here and committing the row later is
  // not atomic (the race admit() closes). The binding decision + row commit is admit(). Do NOT route
  // a real submit decision through enqueue() — use admit() so the read→decide→commit stays atomic.
  async enqueue(params: {
    jobId: string
    sessionId: string
    providerId: string
  }): Promise<'can_dispatch' | 'should_queue' | 'queue_full'> {
    const { sessionId, providerId } = params

    if (!(await this.overActiveLimits(sessionId, providerId))) return 'can_dispatch'
    const globalQueuedCount = await this.jobRepository.countQueuedJobs()
    return globalQueuedCount >= GLOBAL_QUEUE_LIMIT ? 'queue_full' : 'should_queue'
  }

  // Called when a job reaches a terminal state. Attempts to dispatch the next eligible queued job.
  async onJobCompleted(): Promise<void> {
    await this.reconcileQueuedJobs()
  }

  async startQueueReconciliation(): Promise<void> {
    const lifecycleRevision = ++this.queueLifecycleRevision
    let shouldReconcile = false
    await this.runExclusive(async () => {
      const restoredLimits = await this.sessionLimitPersistence?.load()
      if (lifecycleRevision !== this.queueLifecycleRevision) return
      if (restoredLimits) {
        const limits = new Map<string, number>()
        for (const [sessionId, limit] of restoredLimits) {
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            throw new Error(
              `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
            )
          }
          limits.set(sessionId, limit)
        }
        this.sessionLimits = limits
      }
      this.queueStopped = false
      shouldReconcile = true
    })
    if (shouldReconcile) this.requestQueueReconciliation()
  }

  async stopQueueReconciliation(): Promise<void> {
    this.queueLifecycleRevision += 1
    this.queueStopped = true
    this.reconciliationRequested = false
    await this.reconciliationTask
  }

  reconcileQueuedJobs(): Promise<void> {
    if (this.queueStopped) return Promise.resolve()
    this.reconciliationRequested = true
    if (this.reconciliationTask) return this.reconciliationTask

    const task = this.tryDispatchNext().finally(() => {
      if (this.reconciliationTask === task) this.reconciliationTask = undefined
    })
    this.reconciliationTask = task
    return task
  }

  private requestQueueReconciliation(): void {
    void this.reconcileQueuedJobs().catch((error) => {
      log.warn('compute queue reconciliation failed', errorLogFields(error))
    })
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
    do {
      this.reconciliationRequested = false
      const queuedJobs = await this.jobRepository.findQueuedJobs()
      if (this.queueStopped) return
      const dispatchOperations: Promise<void>[] = []

      for (const job of queuedJobs) {
        if (this.queueStopped) break
        const owner = { projectId: job.project_id, sessionId: job.session_id }
        if (this.isOwnerPaused(owner)) continue
        const reservation = this.runExclusive(async () => {
          if (this.queueStopped || this.isOwnerPaused(owner)) return false
          if (await this.overActiveLimits(job.session_id, job.provider_id)) return false
          if (this.queueStopped || this.isOwnerPaused(owner)) return false
          this.dispatchTracker.begin(job.job_id)
          try {
            const promotion = await this.lifecycle.promoteQueued(job.job_id)
            if (promotion.kind === 'applied') return true
          } catch (error) {
            this.dispatchTracker.end(job.job_id)
            throw error
          }
          this.dispatchTracker.end(job.job_id)
          return false
        })
        this.ownerOperations.set(reservation, owner)
        let reserved: boolean
        try {
          reserved = await reservation
        } finally {
          this.ownerOperations.delete(reservation)
        }
        if (!reserved) continue

        const operation = (async (): Promise<void> => {
          try {
            const dispatch = this.dispatchJob(job.job_id, this.handleJobUpdated)
            this.dispatchTracker.end(job.job_id)
            await dispatch
          } catch {
            this.dispatchTracker.end(job.job_id)
            // If dispatch fails, mark job as error and continue to next queued job.
            await this.lifecycle.dispatchError(job.job_id, { errorCode: 'dispatch_failed' })
          }
        })()
        this.ownerOperations.set(operation, owner)
        dispatchOperations.push(operation)
        void operation.then(
          () => this.ownerOperations.delete(operation),
          () => this.ownerOperations.delete(operation)
        )
      }
      await Promise.allSettled(dispatchOperations)
    } while (!this.queueStopped && this.reconciliationRequested)
  }

  private isOwnerPaused(owner: ComputeJobOwner): boolean {
    return (
      this.pausedProjects.has(owner.projectId) ||
      (owner.sessionId !== undefined &&
        this.pausedSessions.has(this.sessionOwnerKey(owner.projectId, owner.sessionId)))
    )
  }

  private ownerMatches(scope: ComputeJobOwner, candidate: ComputeJobOwner): boolean {
    return (
      scope.projectId === candidate.projectId &&
      (scope.sessionId === undefined || scope.sessionId === candidate.sessionId)
    )
  }

  private sessionOwnerKey(projectId: string, sessionId: string): string {
    return JSON.stringify([projectId, sessionId])
  }
}

export type { SessionConcurrencyLimitPersistence }
