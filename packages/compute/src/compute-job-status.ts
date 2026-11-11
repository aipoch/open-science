import type { ComputeJob, ComputeJobCancellationStatus, JobError, JobStatusResult } from './model'
import { parseSlurmSchedulerJobId } from './remote-job-handle'

export const isComputeJobCancelled = (
  job: Pick<ComputeJob, 'status' | 'error_code' | 'cancellation_status'>
): boolean =>
  job.cancellation_status === 'cancelled' ||
  (job.status === 'failed' && job.error_code === 'job_cancelled')

export const isComputeJobResultFinal = (job: ComputeJob): boolean =>
  isComputeJobCancelled(job) ||
  job.status === 'error' ||
  ((job.status === 'success' || job.status === 'failed' || job.status === 'timeout') &&
    job.harvested_at !== undefined)

export const projectComputeJobConclusion = (
  job: Pick<
    ComputeJob,
    | 'status'
    | 'error_code'
    | 'error_message'
    | 'stderr_tail'
    | 'cancellation_status'
    | 'cancellation_error'
  >
): Pick<JobStatusResult, 'status' | 'error' | 'cancellation'> => {
  const cancelled = isComputeJobCancelled(job)
  const cancellation =
    job.cancellation_status === 'cancelling'
      ? { status: 'cancelling' as const }
      : job.cancellation_status === 'failed' &&
          job.cancellation_error &&
          (job.status === 'queued' ||
            job.status === 'submitted' ||
            job.status === 'running' ||
            job.status === 'error')
        ? { status: 'failed' as const, error: job.cancellation_error }
        : undefined
  return {
    status: cancelled ? 'cancelled' : job.status,
    ...(!cancelled && job.error_code
      ? {
          error: {
            code: job.error_code,
            message:
              job.error_message || job.stderr_tail || `Compute Job ended with ${job.error_code}.`
          }
        }
      : {}),
    ...(!cancelled && cancellation ? { cancellation } : {})
  }
}

export const projectJobStatus = (
  job: ComputeJob,
  cancellationStatus: ComputeJobCancellationStatus | undefined = job.cancellation_status,
  cancellationError: JobError | undefined = job.cancellation_error
): JobStatusResult => {
  const conclusion = projectComputeJobConclusion({
    ...job,
    cancellation_status: cancellationStatus,
    cancellation_error: cancellationError
  })
  return {
    job_id: job.job_id,
    ...(parseSlurmSchedulerJobId(job.remote_handle, job.remote_workdir)
      ? { scheduler_job_id: parseSlurmSchedulerJobId(job.remote_handle, job.remote_workdir) }
      : {}),
    ...conclusion,
    ...(job.last_poll_error ? { last_poll_error: job.last_poll_error } : {}),
    result_final: conclusion.status === 'cancelled' || isComputeJobResultFinal(job),
    exit_code: job.exit_code,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    remote_workdir: job.remote_workdir,
    harvest_error: job.harvest_error
  }
}
