import {
  createComputeExecution,
  type ComputeExecution,
  type DispatcherDeps
} from '@aipoch/compute/node'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { hasImmutableExecutionFileEvidenceReference } from '../../shared/execution-file-evidence'
import {
  cleanupComputeJobFileEvidence,
  publishComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'
import { decodeDataPath } from '../storage/data-path'
import type { ComputeJobRepository } from './job-repository'
const log = createLogger('compute')
export const finalizeDispatchErrorEvidence = async (
  jobId: string,
  deps: { storageRoot: string; jobRepository: ComputeJobRepository }
): Promise<void> => {
  if (!deps.storageRoot) return
  const job = await deps.jobRepository.get(jobId).catch(() => null)
  if (!job || job.status !== 'error') return
  if (hasImmutableExecutionFileEvidenceReference(job.file_evidence)) return
  const remoteInputPaths: string[] = []
  if (job.input_manifest) {
    try {
      const entries = JSON.parse(job.input_manifest) as Array<{
        kind?: string
        remotePath?: string
      }>
      for (const entry of entries) {
        if (entry.kind === 'symlink' && entry.remotePath) remoteInputPaths.push(entry.remotePath)
      }
    } catch {
      // New manifests are validated; malformed historical rows remain evidence-unknown.
    }
  }
  try {
    const fileEvidence = await publishComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      outputs: [],
      remoteInputPaths,
      reasonCodes: ['harvest-incomplete', 'remote-output-not-harvested']
    })
    await deps.jobRepository.update(jobId, { fileEvidence })
    await settleComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      fileEvidence
    }).catch((error) =>
      log.warn('Compute Job file-evidence receipt remains for startup recovery.', {
        jobId,
        ...errorLogFields(error)
      })
    )
  } catch {
    const persisted = await deps.jobRepository.get(jobId).catch(() => null)
    if (persisted && !hasImmutableExecutionFileEvidenceReference(persisted.file_evidence)) {
      await cleanupComputeJobFileEvidence({
        storageRoot: deps.storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId,
        preservePublished: true
      }).catch(() => undefined)
    }
  }
}

/** Resolve frozen input receipts and settle Notebook evidence at the host storage boundary. */
export const dispatchComputeJob = (
  jobId: string,
  deps: Omit<DispatcherDeps, 'resolveInputPath' | 'finalizeDispatchError'> & {
    jobRepository: ComputeJobRepository
    storageRoot?: string
    execution?: ComputeExecution
  }
): Promise<void> =>
  (deps.execution ?? createComputeExecution()).dispatchJob(jobId, {
    ...deps,
    resolveInputPath: (path) => decodeDataPath(path, deps.storageRoot)!,
    finalizeDispatchError: deps.storageRoot
      ? (id) =>
          finalizeDispatchErrorEvidence(id, {
            storageRoot: deps.storageRoot!,
            jobRepository: deps.jobRepository
          })
      : undefined
  })
