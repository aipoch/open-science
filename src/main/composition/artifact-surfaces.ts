import {
  createArtifactReproducibilityCommands,
  type ArtifactReproducibilityCommands
} from '../artifacts/artifact-reproducibility-commands'
import { createArtifactReproducibilityDependencies } from './artifact-reproducibility'
import type { ArtifactReproducibilityCheckState } from '../../shared/artifact-reproducibility'
import {
  createArtifactElectronSurface,
  createSessionPersistenceElectronSurface,
  createUploadElectronSurface
} from '../desktop-surface-declarations'

import type { ArtifactFile } from '../../shared/artifacts'
import { createAcpRuntime } from '../acp/runtime-composition'
import { ArchiveCoordinator } from '../archive/coordinator'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { ArtifactCodeReconstructionService } from '../artifacts/code-reconstruction'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  type ArtifactHandlers
} from '../artifacts/ipc'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { BackgroundResultDeliveryOwner } from '../background-result-delivery/owner'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { ipcMainHandle } from '../ipc-handler-registry'

import { createLogger, errorLogFields } from '../logger'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { NotebookInputRegistry } from '../notebook/input-registry'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { PdfAnnotationService } from '../pdf-annotations/service'
import { SessionDeletionOwner } from '../session-deletion/owner'
import { createSessionDetailsOwner } from '../session-details/owner'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import {
  coordinateSessionPersistenceWithProjectDeletions,
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlersWithAttributionAuthority
} from '../session-persistence/ipc'
import { RuntimeWriterOwner } from '../session-persistence/runtime-writer'
import { withDataRootWrite } from '../storage/migration-state'
import { createUploadCommandOwner } from '../uploads/command-owner'

