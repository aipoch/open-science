import type { ComputeJob as PrismaComputeJob, PrismaClient } from '@prisma/client'
import type {
  ComputeJob,
  ComputeJobAnalysisState,
  ComputeJobAnalysisTransition,
  ComputeJobStatus
} from '../../shared/compute'
import {
  OptionalSecureStorageStringProtection,
  type ProtectedJsonContainer
} from './credential-vault'

// Only ComputeJob persistence and a transaction wrapper are needed.
type ComputeJobClient = Pick<PrismaClient, '$transaction' | 'computeJob'>
type ComputeJobClientProvider = () => Promise<ComputeJobClient>
type ComputeJobFieldProtection = Pick<
  OptionalSecureStorageStringProtection,
  'isAvailable' | 'protect' | 'protectJson' | 'reveal' | 'revealJson'
>

export type ComputeJobOwner = Readonly<{
  projectId: string
  sessionId?: string
}>

export type ComputeJobSessionOwner = Readonly<{
  projectId: string
  sessionId: string
}>

export class UnencryptedComputeJobPersistenceApprovalRequiredError extends Error {
  constructor() {
    super('Compute Job plaintext persistence requires explicit approval.')
    this.name = 'UnencryptedComputeJobPersistenceApprovalRequiredError'
  }
}

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

const asAnalysisState = (value: string | null): ComputeJobAnalysisState | undefined => {
  const valid: ComputeJobAnalysisState[] = ['dispatched', 'succeeded', 'failed', 'cancelled']
  return valid.includes(value as ComputeJobAnalysisState)
    ? (value as ComputeJobAnalysisState)
    : undefined
}

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
  allowUnencryptedPersistence?: boolean
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
type ComputeJobCreateData = Parameters<ComputeJobClient['computeJob']['create']>[0]['data']

// Owns ComputeJob reads/writes. Follows the same lazy-provider pattern as ComputeHostRepository.
export class ComputeJobRepository {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly deletingProjects = new Set<string>()
  private readonly deletingSessions = new Set<string>()
  private readonly deletingProviders = new Set<string>()

  constructor(
    private readonly getClient: ComputeJobClientProvider,
    private readonly fieldProtection: ComputeJobFieldProtection = new OptionalSecureStorageStringProtection()
  ) {}

  isFieldProtectionAvailable(): boolean {
    return this.fieldProtection.isAvailable()
  }

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
    return rows.map(this.toJob)
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
      const sensitiveDataEncrypted = this.fieldProtection.isAvailable()
      if (!sensitiveDataEncrypted && request.allowUnencryptedPersistence !== true) {
        throw new UnencryptedComputeJobPersistenceApprovalRequiredError()
      }

      const buildData = (encrypt: boolean): ComputeJobCreateData => ({
        id: request.id,
        providerId: request.providerId,
        shape: request.shape,
        sessionId: request.sessionId,
        projectId: request.projectId,
        status: initialStatus,
        intent: this.protect(request.intent, encrypt),
        command: this.protect(request.command, encrypt),
        commandHash: request.commandHash,
        sensitiveDataEncrypted: encrypt,
        environment: this.protectOptional(request.environment, encrypt),
        resourceRequest: this.protectJsonOptional(request.resourceRequest, 'object', encrypt),
        inputManifest: this.protectJsonOptional(request.inputManifest, 'array', encrypt),
        outputManifest: this.protectJsonOptional(request.outputManifest, 'array', encrypt),
        harvestConfig: this.protectJsonOptional(request.harvestConfig, 'object', encrypt),
        timeoutSeconds: request.timeoutSeconds,
        remoteWorkdir: this.protectOptional(request.remoteWorkdir, encrypt),
        submittedAt: initialStatus === 'submitted' ? new Date() : undefined
      })

      let data: ReturnType<typeof buildData>
      try {
        data = buildData(sensitiveDataEncrypted)
      } catch (error) {
        if (sensitiveDataEncrypted && !this.fieldProtection.isAvailable()) {
          if (request.allowUnencryptedPersistence !== true) {
            throw new UnencryptedComputeJobPersistenceApprovalRequiredError()
          }
          data = buildData(false)
        } else {
          throw error
        }
      }

