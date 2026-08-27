import type { ComputeJob as PrismaComputeJob, PrismaClient } from '@prisma/client'
import type { ComputeJob, ComputeJobStatus } from '../../shared/compute'

// Only ComputeJob persistence and a transaction wrapper are needed.
type ComputeJobClient = Pick<PrismaClient, '$transaction' | 'computeJob'>
type ComputeJobClientProvider = () => Promise<ComputeJobClient>

export type ComputeJobOwner = Readonly<{
  projectId: string
  sessionId?: string
}>

export type ComputeJobSessionOwner = Readonly<{
  projectId: string
  sessionId: string
}>

const ownerWhere = (owner: ComputeJobOwner): { projectId: string; sessionId?: string } => ({
  projectId: owner.projectId,
  ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId })
})

const sessionOwnerKey = (projectId: string, sessionId: string): string =>
  JSON.stringify([projectId, sessionId])

const asStatus = (value: string): ComputeJobStatus => {
  const valid: ComputeJobStatus[] = [
    'queued',
    'submitted',
    'running',
    'success',
    'failed',
    'timeout',
    'error'
  ]
  return valid.includes(value as ComputeJobStatus) ? (value as ComputeJobStatus) : 'error'
}

// Maps a Prisma row to the shared ComputeJob type.
const toJob = (row: PrismaComputeJob): ComputeJob => ({
  job_id: row.id,
  provider_id: row.providerId,
  shape: row.shape,
  session_id: row.sessionId,
  project_id: row.projectId,
  status: asStatus(row.status),
  intent: row.intent,
  command: row.command,
  command_hash: row.commandHash,
  environment: row.environment ?? undefined,
  resource_request: row.resourceRequest ?? undefined,
  input_manifest: row.inputManifest ?? undefined,
  output_manifest: row.outputManifest ?? undefined,
  harvest_config: row.harvestConfig ?? undefined,
  timeout_seconds: row.timeoutSeconds ?? undefined,
  remote_workdir: row.remoteWorkdir ?? undefined,
  remote_handle: row.remoteHandle ?? undefined,
  exit_code: row.exitCode ?? undefined,
  stdout_tail: row.stdoutTail ?? undefined,
  stderr_tail: row.stderrTail ?? undefined,
  error_code: row.errorCode ?? undefined,
  last_poll_error: row.lastPollError ?? undefined,
  // Phase 3b harvest fields
  harvest_error: row.harvestError ?? undefined,
  left_on_remote: row.leftOnRemote ?? undefined,
  notified_at: row.notifiedAt?.getTime(),
  notification_consumed_at: row.notificationConsumedAt?.getTime(),
  created_at: row.createdAt.getTime(),
  submitted_at: row.submittedAt?.getTime(),
  started_at: row.startedAt?.getTime(),
  finished_at: row.finishedAt?.getTime(),
  harvested_at: row.harvestedAt?.getTime()
})

export type CreateJobRequest = {
  id: string
  providerId: string
  shape: string
  sessionId: string
  projectId: string
  intent: string
  command: string
  commandHash: string
  environment?: string
  resourceRequest?: string
  inputManifest?: string
  outputManifest?: string
  harvestConfig?: string
  timeoutSeconds?: number
  remoteWorkdir?: string
  initialStatus?: ComputeJobStatus
}

export type UpdateJobRequest = {
  status?: ComputeJobStatus
  remoteHandle?: string
  exitCode?: number | null
  stdoutTail?: string | null
  stderrTail?: string | null
  errorCode?: string | null
  // lastPollError is set when SSH connectivity fails during polling (not a job failure).
  lastPollError?: string | null
  // retryAfterUserAction is an in-memory hint; always true for poll connectivity errors.
  // It is NOT persisted to the DB but is carried in the update call so callers can surface
  // the retry_after_user_action semantic without a separate DB column.
  retryAfterUserAction?: boolean
  submittedAt?: Date
  startedAt?: Date
  finishedAt?: Date
  // Phase 3b harvest fields (compute-harvest issue 01).
  harvestedAt?: Date
  harvestError?: string | null
  leftOnRemote?: string | null
  notifiedAt?: Date | null
  notificationConsumedAt?: Date | null
}

