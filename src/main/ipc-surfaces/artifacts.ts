import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import type { ArchiveCoordinator } from '../archive/coordinator'
import { createArtifactReproducibilityReceiptExporter } from '../artifacts/artifact-reproducibility-export'
import { registerArtifactReproducibilityIpcHandlers } from '../artifacts/artifact-reproducibility-ipc'
import type { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import {
  getArtifactReproducibilityOutput,
  getArtifactReproducibilityOutputStorage,
  getArtifactReproducibilitySource,
  getArtifactReproducibilityEnvironmentLock,
  clearArtifactReproducibilityOutputs,
  getArtifactReproducibilityCheckLog,
  getArtifactReproducibilityReceipt
} from '../artifacts/artifact-reproducibility-receipts'
import { registerArtifactIpcHandlers, type ArtifactHandlers } from '../artifacts/ipc'
import {
  readArtifactReproducibilityExecutionEvidence,
  readArtifactReproducibilityOriginalOutput
} from '../artifacts/provenance-reproducibility-execution-evidence'
import type { NativeTranslator } from '../locale/main-process-messages'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { withDataRootWrite } from '../storage/migration-state'
import { resolveDataRoot } from '../storage-root'
import { publishUserFile } from '../user-file-publisher'
import { createElectronSurfaceAdapter } from './adapter'

type ArtifactOwners = {
  artifactRepository: NonNullable<Parameters<typeof registerArtifactIpcHandlers>[0]>
  artifactRunRegistry: NonNullable<Parameters<typeof registerArtifactIpcHandlers>[1]>
  artifactProvenanceRepository: NonNullable<Parameters<typeof registerArtifactIpcHandlers>[2]>
  artifactHandlers: ArtifactHandlers
  artifactReproducibilityAttemptOwnerRef: {
    readonly current?: Pick<
      ArtifactReproducibilityAttemptOwner,
      | 'start'
      | 'cancel'
      | 'cancelOwner'
      | 'getCheck'
      | 'getCheckLog'
      | 'listReceipts'
      | 'sessionCommand'
      | 'withIdleVersion'
    >
  }
  archiveCoordinator: Pick<ArchiveCoordinator, 'withSessionAvailable'>
  sessionPersistenceCoordinator: {
    runSessionMutation: NonNullable<Parameters<typeof registerArtifactIpcHandlers>[3]>
  }
  notebookService: Pick<NotebookRuntimeService, 'importEnvironmentLock'>
  translate: NativeTranslator
}

export const createArtifactElectronSurface = ({
  artifactRepository,
  artifactRunRegistry,
  artifactProvenanceRepository,
  artifactHandlers,
  artifactReproducibilityAttemptOwnerRef,
  archiveCoordinator,
  sessionPersistenceCoordinator,
  notebookService,
  translate
}: ArtifactOwners): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('artifacts', () => {
    if (!artifactReproducibilityAttemptOwnerRef.current) {
      throw new Error('Artifact reproducibility lifecycle is not configured.')
    }
    registerArtifactIpcHandlers(
      artifactRepository,
      artifactRunRegistry,
      artifactProvenanceRepository,
      (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
      artifactHandlers
    )
    const reproducibilityOwner = artifactReproducibilityAttemptOwnerRef.current
    const receiptExporter = createArtifactReproducibilityReceiptExporter({
      readSourceScope: (request) =>
        withDataRootWrite(
          async () =>
            (await getArtifactReproducibilitySource(artifactProvenanceRepository, request))
              ?.sourceScope
        ),
      readVersion: (request) =>
        withDataRootWrite(
          async () =>
            // Read metadata only; exporting a version label must not scan large Artifact contents.
            (await artifactProvenanceRepository.getLineage(request))?.selectedVersion
        ),
      readOutputStorage: (request) =>
        withDataRootWrite(() =>
          getArtifactReproducibilityOutputStorage(artifactProvenanceRepository, request)
        ),
      downloadsDirectory: () => app.getPath('downloads'),
      readOutput: (request, checksum, entityId) =>
        withDataRootWrite(() =>
          getArtifactReproducibilityOutput(
            artifactProvenanceRepository,
            request,
            checksum,
            entityId
          )
        ),
      readOriginalOutput: (request, entityId) =>
        withDataRootWrite(() =>
          readArtifactReproducibilityOriginalOutput(
            artifactProvenanceRepository,
            resolveDataRoot(),
            request,
            entityId
          )
        ),
      readExecution: (request) =>
        withDataRootWrite(() =>
          readArtifactReproducibilityExecutionEvidence(artifactProvenanceRepository, request)
        ),
      readEnvironmentLock: (lockChecksum, request) =>
        withDataRootWrite(async () => {
          if (await getArtifactReproducibilitySource(artifactProvenanceRepository, request))
            return getArtifactReproducibilityEnvironmentLock(
              artifactProvenanceRepository,
              request,
              lockChecksum
            )
          return readFile(
            join(
              resolveDataRoot(),
              'runtime',
              'provenance',
              'environment-locks',
              `${lockChecksum}.json`
            ),
            'utf8'
          ).catch((error: unknown) => {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ENOENT'
            ) {
              return undefined
            }
            throw error
          })
        }),
      readReceipt: (request, receiptChecksum) =>
        withDataRootWrite(() =>
          getArtifactReproducibilityReceipt(artifactProvenanceRepository, request, receiptChecksum)
        ),
      readCheckLog: (request) =>
        withDataRootWrite(() =>
          getArtifactReproducibilityCheckLog(artifactProvenanceRepository, request)
        ),
      showSaveDialog: (sender, options) => {
        const parentWindow = BrowserWindow.fromWebContents(sender as WebContents)
        return parentWindow
          ? dialog.showSaveDialog(parentWindow, options)
          : dialog.showSaveDialog(options)
      },
      showOpenDialog: (sender, options) => {
        const parentWindow = BrowserWindow.fromWebContents(sender as WebContents)
        return parentWindow
          ? dialog.showOpenDialog(parentWindow, options)
          : dialog.showOpenDialog(options)
      },
      createEnvironmentFromLock: ({ projectId, lockChecksum, kernelKind, lock }) =>
        notebookService.importEnvironmentLock({
          projectId,
          language: kernelKind,
          lock,
          lockChecksum
        }),
      writeArchive: (filePath, bytes) =>
        publishUserFile(filePath, (temporaryPath) => writeFile(temporaryPath, bytes)),
      translate
    })
    registerArtifactReproducibilityIpcHandlers(reproducibilityOwner, {
      outputStorage: (request) =>
        withDataRootWrite(() =>
          getArtifactReproducibilityOutputStorage(artifactProvenanceRepository, request)
        ),
      clearOutputs: (request) =>
        archiveCoordinator.withSessionAvailable(request.projectId, request.appSessionId, () =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () =>
              reproducibilityOwner.withIdleVersion(request, () =>
                withDataRootWrite(() =>
                  clearArtifactReproducibilityOutputs(artifactProvenanceRepository, request)
                )
              )
          )
        ),
      previewOutput: (request) => receiptExporter.previewOutput(request),
      withSessionAvailable: (request, start) =>
        archiveCoordinator.withSessionAvailable(request.projectId, request.appSessionId, () =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            start
          )
        ),
      describeEnvironmentLock: (request) => receiptExporter.describeEnvironmentLock(request),
      createEnvironmentFromLock: (request) => receiptExporter.createEnvironmentFromLock(request),
      exportEnvironmentLock: (sender, request) =>
        receiptExporter.exportEnvironmentLock(sender, request),
      exportReceipt: (sender, request) => receiptExporter.export(sender, request),
      importEnvironmentLock: (sender, request) =>
        receiptExporter.importEnvironmentLock(sender, request)
    })
  })