export function composeArtifactSurfaces({
  reportReproducibilityCheck,
  surfaceAdapters,
  declareElectronAdapter,
  storageLog,
  managedFileVersionService,
  backgroundResultDelivery,
  sessionRepository,
  artifactRepository,
  artifactProvenanceRepository,
  artifactRunRegistry,
  artifactHandlersRef,
  notebookInputRegistry,
  artifactReproducibilityAttemptOwnerRef,
  sessionPersistenceCoordinator,
  pdfAnnotationService,
  uploadCommandOwner,
  reviewRepository,
  archiveCoordinator,
  sessionPersistenceBackend,
  notebookService,
  delegatedWork,
  runtime,
  codeReconstruction,
  sessionPersistenceHandlers,
  sessionDetailsOwner,
  onArtifactsPublished,
  translate
}: {
  reportReproducibilityCheck:
    ((clientId: string, state: ArtifactReproducibilityCheckState) => void) | undefined
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  storageLog: ReturnType<typeof createLogger>
  managedFileVersionService: ManagedFileVersionService
  backgroundResultDelivery: BackgroundResultDeliveryOwner
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  artifactRepository: ReturnType<typeof createDefaultArtifactRepository>
  artifactProvenanceRepository: ArtifactProvenanceRepository
  artifactRunRegistry: ArtifactRunRegistry
  artifactHandlersRef: { current: ArtifactHandlers | undefined }
  notebookInputRegistry: NotebookInputRegistry
  artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  }
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    'retryArtifactFinalization' | 'commitRecoveredArtifactReferences' | 'runSessionMutation'
  >
  pdfAnnotationService: PdfAnnotationService
  uploadCommandOwner: ReturnType<typeof createUploadCommandOwner>
  reviewRepository: ReturnType<typeof createDefaultReviewRepository>
  archiveCoordinator: ArchiveCoordinator
  sessionPersistenceBackend: ReturnType<typeof coordinateSessionPersistenceWithProjectDeletions>
  notebookService: NotebookRuntimeService
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
  runtime: ReturnType<typeof createAcpRuntime>
  codeReconstruction: ArtifactCodeReconstructionService
  sessionPersistenceHandlers: ReturnType<
    typeof createSessionPersistenceHandlersWithAttributionAuthority
  >
  sessionDetailsOwner: ReturnType<typeof createSessionDetailsOwner>
  onArtifactsPublished?: (artifacts: readonly ArtifactFile[]) => Promise<void>
  translate: import('../locale/main-process-messages').NativeTranslator
}): {
  reproducibilityCommands: ArtifactReproducibilityCommands
  artifactHandlers: ReturnType<typeof createArtifactHandlers>
  sessionDeletionOwner: SessionDeletionOwner
  runtimeWriter: RuntimeWriterOwner
} {
  const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
    onPublished: (artifacts) => {
      for (const artifact of artifacts) {
        if (
          !artifact.projectId ||
          !artifact.artifactId ||
          !artifact.versionId ||
          !(artifact.mimeType === 'application/pdf' || artifact.name.toLowerCase().endsWith('.pdf'))
        )
          continue
        void pdfAnnotationService
          .importNative({
            operationId: crypto.randomUUID(),
            projectId: artifact.projectId,
            sessionId: artifact.sessionId,
            sourceKind: 'artifact-version',
            sourceFileId: artifact.artifactId,
            versionId: artifact.versionId
          })
          .catch((error) =>
            storageLog.warn('Native PDF annotation import failed', errorLogFields(error))
          )
      }
      // The handler invokes this after activation and after releasing its Session mutation.
      // Start tracked reconciliation without delaying or failing the completed publication.
      void onArtifactsPublished?.(artifacts).catch((error) =>
        storageLog.warn('Managed output publication reconciliation failed', errorLogFields(error))
      )
    },
    provenance: artifactProvenanceRepository,
    openLatestManagedFile: (request) =>
      managedFileVersionService.openLatest({
        source: 'artifact',
        projectId: request.projectId!,
        fileId: request.fileId!
      }),
    openManagedFileVersion: (request) =>
      managedFileVersionService.openVersion(
        { source: 'artifact', projectId: request.projectId!, fileId: request.fileId! },
        request.versionId
      ),
    codeReconstruction,
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
    commitRecoveredArtifacts: (request, artifacts) =>
      sessionPersistenceCoordinator.commitRecoveredArtifactReferences(request, artifacts),
    recoverPendingArtifacts: (request) =>
      sessionPersistenceCoordinator.retryArtifactFinalization(request)
  })
  artifactHandlersRef.current = artifactHandlers
  const reproducibilityCommands = createArtifactReproducibilityCommands(
    () => {
      const owner = artifactReproducibilityAttemptOwnerRef.current
      if (!owner) throw new Error('Artifact reproducibility lifecycle is not configured.')
      return owner
    },
    createArtifactReproducibilityDependencies({
      artifactRepository,
      artifactRunRegistry,
      artifactProvenanceRepository,
      artifactHandlers,
      artifactReproducibilityAttemptOwnerRef,
      archiveCoordinator,
      sessionPersistenceCoordinator,
      notebookService,
      translate
    }),
    (clientId, state) => reportReproducibilityCheck?.(clientId, state)
  )
  surfaceAdapters.push(
    createArtifactElectronSurface({
      reproducibilityCommands,
      artifactRepository,
      artifactRunRegistry,
      artifactProvenanceRepository,
      artifactHandlers,
      artifactReproducibilityAttemptOwnerRef,
      archiveCoordinator,
      sessionPersistenceCoordinator,
      notebookService,
      translate
    })
  )
  surfaceAdapters.push(createUploadElectronSurface(uploadCommandOwner))
  declareElectronAdapter('notebook-input-preview', () => {
    ipcMainHandle('notebook:read-input-preview', (_event, request) =>
      notebookInputRegistry.readPreview(request)
    )
  })
  const sessionDeletionOwner = new SessionDeletionOwner({
    runtime,
    backgroundResults: backgroundResultDelivery,
    withStoppedWork: (request, operation) => {
      const owner = artifactReproducibilityAttemptOwnerRef.current
      return owner
        ? owner.withSessionStopped(request.projectId, request.sessionId, operation)
        : operation()
    },
    withAdmission: (request, work) =>
      archiveCoordinator.withSessionDeletionAdmissionById(request.sessionId, work),
    persistence: {
      deleteSession: (request) =>
        withDataRootWrite(() =>
          sessionPersistenceBackend.deleteSession(request.projectId, request.sessionId)
        )
    }
  })
  const runtimeWriter = new RuntimeWriterOwner()
  surfaceAdapters.push(
    createSessionPersistenceElectronSurface({
      runtimeWriter,
      sessionPersistenceBackend,
      reviewRepository,
      sessionPersistenceHandlers,
      sessionDetailsOwner,
      delegatedWork,
      sessionRepository
    })
  )
  return { artifactHandlers, sessionDeletionOwner, runtimeWriter, reproducibilityCommands }
}
