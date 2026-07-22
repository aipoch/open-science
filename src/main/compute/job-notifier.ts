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

import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './harvest-engine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobNotifierDeps = {
  jobRepository: Pick<ComputeJobRepository, 'update'>
  hostRepository: Pick<ComputeHostRepository, 'get'>
  storageRoot: string
  // Injectable broadcast function; defaults to the production broadcastJobUpdated.
  // Injected in tests to capture the emitted summary without touching Electron IPC.
  broadcast: (summary: JobSummary) => void
}

// The compute_done payload fields embedded into the JobSummary broadcast (spec §11.3).
export type ComputeDonePayload = {
  featured_files: string[]
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
  const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
  const featuredDir = join(harvestDir, 'featured')

  // Workspace root for computing relative paths (everything under <workspaceCwd>).
  // getJobHarvestDir returns <workspaceCwd>/hpc/<jobId>, so two levels up is workspaceCwd.
  const workspaceCwd = join(harvestDir, '..', '..')

  // Scan featured dir — may not exist for error jobs or if harvest failed before creating it.
  let featuredFiles: string[] = []
  try {
    const entries = await readdirRecursive(featuredDir)
    featuredFiles = entries.map((abs) => relative(workspaceCwd, abs))
  } catch {
    // Directory does not exist or is unreadable — emit empty list (execution-error / harvest_failed
    // before any files were pulled). This is correct per design §8 and the acceptance criteria.
  }

  // Parse left_on_remote from the job DB column (JSON array).
  let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
  if (job.left_on_remote) {
    try {
      leftOnRemote = JSON.parse(job.left_on_remote) as typeof leftOnRemote
    } catch {
      // Malformed — treat as empty.
    }
  }

  return {
    featured_files: featuredFiles,
    featured_file_count: featuredFiles.length,
    left_on_remote_count: leftOnRemote.length,
    left_on_remote: leftOnRemote
  }
}

// ---------------------------------------------------------------------------
// Recursive readdir helper (returns absolute paths of all files)
// ---------------------------------------------------------------------------

const readdirRecursive = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await readdirRecursive(full)))
    } else {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Main emitter
// ---------------------------------------------------------------------------

/**
 * Emits a compute_done notification for a job that has reached a final resting state.
 * Idempotent: if job.notified_at is already set, returns immediately.
 *
 * Steps:
 *  1. Check idempotency guard.
 *  2. Build payload (scan harvest dir + parse leftOnRemote column).
 *  3. Write notifiedAt to DB.
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

  // Look up the host to get its displayName (fix: was using raw provider_id causing card flip).
  let displayName = job.provider_id
  try {
    const host = await hostRepository.get(job.provider_id)
    if (host) displayName = host.displayName
  } catch {
    // Transient lookup failure — fall back to provider_id so the broadcast always happens.
  }

  // Build the payload (scan harvest dir + parse leftOnRemote column).
  const payload = await buildComputeDonePayload(job, storageRoot)

  // Persist notifiedAt (inbox semantics: survives restart, design §2/§11).
  const notifiedAt = new Date()
  const updatedJob = await jobRepository.update(job.job_id, { notifiedAt })

  // Broadcast the summary with notification payload fields embedded.
  // Reuses COMPUTE_JOB_UPDATED_CHANNEL via the injected broadcast fn (no new IPC channel).
  const summary: JobSummary = {
    job_id: updatedJob.job_id,
    provider_id: updatedJob.provider_id,
    display_name: displayName,
    shape: updatedJob.shape,
    session_id: updatedJob.session_id,
    status: updatedJob.status,
    intent: updatedJob.intent,
    created_at: updatedJob.created_at,
    started_at: updatedJob.started_at,
    finished_at: updatedJob.finished_at,
    exit_code: updatedJob.exit_code,
    error_code: updatedJob.error_code,
    remote_workdir: updatedJob.remote_workdir,
    stdout_tail: updatedJob.stdout_tail,
    stderr_tail: updatedJob.stderr_tail,
    notified_at: updatedJob.notified_at,
    notification_consumed_at: updatedJob.notification_consumed_at,
    // Payload fields (spec §11.3).
    featured_files: payload.featured_files,
    featured_file_count: payload.featured_file_count,
    left_on_remote_count: payload.left_on_remote_count,
    left_on_remote: payload.left_on_remote
  }

  broadcast(summary)
}
