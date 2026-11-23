import {
  NotebookExecutionIntent,
  notebookExecutionIntent,
  notebookUserOperation
} from '../notebook/execution-intent'
import type {
  ArtifactReproducibilityCheckRequest,
  GetArtifactReproducibilityCheckLogRequest,
  ListArtifactReproducibilityReceiptsRequest
} from '../../shared/artifact-reproducibility'
import {
  APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
  type ApplicationModuleBuilder
} from '../application-runtime'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import {
  appendArtifactReproducibilityReceipt,
  getArtifactReproducibilityCheckLog,
  listArtifactReproducibilityReceipts,
  pruneArtifactReproducibilityOutputs,
  recordFailedArtifactReproducibilityAttempt,
  retainArtifactReproducibilityOutput,
  type ArtifactReproducibilityCheckLogDraft,
  type ArtifactReproducibilityFailedAttemptDraft,
  type ArtifactReproducibilityReceiptDraft
} from '../artifacts/artifact-reproducibility-receipts'
import { readArtifactReproducibilityExecutionEvidence } from '../artifacts/provenance-reproducibility-execution-evidence'
import { BackendShutdownOutcomeError, QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import type { composeHandoff } from './handoff'
import type { composeManagedFiles } from './managed-files'
import type { composeSessionAuthority } from './session-authority'
import type { composeSettingsBootstrap } from './settings-bootstrap'
import type { NotebookRuntimeService } from '../notebook/runtime-service'

export async function composeBackendLifecycle({
  settingsBootstrap,
  managedFiles,
  sessionAuthority,
  backendTeardownOwnedByCoordinator,
  handoff,
  notebookService,
  modules
}: {
  settingsBootstrap: Awaited<ReturnType<typeof composeSettingsBootstrap>>
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  backendTeardownOwnedByCoordinator: { current: boolean }
  handoff: Awaited<ReturnType<typeof composeHandoff>>
  notebookService: Pick<
    NotebookRuntimeService,
    'createExecutionAdmission' | 'createExecutionIntent' | 'refreshResourceActivity'
  >
  modules: ApplicationModuleBuilder
}): Promise<void> {
  // The shared coordinator remains the sole ACP + Notebook teardown owner.
  // It also coordinates Side Chat suspension/shutdown. Register command routing after it so reverse
  // disposal removes adapters, then the router, before any underlying owner stops.
  await modules.add(
    { shutdownCoordinator: handoff.shutdownCoordinator },
    ({ shutdownCoordinator: coordinator }) => ({
      name: 'backend-shutdown-coordinator',
      capability: undefined,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS + APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
      dispose: async () => BackendShutdownOutcomeError.assertClean(await coordinator.runForQuit())
    })
  )
  backendTeardownOwnedByCoordinator.current = true
  sessionAuthority.artifactReproducibilityAttemptOwnerRef.current = await modules.add(
    {
      storageRoot: resolveDataRoot(),
      onResourcesChanged: () => notebookService.refreshResourceActivity(),
      processSandbox: settingsBootstrap.notebookNetworkSandbox,
      prepareExecutionIntent: (
        request:
          | ArtifactReproducibilityCheckRequest
          | import('../../shared/session-reproducibility').SessionReproducibilityCommand
      ) => {
        const inherited = notebookExecutionIntent(request)
        if (inherited) return inherited
        const scope = { projectId: request.projectId, sessionId: request.appSessionId }
        const operation = notebookUserOperation(request)
        if (operation) {
          operation.assertCurrent()
          return notebookService.createExecutionIntent(scope)
        }
        const missing = new NotebookExecutionIntent(scope)
        missing.block('originating-execution-context-unavailable')
        return missing
      },
      createExecutionAdmission: (
        request: ArtifactReproducibilityCheckRequest,
        signal?: AbortSignal,
        intent?: NotebookExecutionIntent
      ) =>
        notebookService.createExecutionAdmission(
          signal,
          undefined,
          {
            projectId: request.projectId,
            sessionId: request.appSessionId,
            source: 'reproduction'
          },
          intent
        ),
      retainOutput: (request: ArtifactReproducibilityCheckRequest, bytes: Buffer) =>
        retainArtifactReproducibilityOutput(
          managedFiles.artifactProvenanceRepository,
          request,
          bytes
        ),
      pruneOutputs: (request: ArtifactReproducibilityCheckRequest) =>
        pruneArtifactReproducibilityOutputs(managedFiles.artifactProvenanceRepository, request),
      loadExecution: (request: ArtifactReproducibilityCheckRequest) =>
        readArtifactReproducibilityExecutionEvidence(
          managedFiles.artifactProvenanceRepository,
          request
        ),
      persistReceipt: (
        request: ArtifactReproducibilityCheckRequest,
        receipt: ArtifactReproducibilityReceiptDraft,
        checkLog: ArtifactReproducibilityCheckLogDraft
      ) =>
        appendArtifactReproducibilityReceipt(
          managedFiles.artifactProvenanceRepository,
          request,
          receipt,
          checkLog
        ),
      persistFailure: (
        request: ArtifactReproducibilityCheckRequest,
        attempt: ArtifactReproducibilityFailedAttemptDraft,
        checkLog: ArtifactReproducibilityCheckLogDraft
      ) =>
        recordFailedArtifactReproducibilityAttempt(
          managedFiles.artifactProvenanceRepository,
          request,
          attempt,
          checkLog
        ),
      listReceipts: (request: ListArtifactReproducibilityReceiptsRequest) =>
        listArtifactReproducibilityReceipts(managedFiles.artifactProvenanceRepository, request),
      getCheckLog: (request: GetArtifactReproducibilityCheckLogRequest) =>
        getArtifactReproducibilityCheckLog(managedFiles.artifactProvenanceRepository, request),
      withStorageLease: withDataRootWrite
    },
    (dependencies) => {
      const owner = new ArtifactReproducibilityAttemptOwner(dependencies)
      return {
        name: 'artifact-reproducibility-lifecycle',
        capability: owner,
        dispose: () => owner.dispose()
      }
    }
  )
}