type ComputeJobUpdateData = Parameters<ComputeJobClient['computeJob']['update']>[0]['data']

const toUpdateData = (updates: UpdateJobRequest): ComputeJobUpdateData => {
  const data: ComputeJobUpdateData = {}

  if (updates.status !== undefined) data.status = updates.status
  if (updates.remoteHandle !== undefined) data.remoteHandle = updates.remoteHandle
  if ('exitCode' in updates) data.exitCode = updates.exitCode
  if ('stdoutTail' in updates) data.stdoutTail = updates.stdoutTail
  if ('stderrTail' in updates) data.stderrTail = updates.stderrTail
  if ('errorCode' in updates) data.errorCode = updates.errorCode
  if ('lastPollError' in updates) data.lastPollError = updates.lastPollError
  if (updates.submittedAt !== undefined) data.submittedAt = updates.submittedAt
  if (updates.startedAt !== undefined) data.startedAt = updates.startedAt
  if (updates.finishedAt !== undefined) data.finishedAt = updates.finishedAt
  if (updates.harvestedAt !== undefined) data.harvestedAt = updates.harvestedAt
  if ('harvestError' in updates) data.harvestError = updates.harvestError
  if ('leftOnRemote' in updates) data.leftOnRemote = updates.leftOnRemote
  if ('notifiedAt' in updates) data.notifiedAt = updates.notifiedAt
  if ('notificationConsumedAt' in updates)
    data.notificationConsumedAt = updates.notificationConsumedAt

  return data
}

// Owns ComputeJob reads/writes. Follows the same lazy-provider pattern as ComputeHostRepository.
export class ComputeJobRepository {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly deletingProjects = new Set<string>()
  private readonly deletingSessions = new Set<string>()
  private readonly deletingProviders = new Set<string>()

  constructor(private readonly getClient: ComputeJobClientProvider) {}

  async beginProviderDeletion(providerId: string): Promise<void> {
    await this.runMutation(async () => {
      this.deletingProviders.add(providerId)
    })
  }

  async abortProviderDeletion(providerId: string): Promise<void> {
    await this.runMutation(async () => {
      this.deletingProviders.delete(providerId)
    })
  }

  async completeProviderDeletion(providerId: string): Promise<void> {
    await this.abortProviderDeletion(providerId)
  }

