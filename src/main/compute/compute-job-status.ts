import type {
  ComputeJob,
  ComputeJobCancellationStatus,
  JobStatusResult
} from '../../shared/compute'
import { parseSlurmSchedulerJobId } from './remote-job-handle'

export const isComputeJobResultFinal = (job: ComputeJob): boolean =>
  job.status === 'error' ||
  ((job.status === 'success' || job.status === 'failed' || job.status === 'timeout') &&
    job.harvested_at !== undefined)

export const projectJobStatus = (
  job: ComputeJob,
  cancellationStatus: ComputeJobCancellationStatus | undefined
): JobStatusResult => ({
  job_id: job.job_id,
  ...(parseSlurmSchedulerJobId(job.remote_handle, job.remote_workdir)
    ? { scheduler_job_id: parseSlurmSchedulerJobId(job.remote_handle, job.remote_workdir) }
    : {}),
  status: job.status,
  ...(job.error_code ? { error_code: job.error_code } : {}),
  ...(job.last_poll_error ? { last_poll_error: job.last_poll_error } : {}),
  result_final: isComputeJobResultFinal(job),
  cancellation_status: cancellationStatus,
  exit_code: job.exit_code,
  stdout_tail: job.stdout_tail,
  stderr_tail: job.stderr_tail,
  remote_workdir: job.remote_workdir,
  harvest_error: job.harvest_error
})
