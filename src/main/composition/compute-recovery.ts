import {
  createLogger,
  diagnosticErrorFields,
  errorLogFields,
  type DiagnosticOperation
} from '@aipoch/diagnostics/node'
import { hasImmutableExecutionFileEvidenceReference } from '../../shared/execution-file-evidence'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { broadcastJobUpdated, createComputeIpcModule, toJobSummary } from '../compute/ipc'
import { createComputeJobRuntime } from '../compute/job-runtime'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import {
  reconcileComputeJobFileEvidence,
  recoverPublishedComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'
import { resolveDataRoot } from '../storage-root'

export async function composeComputeRecovery({
  markComputeResultAuthorityReady,
  computeJobResultDelivery,
  computeIpcModule,
  computeService,
  connectionBroker,
  jobDeletionOwner,
  jobRepository,
  operationRepository,
  hostRepository,
  beginStartupProjection,
  dataRoot,
  modules,
  composition
}: {
  markComputeResultAuthorityReady: () => void
  computeJobResultDelivery: ComputeJobResultDeliveryAdapter
  computeIpcModule: ReturnType<typeof createComputeIpcModule>
  computeService: ReturnType<typeof createComputeIpcModule>['computeService']
  connectionBroker: import('../compute/connection-broker').ComputeConnectionBroker
  jobDeletionOwner: import('@aipoch/compute/node').ComputeJobDeletionOwner
  jobRepository: import('../compute/job-repository').ComputeJobRepository
  operationRepository: import('../compute/compute-job-operation-repository').ComputeJobOperationRepository
  hostRepository: import('../compute/repository').ComputeHostRepository
  beginStartupProjection: () => Promise<unknown>
  dataRoot: ReturnType<typeof resolveDataRoot>
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<void> {
  // Start the JobPoller wired to the shared broadcaster only after Project runtime quiescence and
  // Side Chat ownership are available. Session Details recovery is local to the Session the user
  // opens, so idle history does not participate in startup readiness.
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
        onCancellationFailed: async (job, failure) => {
          const host = await hostRepository.get(job.provider_id).catch(() => null)
          await computeJobResultDelivery.observeCancellationFailure(
            await toJobSummary(job, host?.displayName ?? job.provider_id, dataRoot),
            failure
          )
        },
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
      let disposed = false
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
          // Session catalog hydration owns Compute Host access reconciliation. Start it in the
          // background so a large historical catalog cannot delay backend readiness, then start
          // polling after that shared load has completed.
          void (async () => {
            try {
              await beginStartupProjection()
            } catch (error) {
              createLogger('compute:session-hydration').warn(
                'Session catalog hydration failed; Compute polling will continue.',
                diagnosticErrorFields(error)
              )
            }
            if (!disposed) await jobPoller.start()
          })().catch((error) => {
            createLogger('compute:job-polling').warn(
              'Compute polling startup failed.',
              diagnosticErrorFields(error)
            )
          })
        },
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        dispose: async () => {
          disposed = true
          await jobPoller.stop()
        }
      }
    }
  )
  composition.phase('compute-runtime-ready')
}
