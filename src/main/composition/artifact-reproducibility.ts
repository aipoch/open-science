import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeMetadata } from '../runtime-metadata'
import { desktopFileInteraction } from '../desktop-interaction'
import type { ArchiveCoordinator } from '../archive/coordinator'
import { createArtifactReproducibilityReceiptExporter } from '../artifacts/artifact-reproducibility-export'
import type { ArtifactReproducibilityCommandDependencies } from '../artifacts/artifact-reproducibility-commands'
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
import { withDataRootWrite } from '../storage/migration-state'
import { resolveDataRoot } from '../storage-root'
import { publishUserFile } from '../user-file-publisher'

export type ArtifactReproducibilityAssembly = {
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

export function createArtifactReproducibilityDependencies({
  artifactProvenanceRepository,
  artifactReproducibilityAttemptOwnerRef,
  archiveCoordinator,
  sessionPersistenceCoordinator,
  notebookService,
  translate
}: ArtifactReproducibilityAssembly): ArtifactReproducibilityCommandDependencies {
  const getOwner = (): NonNullable<
    ArtifactReproducibilityAssembly['artifactReproducibilityAttemptOwnerRef']['current']
  > => {
    const owner = artifactReproducibilityAttemptOwnerRef.current
    if (!owner) throw new Error('Artifact reproducibility lifecycle is not configured.')
    return owner
  }
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
    downloadsDirectory: () => runtimeMetadata().downloadsPath,
    readOutput: (request, checksum, entityId) =>
      withDataRootWrite(() =>
        getArtifactReproducibilityOutput(artifactProvenanceRepository, request, checksum, entityId)
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
    showSaveDialog: (callerId, options) => {
      if (typeof callerId !== 'string')
        throw new Error('Reproducibility export requires a caller identity.')
      return desktopFileInteraction().chooseSavePath(options, callerId)
    },
    showOpenDialog: (callerId, options) => {
      if (typeof callerId !== 'string')
        throw new Error('Reproducibility import requires a caller identity.')
      return desktopFileInteraction().chooseFiles(options, callerId)
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
  return {
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
            getOwner().withIdleVersion(request, () =>
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
    exportEnvironmentLock: (callerId, request) =>
      receiptExporter.exportEnvironmentLock(callerId, request),
    exportReceipt: (callerId, request) => receiptExporter.export(callerId, request),
    importEnvironmentLock: (callerId, request) =>
      receiptExporter.importEnvironmentLock(callerId, request)
  }
}
