import { getManualStagedCleanup } from './manual-staged-cleanup'
import { createComputeExecution, parseSlurmSchedulerJobId } from '@aipoch/compute/node'
/**
 * job-notifier.ts — emits compute_done notifications for finished jobs.
 *
 * Triggered from three terminal outcomes (design §8):
 *  1. harvest_clean: harvestedAt set, harvestError null
 *  2. harvest_failed: harvestedAt set, harvestError non-null
 *  3. execution error: status='error' (dispatch never succeeded, no harvest dir)
 *
 * This module is EMIT-ONLY (design §2):
 *  - writes notifiedAt to DB (persistent inbox, survives restart)
 *  - broadcasts updated JobSummary via broadcastJobUpdated (reuses COMPUTE_JOB_UPDATED_CHANNEL)
 *  - does NOT write notificationConsumedAt (that belongs to issue 05 renderer-side)
 *  - does NOT start any analysis turn or wait-broker
 *
 * Idempotency: if job.notified_at is already set, returns immediately without re-emitting.
 *
 * Payload shape aligns with spec §11.3:
 *  { job_id, provider_id, status, exit_code,
 *    featured_files, featured_file_count,
 *    left_on_remote_count, left_on_remote }
 *
 * Paths are workspace-relative (hpc/<jobId>/featured/...) per design §4.
 */

import { externalComputeMode, type ComputeJob, type JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { listArchivedJobFiles } from './workspace-path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobNotifierDeps = {
  jobRepository: Pick<ComputeJobRepository, 'claimNotification'>
  hostRepository: Pick<ComputeHostRepository, 'get'> &
    Partial<Pick<ComputeHostRepository, 'getComputeTarget'>>
  storageRoot: string
  // Injectable broadcast function; defaults to the production broadcastJobUpdated.
  // Injected in tests to capture the emitted summary without touching Electron IPC.
  broadcast: (summary: JobSummary) => void
}

// The compute_done payload fields embedded into the JobSummary broadcast (spec §11.3).
export type ComputeDonePayload = {
  featured_files: string[]
  hidden_files: string[]
  featured_file_count: number
  left_on_remote_count: number
  left_on_remote: Array<{ uri: string; size_mb: number; reason: string }>
}

// ---------------------------------------------------------------------------
// Payload builder: scans the harvest directory for featured files
// ---------------------------------------------------------------------------

/**
 * Scans the job's local harvest directory and builds the compute_done payload.
 * Returns empty arrays if the directory does not exist (e.g. execution-error jobs).
 *
 * featured_files: relative paths under hpc/<jobId>/featured/ (workspace-relative).
 * featured_file_count: total featured file count (scandir).
 * left_on_remote_count / left_on_remote: from job.left_on_remote JSON column.
 */
export const buildComputeDonePayload = async (
  job: ComputeJob,
  storageRoot: string
): Promise<ComputeDonePayload> => {
  const files = await listArchivedJobFiles(job, storageRoot)
  // Parse left_on_remote from the job DB column (JSON array).
  let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
  if (job.left_on_remote) {
    try {
      const parsed = JSON.parse(job.left_on_remote)
      if (Array.isArray(parsed)) leftOnRemote = parsed
    } catch {
      // Malformed — treat as empty.
    }
  }

  return {
    ...files,
    featured_file_count: files.featured_files.length,
    left_on_remote_count: leftOnRemote.length,
    left_on_remote: leftOnRemote
  }
}