  async beginOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      if (owner.sessionId === undefined) this.deletingProjects.add(owner.projectId)
      else this.deletingSessions.add(sessionOwnerKey(owner.projectId, owner.sessionId))
    })
  }

  async abortOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      if (owner.sessionId === undefined) this.deletingProjects.delete(owner.projectId)
      else this.deletingSessions.delete(sessionOwnerKey(owner.projectId, owner.sessionId))
    })
  }

  async findByOwner(owner: ComputeJobOwner): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: ownerWhere(owner),
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  async listOwners(): Promise<ComputeJobSessionOwner[]> {
    const client = await this.getClient()
    return client.computeJob.findMany({
      select: { projectId: true, sessionId: true },
      distinct: ['projectId', 'sessionId'],
      orderBy: [{ projectId: 'asc' }, { sessionId: 'asc' }]
    })
  }

  async deleteByOwner(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      const client = await this.getClient()
      await client.computeJob.deleteMany({ where: ownerWhere(owner) })
    })
  }

  async create(request: CreateJobRequest): Promise<ComputeJob> {
    return this.runMutation(async () => {
      if (this.deletingProviders.has(request.providerId)) {
        throw new Error(`Compute Host is being removed: ${request.providerId}`)
      }
      this.assertOwnerMutable(request.projectId, request.sessionId)
      const client = await this.getClient()
      const initialStatus = request.initialStatus ?? 'submitted'
      const row = await client.computeJob.create({
        data: {
          id: request.id,
          providerId: request.providerId,
          shape: request.shape,
          sessionId: request.sessionId,
          projectId: request.projectId,
          status: initialStatus,
          intent: request.intent,
          command: request.command,
          commandHash: request.commandHash,
          environment: request.environment,
          resourceRequest: request.resourceRequest,
          inputManifest: request.inputManifest,
          outputManifest: request.outputManifest,
          harvestConfig: request.harvestConfig,
          timeoutSeconds: request.timeoutSeconds,
          remoteWorkdir: request.remoteWorkdir,
          submittedAt: initialStatus === 'submitted' ? new Date() : undefined
        }
      })
      return toJob(row)
    })
  }

  async get(jobId: string): Promise<ComputeJob | null> {
    const client = await this.getClient()
    const row = await client.computeJob.findUnique({ where: { id: jobId } })
    return row ? toJob(row) : null
  }

  // Returns all non-terminal jobs (queued + submitted + running) for the poller to resume after restart.
  async findNonTerminal(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { status: { in: ['queued', 'submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(rows.map(toJob))
  }

  // Returns all terminal jobs (success/failed/timeout) that have not yet been harvested.
  // Used by the poller's restart-recovery scan to re-queue harvests interrupted by an app restart.
  async findTerminalUnharvested(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        status: { in: ['success', 'failed', 'timeout'] },
        harvestedAt: null
      },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(rows.map(toJob))
  }

  // Returns error-state jobs that have not yet emitted a compute_done notification.
  // 'error' is a terminal resting state written by the dispatcher (dispatch_failed / host_unreachable)
  // and is excluded from both findNonTerminal and findTerminalUnharvested — so without this scan an
  // error job would never reach the notify→analyze flow. The poller uses it as a recovery scan;
  // emitJobNotification is idempotent (guards on notified_at), so re-scanning a row is a no-op.
  async findErrorUnnotified(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        status: 'error',
        notifiedAt: null
      },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(rows.map(toJob))
  }

  // Returns all non-terminal jobs for a given provider (used by per-host batch polling).
  async findNonTerminalByProvider(providerId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { providerId, status: { in: ['queued', 'submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  async update(jobId: string, updates: UpdateJobRequest): Promise<ComputeJob> {
    const client = await this.getClient()
    const row = await client.computeJob.update({
      where: { id: jobId },
      data: toUpdateData(updates)
    })
    return toJob(row)
  }

  async updateIfStatus(
    jobId: string,
    expectedStatuses: readonly ComputeJobStatus[],
    updates: UpdateJobRequest
  ): Promise<ComputeJob | null> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
        if (!current || !this.isOwnerMutable(current.projectId, current.sessionId)) return null

        const applied = await transaction.computeJob.updateMany({
          where: { id: jobId, status: { in: [...expectedStatuses] } },
          data: toUpdateData(updates)
        })
        if (applied.count === 0) return null

        const row = await transaction.computeJob.findUnique({ where: { id: jobId } })
        return row ? toJob(row) : null
      })
    })
  }

  // Returns all jobs for a session, newest-first. Optionally filtered by status values.
  async findBySession(sessionId: string, statuses?: string[]): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        sessionId,
        ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {})
      },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toJob)
  }

  // Checks if a provider has any non-terminal jobs (used by delete guard on ComputeHost).
  async hasActiveJobsForProvider(providerId: string): Promise<boolean> {
    const client = await this.getClient()
    const count = await client.computeJob.count({
      where: { providerId, status: { in: ['queued', 'submitted', 'running'] } }
    })
    return count > 0
  }

  async hasIdentityChangeBlockingJobsForProvider(providerId: string): Promise<boolean> {
    const client = await this.getClient()
    const count = await client.computeJob.count({
      where: {
        providerId,
        OR: [
          { status: { in: ['queued', 'submitted', 'running'] } },
          { status: { in: ['success', 'failed', 'timeout'] }, harvestedAt: null }
        ]
      }
    })
    return count > 0
  }

  // Host deletion must retain authentication while any Job row remains. Even a dispatch-error Job
  // can have created remote state before its workdir was persisted, and the owner-deletion workflow
  // derives that cleanup path from the Host when needed.
  async hasDeletionBlockingJobsForProvider(providerId: string): Promise<boolean> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      const count = await client.computeJob.count({ where: { providerId } })
      return count > 0
    })
  }

  // Returns notified jobs that have not yet been consumed, optionally scoped to one Session.
  // The App-level analysis owner uses the global form for restart recovery.
  async findPendingNotifications(sessionId?: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        ...(sessionId === undefined ? {} : { sessionId }),
        notifiedAt: { not: null },
        notificationConsumedAt: null
      },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  // Marks a batch of jobs as notification-consumed by setting notificationConsumedAt to now.
  // Session ids are globally stable identities; reject a mixed, missing, or unnotified batch
  // atomically so a caller cannot consume another Session's notification by job id.
  async markNotificationsConsumed(sessionId: string, jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return
    const client = await this.getClient()
    const distinctJobIds = [...new Set(jobIds)]
    await client.$transaction(async (transaction) => {
      const rows = await transaction.computeJob.findMany({
        where: { id: { in: distinctJobIds } },
        select: { id: true, sessionId: true, notifiedAt: true }
      })
      const allOwnedNotifications =
        rows.length === distinctJobIds.length &&
        rows.every((row) => row.sessionId === sessionId && row.notifiedAt !== null)
      if (!allOwnedNotifications) {
        throw new Error('Cannot consume compute notifications outside the requested Session.')
      }
      await transaction.computeJob.updateMany({
        where: {
          sessionId,
          id: { in: distinctJobIds },
          notifiedAt: { not: null },
          notificationConsumedAt: null
        },
        data: { notificationConsumedAt: new Date() }
      })
    })
  }

  // Counts non-terminal jobs (queued, submitted, running) across all sessions for a given provider.
  // Used by ConcurrencyManager to enforce provider ceilings.
  async countNonTerminalByProvider(providerId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        providerId,
        status: { in: ['queued', 'submitted', 'running'] }
      }
    })
  }

  // Counts non-terminal jobs (queued, submitted, running) across all providers for a given session.
  // Used by ConcurrencyManager to enforce session limits.
  async countNonTerminalBySession(sessionId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        sessionId,
        status: { in: ['queued', 'submitted', 'running'] }
      }
    })
  }

  // Counts active jobs (submitted, running) excluding queued, for a given session.
  // Used by ConcurrencyManager to check if a new job should queue or dispatch immediately.
  async countActiveBySession(sessionId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        sessionId,
        status: { in: ['submitted', 'running'] }
      }
    })
  }

  // Counts active jobs (submitted, running) excluding queued, for a given provider.
  // Used by ConcurrencyManager to check provider ceiling enforcement.
  async countActiveByProvider(providerId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        providerId,
        status: { in: ['submitted', 'running'] }
      }
    })
  }

  // Counts all queued jobs globally (across all sessions and providers).
  // Used by ConcurrencyManager to enforce the global queue limit (100).
  async countQueuedJobs(): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: { status: 'queued' }
    })
  }

  // Returns all queued jobs ordered by createdAt ascending (FIFO).
  // Used by ConcurrencyManager to dispatch the next eligible job when a slot frees up.
  async findQueuedJobs(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  private assertOwnerMutable(projectId: string, sessionId: string): void {
    if (!this.isOwnerMutable(projectId, sessionId)) {
      throw new Error('Cannot create a Compute Job while its owner is being deleted.')
    }
  }

  private excludeDeletingOwners(jobs: ComputeJob[]): ComputeJob[] {
    return jobs.filter((job) => this.isOwnerMutable(job.project_id, job.session_id))
  }

  private isOwnerMutable(projectId: string, sessionId: string): boolean {
    return (
      !this.deletingProjects.has(projectId) &&
      !this.deletingSessions.has(sessionOwnerKey(projectId, sessionId))
    )
  }

  private runMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

export { toJob }
export type { ComputeJobClient, ComputeJobClientProvider }
