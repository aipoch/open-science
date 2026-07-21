import type { ComputeJob as PrismaComputeJob, PrismaClient } from '@prisma/client'
import type { ComputeJob, ComputeJobStatus } from '../../shared/compute'

// Only the computeJob delegate is needed.
type ComputeJobClient = Pick<PrismaClient, 'computeJob'>
type ComputeJobClientProvider = () => Promise<ComputeJobClient>

const asStatus = (value: string): ComputeJobStatus => {
  const valid: ComputeJobStatus[] = [
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

// Owns ComputeJob reads/writes. Follows the same lazy-provider pattern as ComputeHostRepository.
export class ComputeJobRepository {
  constructor(private readonly getClient: ComputeJobClientProvider) {}

  async create(request: CreateJobRequest): Promise<ComputeJob> {
    const client = await this.getClient()
    const row = await client.computeJob.create({
      data: {
        id: request.id,
        providerId: request.providerId,
        shape: request.shape,
        sessionId: request.sessionId,
        projectId: request.projectId,
        status: 'submitted',
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
        submittedAt: new Date()
      }
    })
    return toJob(row)
  }

  async get(jobId: string): Promise<ComputeJob | null> {
    const client = await this.getClient()
    const row = await client.computeJob.findUnique({ where: { id: jobId } })
    return row ? toJob(row) : null
  }

  // Returns all non-terminal jobs (submitted + running) for the poller to resume after restart.
  async findNonTerminal(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { status: { in: ['submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
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
    return rows.map(toJob)
  }

  // Returns all non-terminal jobs for a given provider (used by per-host batch polling).
  async findNonTerminalByProvider(providerId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { providerId, status: { in: ['submitted', 'running'] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  async update(jobId: string, updates: UpdateJobRequest): Promise<ComputeJob> {
    const client = await this.getClient()
    const data: Parameters<typeof client.computeJob.update>[0]['data'] = {}

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
    // Phase 3b harvest fields
    if (updates.harvestedAt !== undefined) data.harvestedAt = updates.harvestedAt
    if ('harvestError' in updates) data.harvestError = updates.harvestError
    if ('leftOnRemote' in updates) data.leftOnRemote = updates.leftOnRemote
    if ('notifiedAt' in updates) data.notifiedAt = updates.notifiedAt
    if ('notificationConsumedAt' in updates)
      data.notificationConsumedAt = updates.notificationConsumedAt

    const row = await client.computeJob.update({ where: { id: jobId }, data })
    return toJob(row)
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
      where: { providerId, status: { in: ['submitted', 'running'] } }
    })
    return count > 0
  }

  // Returns jobs for a session that have been notified (notifiedAt set) but not yet consumed
  // (notificationConsumedAt null). Used by the renderer at session load time to find jobs that
  // need an analysis turn (issue 05: restart recovery path).
  async findPendingNotifications(sessionId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        sessionId,
        notifiedAt: { not: null },
        notificationConsumedAt: null
      },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toJob)
  }

  // Marks a batch of jobs as notification-consumed by setting notificationConsumedAt to now.
  // Idempotent — already-consumed jobs are unaffected by the where clause.
  async markNotificationsConsumed(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return
    const client = await this.getClient()
    await client.computeJob.updateMany({
      where: {
        id: { in: jobIds },
        notificationConsumedAt: null
      },
      data: { notificationConsumedAt: new Date() }
    })
  }
}

export { toJob }
export type { ComputeJobClient, ComputeJobClientProvider }