// ---------------------------------------------------------------------------
export const toJobSummary = async (
  job: ComputeJob,
  displayName: string,
  storageRoot: string
): Promise<JobSummary> => {
  const payload = await buildComputeDonePayload(job, storageRoot)
  const schedulerId = parseSlurmSchedulerJobId(job.remote_handle, job.remote_workdir)
  return {
    manualStagedCleanup: getManualStagedCleanup(job),
    job_id: job.job_id,
    provider_id: job.provider_id,
    display_name: displayName,
    shape: job.shape,
    execution_mode:
      job.execution_mode ??
      externalComputeMode(job.provider_id) ??
      (job.provider_id.startsWith('ssh:') && schedulerId ? 'slurm' : undefined),
    session_id: job.session_id,
    project_id: job.project_id,
    status: job.status,
    raw_status: job.raw_status,
    integrity_issues: job.integrity_issues,
    needs_attention: job.needs_attention,
    cancellation_status: job.cancellation_status,
    cancellation_error: job.cancellation_error,
    cancellation_revision: job.cancellation_revision,
    scheduler_job_id: schedulerId,
    intent: job.intent,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    exit_code: job.exit_code,
    error_code: job.error_code,
    error_message: job.error_message,
    last_poll_error: job.last_poll_error,
    remote_workdir: job.remote_workdir,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    // Phase 3b notification inbox timestamps (issue 06).
    notified_at: job.notified_at,
    notification_consumed_at: job.notification_consumed_at,
    analysis_state: job.analysis_state,
    analysis_message_id: job.analysis_message_id,
    analysis_updated_at: job.analysis_updated_at,
    // Phase 3b compute_done payload fields (spec §11.3).
    ...payload,
    harvest_error: job.harvest_error ?? undefined,
    harvested_at: job.harvested_at
  }
}

// Main emitter
// ---------------------------------------------------------------------------

/**
 * Emits a compute_done notification for a job that has reached a final resting state.
 * Idempotent: if job.notified_at is already set, returns immediately.
 *
 * Steps:
 *  1. Check idempotency guard.
 *  2. Claim notification delivery and read the current row.
 *  3. Build payload from that claimed row (scan harvest dir + parse leftOnRemote column).
 *  4. Broadcast updated job summary (carrying payload fields + notified_at).
 *
 * This is EMIT-ONLY — does not touch notificationConsumedAt (issue 05).
 */
export const emitJobNotification = async (
  job: ComputeJob,
  deps: JobNotifierDeps
): Promise<void> => {
  const { jobRepository, hostRepository, storageRoot, broadcast } = deps

  // Idempotency: do not re-emit if already notified.
  if (job.notified_at != null) return

  // Persist notifiedAt as a compare-and-set claim. Every notification entrance uses this seam, so
  // overlapping stale projections cannot both broadcast. The returned row is also the freshness
  // fence for every field used below: a caller may have entered with a pre-harvest projection.
  const notifiedAt = new Date()
  const updatedJob = await jobRepository.claimNotification(job.job_id, notifiedAt)
  if (!updatedJob) return

  // Look up the host to get its displayName (fix: was using raw provider_id causing card flip).
  let displayName = updatedJob.provider_id
  try {
    const host = hostRepository.getComputeTarget
      ? await hostRepository.getComputeTarget(updatedJob.provider_id)
      : await hostRepository.get(updatedJob.provider_id)
    if (host) displayName = host.displayName
  } catch {
    // Transient lookup failure — fall back to provider_id so the broadcast always happens.
  }

  broadcast(await toJobSummary(updatedJob, displayName, storageRoot))
}

/** Attach the host's durable notification claim, file projection and renderer delivery. */
export const createNotifyingJobPoller = (
  deps: Omit<import('@aipoch/compute/node').JobPollerDeps, 'notifyJob'> & {
    jobRepository: ComputeJobRepository
    hostRepository: ComputeHostRepository
    execution?: import('@aipoch/compute/node').ComputeExecution
    storageRoot?: string
    broadcast?: (summary: JobSummary) => void
  }
): import('@aipoch/compute/node').JobPoller =>
  (deps.execution ?? createComputeExecution()).createPoller({
    ...deps,
    notifyJob:
      deps.broadcast && deps.storageRoot
        ? (job) =>
            emitJobNotification(job, {
              jobRepository: deps.jobRepository,
              hostRepository: deps.hostRepository,
              storageRoot: deps.storageRoot!,
              broadcast: deps.broadcast!
            })
        : undefined
  })
