import { hasImmutableExecutionFileEvidenceReference } from '../../shared/execution-file-evidence'
import type { LoadAllSessionsResult } from '../../shared/session-persistence'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { broadcastJobUpdated, createComputeIpcModule, toJobSummary } from '../compute/ipc'
import { createComputeJobRuntime } from '../compute/job-runtime'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import {
  reconcileComputeJobFileEvidence,
  recoverPublishedComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'
import { selectSessionDetailsStartupCandidates } from '../session-details/startup-catalog'
import { resolveDataRoot } from '../storage-root'

export async function composeComputeRecovery({
  markComputeResultAuthorityReady,
  computeJobResultDelivery,
  loadAllSessions,
  startupSessionDetails,
  computeIpcModule,
  computeService,
  connectionBroker,
  jobDeletionOwner,
  jobRepository,
  operationRepository,
  hostRepository,
  dataRoot,
  modules,
  composition
}: {
  markComputeResultAuthorityReady: () => void
  computeJobResultDelivery: ComputeJobResultDeliveryAdapter
  loadAllSessions: () => Promise<LoadAllSessionsResult>
  startupSessionDetails: { current: LoadAllSessionsResult['sessions'] | undefined }
  computeIpcModule: ReturnType<typeof createComputeIpcModule>
  computeService: ReturnType<typeof createComputeIpcModule>['computeService']
  connectionBroker: import('../compute/connection-broker').ComputeConnectionBroker
  jobDeletionOwner: import('../compute/job-deletion-owner').ComputeJobDeletionOwner
  jobRepository: import('../compute/job-repository').ComputeJobRepository
  operationRepository: import('../compute/compute-job-operation-repository').ComputeJobOperationRepository
  hostRepository: import('../compute/repository').ComputeHostRepository
  dataRoot: ReturnType<typeof resolveDataRoot>
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<void> {
  // Start the JobPoller wired to the shared broadcaster only after Project runtime quiescence and
  // Side Chat ownership are available. Queue startup loads the Session catalog, which may first need
  // to finish a pending Project deletion through those owners before restoring concurrency limits.
  await modules.add(
    {
      computeService,
      connectionBroker,
      jobDeletionOwner,
      hostRepository,
      jobRepository,
      operationRepository,
      storageRoot: dataRoot
    },
    (dependencies) => {
      const jobPoller = createComputeJobRuntime(dependencies, {
        broadcast: (summary) => {
          void (async () => {
            let owned = false
            try {
              await computeJobResultDelivery.observeNotification(summary)
              owned = await computeJobResultDelivery.hasDeliveryPath(summary.job_id)
            } catch (error) {
              createLogger('agent-result-delivery').warn(
                'Compute Job result delivery observation failed',
                diagnosticErrorFields(error)
              )
              return
            }
            broadcastJobUpdated(
              owned ? { ...summary, result_delivery_path: 'agent-result-delivery' } : summary
            )
          })()
        }
      })
      return {
        name: 'compute-job-runtime',
        capability: undefined,
        start: async () => {
          composition.phase('compute-file-evidence')
          try {
            const owners = await jobRepository.listOwners()
            const jobs = (
              await Promise.all(owners.map((owner) => jobRepository.findByOwner(owner)))
            ).flat()
            for (const [index, job] of jobs.entries()) {
              if (
                job.status !== 'error' ||
                hasImmutableExecutionFileEvidenceReference(job.file_evidence)
              ) {
                continue
              }
              const fileEvidence = await recoverPublishedComputeJobFileEvidence({
                storageRoot: dataRoot,
                projectId: job.project_id,
                sessionId: job.session_id,
                jobId: job.job_id,
                producerRunId: job.producer_run_id
              })
              if (!fileEvidence) continue
              const updated = await jobRepository.update(job.job_id, { fileEvidence })
              jobs[index] = updated
              await settleComputeJobFileEvidence({
                storageRoot: dataRoot,
                projectId: job.project_id,
                sessionId: job.session_id,
                jobId: job.job_id,
                producerRunId: job.producer_run_id,
                fileEvidence
              }).catch((error) =>
                createLogger('compute:file-evidence').warn(
                  'Recovered Compute Job file-evidence receipt remains for reconciliation.',
                  { jobId: job.job_id, ...errorLogFields(error) }
                )
              )
            }
            await reconcileComputeJobFileEvidence(dataRoot, jobs)
          } catch (error) {
            createLogger('compute:file-evidence').warn(
              'Compute Job file-evidence startup reconciliation failed closed.',
              diagnosticErrorFields(error)
            )
          }
          composition.phase('compute-result-delivery')
          try {
            await computeJobResultDelivery.takeOver(
              await computeIpcModule.handlers.jobsList({ nonTerminal: true })
            )
            await computeJobResultDelivery.recoverWaiting(async (jobId) => {
              const job = await jobRepository.get(jobId)
              if (!job) return undefined
              const host = await hostRepository.get(job.provider_id).catch(() => null)
              return toJobSummary(job, host?.displayName ?? job.provider_id, dataRoot)
            })
          } catch (error) {
            createLogger('agent-result-delivery').warn(
              'Compute Job result delivery recovery failed; Compute lifecycle will continue',
              diagnosticErrorFields(error)
            )
          } finally {
            markComputeResultAuthorityReady()
          }
          // Catalog hydration also restores non-Compute projections and enabled Host selections.
          // Keep those startup effects, but never make dispatch depend on catalog completeness.
          composition.phase('session-catalog')
          await Promise.all([
            jobPoller.start(),
            loadAllSessions()
              .then((catalog) => {
                startupSessionDetails.current = selectSessionDetailsStartupCandidates(catalog)
              })
              .catch((error) => {
                createLogger('session-persistence').warn(
                  'Startup Session hydration failed',
                  errorLogFields(error)
                )
              })
          ])
        },
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        dispose: () => jobPoller.stop()
      }
    }
  )
  composition.phase('compute-runtime-ready')
}
