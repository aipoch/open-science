import type {
  ComputeJob,
  ComputeJobCancellationStatus,
  JobStatusResult
} from '../../shared/compute'

export const projectJobStatus = (
  job: ComputeJob,
  cancellationStatus: ComputeJobCancellationStatus | undefined
): JobStatusResult => ({
  job_id: job.job_id,
  status: job.status,
  cancellation_status: cancellationStatus,
  exit_code: job.exit_code,
  stdout_tail: job.stdout_tail,
  stderr_tail: job.stderr_tail,
  remote_workdir: job.remote_workdir,
  harvest_error: job.harvest_error
})
