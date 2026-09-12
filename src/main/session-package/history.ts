import type { PrismaClient } from '@prisma/client'
import type { SessionPackageRequest } from '../../shared/session-package'
import { FileTaskRunJournal } from '../tasks/task-run-journal'
import { ComputeJobRepository } from '../compute/job-repository'

import { packageHistorySchema, type PackageHistory } from './history-schema'
export { packageHistorySchema, type PackageHistory } from './history-schema'

// Evidence only: no Task journal entries, Compute jobs, grants, host identities, remote handles,
// notification cursors or cleanup operations are installed on the receiving computer.
export const capturePackageHistory = async (
  configRoot: string,
  getClient: () => Promise<PrismaClient>,
  request: SessionPackageRequest
): Promise<PackageHistory> => {
  const tasks = (await new FileTaskRunJournal(configRoot).load()).filter(
    (run) => run.projectId === request.projectId && run.sessionId === request.sessionId
  )
  const jobs = await new ComputeJobRepository(getClient).findByOwner(request)
  if (
    tasks.some((run) => run.status === 'running') ||
    jobs.some(
      (job) =>
        job.raw_status ||
        (!['success', 'failed', 'timeout', 'error'].includes(job.status) &&
          job.cancellation_status !== 'cancelled')
    )
  )
    throw new Error('Wait for Task and Compute work to finish before exporting.')
  return packageHistorySchema.parse({
    taskRuns: tasks.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      cancelledAt: run.cancelledAt,
      output: run.output,
      error: run.error
    })),
    computeJobs: jobs.map((job) => ({
      id: job.job_id,
      status: job.status,
      cancelled: job.cancellation_status === 'cancelled',
      shape: job.shape,
      intent: job.intent,
      command: job.command,
      commandHash: job.command_hash,
      environment: job.environment,
      resources: job.resource_request,
      inputManifest: job.input_manifest,
      outputManifest: job.output_manifest,
      producerRunId: job.producer_run_id,
      fileEvidence: job.file_evidence,
      stdout: job.stdout_tail,
      stderr: job.stderr_tail,
      exitCode: job.exit_code,
      error: job.error_code,
      leftOnRemote: job.left_on_remote,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      protectedContentUnavailable:
        job.integrity_issues?.some((issue) => issue.code === 'sensitive-fields-unavailable') ??
        false
    }))
  })
}
