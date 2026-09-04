import type {
  ArtifactFile,
  ArtifactSourceFileObservation,
  ListPendingRunArtifactsRequest,
  ListProjectMessageArtifactsRequest,
  MovePendingRunArtifactsRequest,
  OpenArtifactFileRequest,
  WritePendingArtifactFileRequest
} from '../../shared/artifacts'
import { ArtifactCompatibilityOwner } from './compatibility-owner'
import {
  defaultArtifactDurability,
  type ArtifactDurability as ArtifactRepositoryDurability
} from './durability'
import {
  ArtifactCompatibilityScanIncompleteError,
  ArtifactPublicationOwner,
  type ArtifactRunFinalizationMarker,
  type BindPendingArtifactVersionRouting,
  type PendingArtifactRunPublication,
  type PendingArtifactVersionRoute,
  type PendingArtifactVersionRouting,
  type PendingArtifactVersionRoutingRequest,
  type PendingFileTransactionOptions,
  type PrepareArtifactRunFinalizationRequest
} from './publication-owner'
import {
  ArtifactStorageAccess,
  createArtifactPublicationStorage,
  getArtifactCurrentRunFilePath,
  getProjectArtifactDir,
  type ArtifactStorageAccessDurability
} from './storage-access'
import type { FileDigest } from '../bounded-file-io'
import type { PendingFileBudgetReservation } from './pending-file-transaction'

type ArtifactRepositoryWriteOptions = PendingFileTransactionOptions
type ArtifactRepositoryStorage = ArtifactStorageAccessDurability

export type { ArtifactRepositoryDurability }

const defaultArtifactRepositoryDurability = defaultArtifactDurability

class ArtifactRepository {
  private readonly publicationOwner: ArtifactPublicationOwner
  private readonly compatibilityOwner: ArtifactCompatibilityOwner

  constructor(
    private readonly storageRoot: string,
    private readonly durability: ArtifactRepositoryStorage = defaultArtifactRepositoryDurability
  ) {
    const storage = new ArtifactStorageAccess(this.storageRoot, this.durability)
    this.publicationOwner = new ArtifactPublicationOwner(
      createArtifactPublicationStorage(storage, (request) =>
        this.compatibilityOwner.listMessageFiles(request)
      )
    )
    this.compatibilityOwner = new ArtifactCompatibilityOwner({
      storage,
      readRunMarkerForRecovery: (markerPath) =>
        this.publicationOwner.readRunMarkerForRecovery(markerPath)
    })
  }

  async writePendingFile(
    request: WritePendingArtifactFileRequest,
    options: ArtifactRepositoryWriteOptions = {}
  ): Promise<ArtifactFile> {
    return this.publicationOwner.writePendingFile(request, options)
  }

  async ensurePendingVersionRouting(request: PendingArtifactVersionRoutingRequest): Promise<void> {
    return this.publicationOwner.ensurePendingVersionRouting(request)
  }

  async findPendingVersionRouting(request: {
    projectId: string
    artifactId: string
    versionId: string
  }): Promise<PendingArtifactVersionRoute | undefined> {
    return this.publicationOwner.findPendingVersionRouting(request)
  }

  async findPendingFileForRun(request: {
    projectId: string
    runId: string
    filename: string
    checksum: string
  }): Promise<{ storageSessionId: string; path: string } | undefined> {
    return this.publicationOwner.findPendingFileForRun(request)
  }

  async withPendingFileTransaction<Result>(
    request: WritePendingArtifactFileRequest,
    options: ArtifactRepositoryWriteOptions,
    operation: (
      artifact: ArtifactFile,
      sourceFileObservation: ArtifactSourceFileObservation | undefined,
      bindVersionRouting: BindPendingArtifactVersionRouting,
      fileDigest: FileDigest,
      reservation: PendingFileBudgetReservation | undefined
    ) => Promise<Result>
  ): Promise<Result> {
    return this.publicationOwner.withPendingFileTransaction(request, options, operation)
  }

  async finalizeRunArtifacts(request: MovePendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    return this.publicationOwner.finalizeRunArtifacts(request)
  }

  async prepareRunFinalization(request: PrepareArtifactRunFinalizationRequest): Promise<void> {
    return this.publicationOwner.prepareRunFinalization(request)
  }

  async listPendingRunFiles(request: ListPendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    return this.publicationOwner.listPendingRunFiles(request)
  }

  async listMessageFiles(request: ListProjectMessageArtifactsRequest): Promise<ArtifactFile[]> {
    return this.compatibilityOwner.listMessageFiles(request)
  }

  async reconcilePendingArtifactPaths(request: {
    projectId: string
    sessionId: string
    messageId: string
    pendingPaths: string[]
  }): Promise<ArtifactFile[]> {
    return this.publicationOwner.reconcilePendingArtifactPaths(request)
  }

  async listPendingRunPublications(projectId: string): Promise<PendingArtifactRunPublication[]> {
    return this.publicationOwner.listPendingRunPublications(projectId)
  }

  async resolveManagedFilePath(request: OpenArtifactFileRequest): Promise<string> {
    return this.compatibilityOwner.resolveManagedFilePath(request)
  }

  async resolveSessionArtifactFilePath(
    projectId: string,
    sessionId: string,
    path: string
  ): Promise<string> {
    return this.compatibilityOwner.resolveSessionArtifactFilePath(projectId, sessionId, path)
  }

  async findRunFinalizationMarker(
    projectId: string,
    runId: string
  ): Promise<(ArtifactRunFinalizationMarker & { sourceSessionId: string }) | undefined> {
    return this.publicationOwner.findRunFinalizationMarker(projectId, runId)
  }
}

export {
  ArtifactCompatibilityScanIncompleteError,
  ArtifactRepository,
  getArtifactCurrentRunFilePath,
  getProjectArtifactDir
}
export type {
  ArtifactRunFinalizationMarker,
  PendingArtifactRunPublication,
  PendingArtifactVersionRoute,
  PendingArtifactVersionRouting
}
