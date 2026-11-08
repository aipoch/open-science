import type { ComputeJob, ManualStagedCleanup } from '../../shared/compute'
import { readHostedJournal } from './hugging-face-job-journal'
import { readModalJournal } from './modal-job-journal'

export function getManualStagedCleanup(job: ComputeJob): ManualStagedCleanup | undefined {
  if (
    job.remote_cleanup_disposition !== 'pending' ||
    job.started_at !== undefined ||
    job.exit_code !== undefined ||
    job.cancellation_status ||
    job.needs_attention ||
    (job.left_on_remote !== undefined && job.left_on_remote !== '[]')
  )
    return undefined

  try {
    if (
      job.execution_mode === 'hugging_face_jobs' &&
      job.status === 'error' &&
      job.error_code === 'dispatch_failed'
    ) {
      const journal = readHostedJournal(job)
      if (
        journal.launchNotStarted &&
        journal.launch &&
        !journal.launch.remoteId &&
        !journal.published &&
        !journal.discardedOutputs
      ) {
        return {
          kind: 'hugging_face_jobs',
          bucket: journal.target.bucket,
          prefix: 'open-science/' + job.job_id
        }
      }
    }
    if (
      job.execution_mode === 'modal_sandbox' &&
      job.status === 'timeout' &&
      job.error_code === 'timeout' &&
      job.harvested_at !== undefined
    ) {
      const journal = readModalJournal(job)
      // In older records, the absence of the durable create intent proves no Sandbox call was made.
      if (journal.volume?.id && !journal.sandbox && !journal.published) {
        return {
          kind: 'modal_sandbox',
          environmentName: journal.target.environmentName,
          volumeId: journal.volume.id
        }
      }
    }
  } catch {
    // Unreadable or foreign journals must not prevent displaying other jobs in the same list.
    return undefined
  }
  return undefined
}