      const row = await client.computeJob.create({ data })
      return this.toJob(row)
    })
  }

  async get(jobId: string): Promise<ComputeJob | null> {
    const client = await this.getClient()
    const row = await client.computeJob.findUnique({ where: { id: jobId } })
    return row ? this.toJob(row) : null
  }

  // Returns all non-terminal jobs (queued + submitted + running) for the poller to resume after restart.
  async findNonTerminal(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { status: { in: ['queued', 'submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(rows.map(this.toJob))
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
    return this.excludeDeletingOwners(rows.map(this.toJob))
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
    return this.excludeDeletingOwners(rows.map(this.toJob))
  }

  // Returns all non-terminal jobs for a given provider (used by per-host batch polling).
  async findNonTerminalByProvider(providerId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { providerId, status: { in: ['queued', 'submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(this.toJob)
  }

  async update(jobId: string, updates: UpdateJobRequest): Promise<ComputeJob> {
    const client = await this.getClient()
    const current = await client.computeJob.findUnique({ where: { id: jobId } })
    const row = await client.computeJob.update({
      where: { id: jobId },
      data: this.toUpdateData(updates, current?.sensitiveDataEncrypted === true)
    })
    return this.toJob(row)
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
          data: this.toUpdateData(updates, current.sensitiveDataEncrypted === true)
        })
        if (applied.count === 0) return null

        const row = await transaction.computeJob.findUnique({ where: { id: jobId } })
        return row ? this.toJob(row) : null
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
    return rows.map(this.toJob)
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

  // Returns notified jobs whose automatic analysis is still pending or dispatched, optionally
  // scoped to one Session. Failed/cancelled outcomes stay unconsumed but are terminal and observable
  // through normal Job reads, so the restart scan does not repeatedly requeue them.
  async findPendingNotifications(sessionId?: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        ...(sessionId === undefined ? {} : { sessionId }),
        notifiedAt: { not: null },
        notificationConsumedAt: null,
        OR: [{ analysisState: null }, { analysisState: 'dispatched' }]
      },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(this.toJob)
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

  async transitionAnalysis(request: ComputeJobAnalysisTransition): Promise<ComputeJob[]> {
    const sessionId = request.sessionId.trim()
    const messageId = request.messageId.trim()
    const jobIds = [...new Set(request.jobIds.map((jobId) => jobId.trim()).filter(Boolean))]
    if (!sessionId || !messageId || jobIds.length === 0) {
      throw new Error('Compute analysis transition requires a Session, Jobs, and Message identity.')
    }

    const client = await this.getClient()
    await client.$transaction(async (transaction) => {
      const rows = await transaction.computeJob.findMany({ where: { id: { in: jobIds } } })
      if (
        rows.length !== jobIds.length ||
        rows.some((row) => row.sessionId !== sessionId || row.notifiedAt === null)
      ) {
        throw new Error('Cannot transition compute analysis outside the requested Session.')
      }

      const transitionAllowed = rows.every((row) => {
        if (request.state === 'dispatched') {
          return (
            row.notificationConsumedAt === null &&
            (row.analysisState === null ||
              (row.analysisState === 'dispatched' && row.analysisMessageId === messageId))
          )
        }
        return (
          row.analysisMessageId === messageId &&
          (row.analysisState === 'dispatched' || row.analysisState === request.state)
        )
      })
      if (!transitionAllowed) {
        throw new Error('Compute analysis transition does not match its durable dispatch.')
      }

      await transaction.computeJob.updateMany({
        where: { sessionId, id: { in: jobIds } },
        data: {
          analysisState: request.state,
          analysisMessageId: messageId,
          analysisUpdatedAt: new Date(),
          ...(request.state === 'succeeded' ? { notificationConsumedAt: new Date() } : {})
        }
      })
    })

    const rows = await client.computeJob.findMany({
      where: { sessionId, id: { in: jobIds } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(this.toJob)
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
    return rows.map(this.toJob)
  }

  private readonly toJob = (row: PrismaComputeJob): ComputeJob => ({
    job_id: row.id,
    provider_id: row.providerId,
    shape: row.shape,
    session_id: row.sessionId,
    project_id: row.projectId,
    status: asStatus(row.status),
    intent: this.reveal(row.intent, row.sensitiveDataEncrypted === true),
    command: this.reveal(row.command, row.sensitiveDataEncrypted === true),
    command_hash: row.commandHash,
    environment: this.revealOptional(row.environment, row.sensitiveDataEncrypted === true),
    resource_request: this.revealJsonOptional(
      row.resourceRequest,
      'object',
      row.sensitiveDataEncrypted === true
    ),
    input_manifest: this.revealJsonOptional(
      row.inputManifest,
      'array',
      row.sensitiveDataEncrypted === true
    ),
    output_manifest: this.revealJsonOptional(
      row.outputManifest,
      'array',
      row.sensitiveDataEncrypted === true
    ),
    harvest_config: this.revealJsonOptional(
      row.harvestConfig,
      'object',
      row.sensitiveDataEncrypted === true
    ),
    timeout_seconds: row.timeoutSeconds ?? undefined,
    remote_workdir: this.revealOptional(row.remoteWorkdir, row.sensitiveDataEncrypted === true),
    remote_handle: this.revealJsonOptional(
      row.remoteHandle,
      'object',
      row.sensitiveDataEncrypted === true
    ),
    exit_code: row.exitCode ?? undefined,
    stdout_tail: this.revealOptional(row.stdoutTail, row.sensitiveDataEncrypted === true),
    stderr_tail: this.revealOptional(row.stderrTail, row.sensitiveDataEncrypted === true),
    error_code: row.errorCode ?? undefined,
    last_poll_error: this.revealOptional(row.lastPollError, row.sensitiveDataEncrypted === true),
    harvest_error: this.revealOptional(row.harvestError, row.sensitiveDataEncrypted === true),
    left_on_remote: this.revealJsonOptional(
      row.leftOnRemote,
      'array',
      row.sensitiveDataEncrypted === true
    ),
    notified_at: row.notifiedAt?.getTime(),
    notification_consumed_at: row.notificationConsumedAt?.getTime(),
    analysis_state: asAnalysisState(row.analysisState),
    analysis_message_id: row.analysisMessageId ?? undefined,
    analysis_updated_at: row.analysisUpdatedAt?.getTime(),
    created_at: row.createdAt.getTime(),
    submitted_at: row.submittedAt?.getTime(),
    started_at: row.startedAt?.getTime(),
    finished_at: row.finishedAt?.getTime(),
    harvested_at: row.harvestedAt?.getTime()
  })

  private toUpdateData(
    updates: UpdateJobRequest,
    sensitiveDataEncrypted: boolean
  ): ComputeJobUpdateData {
    const data: ComputeJobUpdateData = {}

    if (updates.status !== undefined) data.status = updates.status
    if (updates.remoteHandle !== undefined)
      data.remoteHandle = this.protectJson(updates.remoteHandle, 'object', sensitiveDataEncrypted)
    if ('exitCode' in updates) data.exitCode = updates.exitCode
    if ('stdoutTail' in updates)
      data.stdoutTail =
        updates.stdoutTail === null
          ? null
          : this.protectOptional(updates.stdoutTail, sensitiveDataEncrypted)
    if ('stderrTail' in updates)
      data.stderrTail =
        updates.stderrTail === null
          ? null
          : this.protectOptional(updates.stderrTail, sensitiveDataEncrypted)
    if ('errorCode' in updates) data.errorCode = updates.errorCode
    if ('lastPollError' in updates)
      data.lastPollError =
        updates.lastPollError === null
          ? null
          : this.protectOptional(updates.lastPollError, sensitiveDataEncrypted)
    if (updates.submittedAt !== undefined) data.submittedAt = updates.submittedAt
    if (updates.startedAt !== undefined) data.startedAt = updates.startedAt
    if (updates.finishedAt !== undefined) data.finishedAt = updates.finishedAt
    if (updates.harvestedAt !== undefined) data.harvestedAt = updates.harvestedAt
    if ('harvestError' in updates)
      data.harvestError =
        updates.harvestError === null
          ? null
          : this.protectOptional(updates.harvestError, sensitiveDataEncrypted)
    if ('leftOnRemote' in updates)
      data.leftOnRemote =
        updates.leftOnRemote === null
          ? null
          : this.protectJsonOptional(updates.leftOnRemote, 'array', sensitiveDataEncrypted)
    if ('notifiedAt' in updates) data.notifiedAt = updates.notifiedAt
    if ('notificationConsumedAt' in updates)
      data.notificationConsumedAt = updates.notificationConsumedAt

    return data
  }

  private protect(value: string, sensitiveDataEncrypted: boolean): string {
    return sensitiveDataEncrypted ? this.fieldProtection.protect(value) : value
  }

  private protectOptional(
    value: string | undefined,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === undefined ? undefined : this.protect(value, sensitiveDataEncrypted)
  }

  private protectJson(
    value: string,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string {
    return sensitiveDataEncrypted ? this.fieldProtection.protectJson(value, container) : value
  }

  private protectJsonOptional(
    value: string | undefined,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === undefined
      ? undefined
      : this.protectJson(value, container, sensitiveDataEncrypted)
  }

  private reveal(value: string, sensitiveDataEncrypted: boolean): string {
    return sensitiveDataEncrypted ? this.fieldProtection.reveal(value) : value
  }

  private revealOptional(
    value: string | null,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === null ? undefined : this.reveal(value, sensitiveDataEncrypted)
  }

  private revealJsonOptional(
    value: string | null,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === null
      ? undefined
      : sensitiveDataEncrypted
        ? this.fieldProtection.revealJson(value, container)
        : value
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

export type { ComputeJobClient, ComputeJobClientProvider, ComputeJobFieldProtection }
