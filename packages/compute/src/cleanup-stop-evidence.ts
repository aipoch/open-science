import type { ComputeJob } from './model'
import { parseRemoteJobWorkdir } from './remote-job-handle'

type CleanupIdentity = Pick<
  ComputeJob,
  | 'job_id'
  | 'provider_id'
  | 'project_id'
  | 'session_id'
  | 'created_at'
  | 'command_hash'
  | 'execution_mode'
  | 'remote_workdir'
  | 'remote_handle'
  | 'last_poll_error'
>

const PREFIX = 'remote_cleanup_stopped_v1:'

// This is proof of stopped execution, never proof that files were removed. It survives polling,
// cancellation settlement and process restart, but is invalidated by a changed execution identity.
export const createCleanupStopEvidence = (job: CleanupIdentity, workdir: string): string =>
  PREFIX +
  JSON.stringify([
    job.job_id,
    job.provider_id,
    job.project_id,
    job.session_id,
    job.created_at,
    job.command_hash,
    job.execution_mode ?? 'direct_ssh',
    job.remote_workdir ?? null,
    job.remote_handle ?? null,
    workdir
  ])

export const hasCleanupStopEvidence = (job: CleanupIdentity, workdir?: string): boolean => {
  if (!job.last_poll_error?.startsWith(PREFIX)) return false
  try {
    const values: unknown = JSON.parse(job.last_poll_error.slice(PREFIX.length))
    if (!Array.isArray(values) || typeof values[9] !== 'string') return false
    const recordedWorkdir = values[9]
    return (
      parseRemoteJobWorkdir(job.job_id, recordedWorkdir) !== null &&
      (workdir === undefined || recordedWorkdir === workdir) &&
      job.last_poll_error === createCleanupStopEvidence(job, recordedWorkdir)
    )
  } catch {
    return false
  }
}
