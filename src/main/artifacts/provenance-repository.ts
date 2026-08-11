import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PrismaClient } from '@prisma/client'

import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionFile,
  ArtifactVersionProvenance,
  CreateArtifactVersionRequest,
  FinalizeArtifactVersionsRequest,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS,
  type ResolveArtifactVersionDescriptorsRequest
} from '../../shared/artifacts'
import { ArtifactRepository } from './repository'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { defaultArtifactDurability, type ArtifactDurability } from './durability'
import {
  ArtifactProvenanceVersionWriter,
  normalizeArtifactFilename as normalizeFilename,
  type PersistedVersionFileRecord
} from './provenance-version-writer'
import { NotebookRunRepository } from '../notebook/repository'
import { canonicalJson, sha256 } from './provenance-canonical'
import { ArtifactProvenanceProducerCapture } from './provenance-producer-capture'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceMessageFinalizer,
  type ArtifactFinalizationProofReason
} from './provenance-message-finalization'
import {
  ArtifactProvenanceFinalizationRecovery,
  type ArtifactProjectReconciliationSnapshot
} from './provenance-finalization-recovery'
import { ArtifactProvenanceStagingRecovery } from './provenance-staging-recovery'
import { ArtifactProvenanceUnindexedRecovery } from './provenance-unindexed-recovery'
import { resolveStorageKey, storageKey } from './provenance-storage'
import { ArtifactProvenanceReadModel } from './provenance-read-model'
import type { PersistedChatSession } from '../../shared/session-persistence'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ArtifactProvenanceRepositoryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  inputAuthority?: Pick<ImmutableInputAuthority, 'validateVersion'>
  compatibilityRepository?: ArtifactRepository
  notebookRepository?: Pick<NotebookRunRepository, 'findExisting'>
  loadSession?: (
    projectId: string,
    appSessionId: string
  ) => Promise<PersistedChatSession | undefined>
  createId?: () => string
  now?: () => Date
  durability?: ArtifactDurability
}

export type WriteAppGeneratedArtifactVersionRequest = Omit<
  CreateArtifactVersionRequest,
  | 'writeOperationId'
  | 'writeRequestChecksum'
  | 'notebookSessionId'
  | 'producerRunId'
  | 'sourceKind'
  | 'sourceFileObservation'
  | 'filename'
  | 'contentType'
> & {
  filename: string
  content: string
  contentType?: string
  kind?: 'plan'
}

type ArtifactStorageReconciliationResult = {
  recoveredVersionIds: string[]
  quarantinedVersionIds: string[]
  recoveredMessageArtifacts: Array<{ messageId: string; artifacts: ArtifactVersionFile[] }>
}

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const hasServerInferredProducer = (evidenceJson: string): boolean => {
  try {
    const evidence = recordValue(JSON.parse(evidenceJson))
    const producer = recordValue(evidence?.producer)
    return producer?.association_method === 'server-inferred-file-observation'
  } catch {
    return false
  }
}

class ArtifactProvenanceRepository {
  private readonly compatibilityRepository: ArtifactRepository
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly durability: ArtifactDurability
  private readonly finalizationRecovery: ArtifactProvenanceFinalizationRecovery
  private readonly messageFinalizer: ArtifactProvenanceMessageFinalizer
  private readonly producerCapture: ArtifactProvenanceProducerCapture
  private readonly readModel: ArtifactProvenanceReadModel
  private readonly stagingRecovery: ArtifactProvenanceStagingRecovery
  private readonly unindexedRecovery: ArtifactProvenanceUnindexedRecovery
  private readonly versionWriter: ArtifactProvenanceVersionWriter

  constructor(private readonly options: ArtifactProvenanceRepositoryOptions) {
    this.compatibilityRepository =
      options.compatibilityRepository ?? new ArtifactRepository(options.storageRoot)
    const notebookRepository =
      options.notebookRepository ?? new NotebookRunRepository(options.storageRoot)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.durability = options.durability ?? defaultArtifactDurability
    const inputAuthority =
      options.inputAuthority ??
      new ImmutableInputAuthority({
        storageRoot: options.storageRoot,
        getClient: options.getClient
      })
    this.readModel = new ArtifactProvenanceReadModel({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      loadSession: options.loadSession,
      createId: this.createId,
      durability: this.durability,
      reconcileSession: (projectId, appSessionId) => this.reconcileSession(projectId, appSessionId),
      projectVersionDescriptor: (version, projectId, appSessionId) =>
        this.toDescriptor(version, projectId, appSessionId),
      resolveVersionContent: (request) => this.resolveVersionContent(request),
      resolveVersionDerivedPath: (request, filename) =>
        this.resolveVersionDerivedPath(request, filename)
    })
    this.producerCapture = new ArtifactProvenanceProducerCapture({
      inputAuthority,
      notebookRepository,
      createId: this.createId
    })
    this.messageFinalizer = new ArtifactProvenanceMessageFinalizer({
      getClient: options.getClient,
      loadSession: options.loadSession,
      projectVersionFile: (version, projectId, appSessionId) =>
        this.toArtifactVersionFile(version, projectId, appSessionId)
    })
    this.finalizationRecovery = new ArtifactProvenanceFinalizationRecovery({
      getClient: options.getClient,
      compatibilityRepository: options.compatibilityRepository,
      messageFinalizer: this.messageFinalizer
    })
    this.stagingRecovery = new ArtifactProvenanceStagingRecovery({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      compatibilityRepository: this.compatibilityRepository,
      createId: this.createId,
      now: this.now,
      durability: this.durability,
      projectVersionFile: (version, projectId, appSessionId) =>
        this.toArtifactVersionFile(version, projectId, appSessionId)
    })
    this.unindexedRecovery = new ArtifactProvenanceUnindexedRecovery({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      compatibilityRepository: this.compatibilityRepository,
      createId: this.createId
    })
    this.versionWriter = new ArtifactProvenanceVersionWriter({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      compatibilityRepository: this.compatibilityRepository,
      createId: this.createId,
      now: this.now,
      durability: this.durability,
      captureProducer: (request, createdAt, checksum) =>
        this.producerCapture.captureProducer(request, createdAt, checksum),
      prepareVersionPersistence: (input) => this.producerCapture.prepareVersionPersistence(input),
      recoverStagingVersion: (version, projectId, appSessionId, filename, publish) =>
        this.stagingRecovery.recoverVersion(version, projectId, appSessionId, filename, publish),
      projectVersionFile: (version, projectId, appSessionId) =>
        this.toArtifactVersionFile(version, projectId, appSessionId)
    })
  }

  // App-owned connector tools do not have an MCP/RPC hop. Keep compatibility bytes, immutable
  // Version publication, operation identity, and rollback behind one repository interface so every
  // app-side generated file follows the same durable lifecycle as model-invoked Artifact writes.
  async writeAppGeneratedVersion(
    request: WriteAppGeneratedArtifactVersionRequest
  ): Promise<ArtifactVersionFile> {
    const { content, kind, ...versionRequest } = request
    const writeOperationId = `artifact-app-write-${this.createId()}`

    return this.compatibilityRepository.withPendingFileTransaction(
      {
        projectName: request.projectId,
        sessionId: request.artifactStorageSessionId,
        runId: request.artifactRunId,
        filename: request.filename,
        mimeType: request.contentType,
        kind,
        source: { kind: 'inline', content, encoding: 'utf8' }
      },
      {},
      async (pendingFile, _sourceFileObservation, bindVersionRouting) => {
        const contentChecksum = sha256(await readFile(pendingFile.path))
        const writeRequestChecksum = sha256(
          canonicalJson({
            contentChecksum,
            contentType: request.contentType ?? null,
            filename: request.filename,
            producerRunId: null,
            sourceKind: 'inline',
            sourceFileObservation: null
          })
        )

        const version = await this.versionWriter.writeVersion(
          {
            ...versionRequest,
            writeOperationId,
            writeRequestChecksum,
            sourceKind: 'inline'
          },
          async (version) =>
            bindVersionRouting(
              {
                artifactId: version.artifactId,
                versionId: version.id,
                versionNumber: version.versionNumber,
                artifactRunId: version.artifactRunId,
                checksum: version.checksum,
                mimeType: version.contentType ?? undefined
              },
              resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
            )
        )
        return version
      }
    )
  }

  async createVersion(request: CreateArtifactVersionRequest): Promise<ArtifactVersionFile> {
    return this.versionWriter.writeVersion(
      request,
      this.stagingRecovery.routingPublisher(
        request.projectId,
        request.artifactStorageSessionId,
        request.filename
      )
    )
  }

  async replayVersion(
    request: ReplayArtifactVersionRequest
  ): Promise<ArtifactVersionFile | undefined> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactStorageSessionId = assertSafeSegment(
      request.artifactStorageSessionId,
      'artifact storage session id'
    )
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const writeOperationId = assertSafeSegment(request.writeOperationId, 'write operation id')
    const normalizedFilename = normalizeFilename(request.filename)
    const client = await this.options.getClient()
    const existing = await client.artifactVersion.findUnique({
      where: { writeOperationId },
      include: { artifact: true }
    })
    if (!existing) return undefined
    const producerMatches =
      request.producerRunId !== undefined
        ? (existing.producerRunId ?? undefined) === request.producerRunId
        : existing.producerRunId === null || hasServerInferredProducer(existing.evidenceJson)
    if (
      existing.artifact.projectId !== projectId ||
      existing.artifact.sessionId !== appSessionId ||
      existing.artifactRunId !== artifactRunId ||
      existing.artifact.normalizedFilename !== normalizedFilename ||
      (existing.contentType ?? undefined) !== request.contentType ||
      !producerMatches
    ) {
      throw new Error(
        `Artifact write operation was reused for a different request: ${writeOperationId}`
      )
    }
    if (existing.state === 'staging') {
      return this.stagingRecovery.recoverVersion(
        existing,
        projectId,
        appSessionId,
        request.filename,
        this.stagingRecovery.routingPublisher(projectId, artifactStorageSessionId, request.filename)
      )
    }
    if (existing.state !== 'pending' && existing.state !== 'finalized') {
      throw new Error(`Artifact write has an invalid lifecycle state: ${writeOperationId}`)
    }
    if (existing.state === 'pending') {
      await this.stagingRecovery.routingPublisher(
        projectId,
        artifactStorageSessionId,
        request.filename
      )(existing, { replaceUnroutedBytes: true })
    }
    return this.toArtifactVersionFile(existing, projectId, appSessionId)
  }

  async validateFinalizationOwnership(request: FinalizeArtifactVersionsRequest): Promise<void> {
    return this.messageFinalizer.validateOwnership(request)
  }

  async finalizeRun(request: FinalizeArtifactVersionsRequest): Promise<ArtifactVersionFile[]> {
    return this.messageFinalizer.finalizeRun(request)
  }

  async listRunVersions(request: {
    projectId: string
    appSessionId: string
    artifactRunId: string
  }): Promise<ArtifactVersionFile[]> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const client = await this.options.getClient()
    const versions = await client.artifactVersion.findMany({
      where: {
        artifactRunId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: { artifact: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })

    return Promise.all(
      versions.map((version) => this.toArtifactVersionFile(version, projectId, appSessionId))
    )
  }

  async prepareProjectReconciliation(
    projectIdInput: string
  ): Promise<ArtifactProjectReconciliationSnapshot> {
    const projectId = assertSafeSegment(projectIdInput, 'project id')
    return this.finalizationRecovery.prepareProjectReconciliation(projectId)
  }

  async reconcileSession(
    projectIdInput: string,
    appSessionIdInput: string,
    durableSession?: PersistedChatSession,
    options?: {
      removeOrphanStaging?: boolean
      projectReconciliation?: ArtifactProjectReconciliationSnapshot
    }
  ): Promise<ArtifactStorageReconciliationResult> {
    const projectId = assertSafeSegment(projectIdInput, 'project id')
    const appSessionId = assertSafeSegment(appSessionIdInput, 'app session id')
    this.finalizationRecovery.validateProjectReconciliation(
      projectId,
      options?.projectReconciliation
    )
    const result: ArtifactStorageReconciliationResult = {
      recoveredVersionIds: [],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: []
    }
    const unindexedSnapshot = await this.unindexedRecovery.prepareSession(projectId, appSessionId)
    const stagingResult = await this.stagingRecovery.reconcileSession(
      projectId,
      appSessionId,
      options?.removeOrphanStaging
    )
    result.recoveredVersionIds.push(...stagingResult.recoveredVersionIds)
    result.quarantinedVersionIds.push(...stagingResult.quarantinedVersionIds)
    const finalizationResult = await this.finalizationRecovery.reconcileSession(
      projectId,
      appSessionId,
      durableSession,
      options?.projectReconciliation
    )
    result.recoveredVersionIds.push(...finalizationResult.recoveredVersionIds)
    result.recoveredMessageArtifacts.push(...finalizationResult.recoveredMessageArtifacts)

    const unindexedResult = await this.unindexedRecovery.reconcileSession(unindexedSnapshot)
    result.recoveredVersionIds.push(...unindexedResult.recoveredVersionIds)
    result.quarantinedVersionIds.push(...unindexedResult.quarantinedVersionIds)
    return result
  }

  async getLineage(
    request: GetArtifactLineageRequest
  ): Promise<ArtifactLineageProvenance | undefined> {
    return this.readModel.getLineage(request)
  }

  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections?: { execution: boolean; messages: boolean; review: boolean }
  ): Promise<ArtifactVersionProvenance> {
    return this.readModel.getVersionProvenance(request, sections)
  }

  // Resolves the stable Version ids embedded in copied historical messages. This intentionally
  // returns only relocatable metadata: preview/open paths remain main-process capabilities.
  async resolveVersionDescriptors(
    request: ResolveArtifactVersionDescriptorsRequest
  ): Promise<ArtifactVersionDescriptor[]> {
    if (!Array.isArray(request.versionIds)) {
      throw new Error('Artifact Version ids must be an array.')
    }
    if (request.versionIds.length > MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS) {
      throw new Error(
        `At most ${MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS} Artifact Version ids may be resolved at once.`
      )
    }

    const versionIds = [...new Set(request.versionIds)].map((versionId) =>
      assertSafeSegment(versionId, 'artifact version id')
    )
    if (versionIds.length === 0) return []

    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    if (!this.options.loadSession) {
      throw new Error('Session ownership authority is unavailable.')
    }
    const session = await this.options.loadSession(projectId, appSessionId)
    if (!session || session.id !== appSessionId || session.projectId !== projectId) {
      throw new Error('Session does not belong to the requested Project.')
    }

    const client = await this.options.getClient()
    const versions = await client.artifactVersion.findMany({
      where: {
        id: { in: versionIds },
        state: 'finalized',
        artifact: { is: { projectId } }
      },
      include: { artifact: true }
    })
    const versionsById = new Map(versions.map((version) => [version.id, version]))

    return Promise.all(
      versionIds.flatMap((versionId) => {
        const version = versionsById.get(versionId)
        return version
          ? [this.toDescriptor(version, version.artifact.projectId, version.artifact.sessionId)]
          : []
      })
    )
  }

  async getVersionCore(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<ArtifactVersionProvenance> {
    return this.readModel.getVersionCore(request)
  }

  async getVersionExecution(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'execution'>> {
    return this.readModel.getVersionExecution(request)
  }

  async getVersionMessages(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'messages'>> {
    return this.readModel.getVersionMessages(request)
  }

  async getVersionReview(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'review'>> {
    return this.readModel.getVersionReview(request)
  }

  async readCodeReconstructionCache(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<string | undefined> {
    return this.readModel.readCodeReconstructionCache(request)
  }

  async writeCodeReconstructionCache(
    request: GetArtifactVersionProvenanceRequest,
    serialized: string
  ): Promise<void> {
    return this.readModel.writeCodeReconstructionCache(request, serialized)
  }

  private async resolveVersionDerivedPath(
    request: GetArtifactVersionProvenanceRequest,
    filename: string
  ): Promise<string> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    const artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const client = await this.options.getClient()
    const version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        artifactId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      select: { contentStorageKey: true }
    })
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)
    return join(
      dirname(resolveStorageKey(this.options.storageRoot, version.contentStorageKey)),
      filename
    )
  }

  // Resolves reviewer/preview reads through the Version authority rather than reconstructing a
  // legacy session path from an id. The checksum is verified before the caller receives the path.
  async resolveVersionContent(request: {
    projectId: string
    versionId: string
    appSessionId?: string
    artifactId?: string
  }): Promise<{ path: string; filename: string; contentType?: string; checksum?: string }> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const appSessionId = request.appSessionId
      ? assertSafeSegment(request.appSessionId, 'app session id')
      : undefined
    const artifactId = request.artifactId
      ? assertSafeSegment(request.artifactId, 'artifact id')
      : undefined
    const client = await this.options.getClient()
    const version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        ...(artifactId ? { artifactId } : {}),
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, ...(appSessionId ? { sessionId: appSessionId } : {}) } }
      },
      include: { artifact: true }
    })
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)

    const path = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const bytes = await readFile(path)
    if (sha256(bytes) !== version.checksum) {
      throw new Error(`Artifact Version content checksum mismatch: ${versionId}`)
    }
    return {
      path,
      filename: version.filename,
      contentType: version.contentType ?? undefined,
      checksum: version.checksum
    }
  }

  // Project deletion is the terminal provenance boundary. Session deletion intentionally keeps this
  // graph; deleting the Project removes every SQLite authority row plus immutable managed bytes.
  async deleteProjectProvenance(projectIdValue: string): Promise<void> {
    const projectId = assertSafeSegment(projectIdValue, 'project id')
    const client = await this.options.getClient()
    const uploadVersions = await client.uploadVersion.findMany({
      where: { uploadFile: { is: { projectId } } },
      select: { contentStorageKey: true }
    })

    // Delete managed Upload bytes while their authority rows still make the operation replayable.
    // Any failure leaves the Project deletion intent and storage keys available for a later retry.
    for (const version of uploadVersions) {
      await rm(resolveStorageKey(this.options.storageRoot, version.contentStorageKey), {
        force: true
      })
    }

    await client.$transaction(async (tx) => {
      await tx.artifactVersionInput.deleteMany({
        where: {
          OR: [
            { sourceProjectId: projectId },
            { artifactVersion: { is: { artifact: { is: { projectId } } } } }
          ]
        }
      })
      await tx.artifactLineage.deleteMany({ where: { projectId } })
      await tx.uploadFile.deleteMany({ where: { projectId } })
      await tx.artifactMessageSnapshot.deleteMany({ where: { projectId } })
      await tx.fileOriginSession.deleteMany({ where: { projectId } })
    })

    await rm(resolveStorageKey(this.options.storageRoot, storageKey('artifacts', projectId)), {
      recursive: true,
      force: true
    })
  }

  private async toArtifactVersionFile(
    version: PersistedVersionFileRecord,
    projectId: string,
    appSessionId: string
  ): Promise<ArtifactVersionFile> {
    const filePath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const fileMtimeMs = await stat(filePath)
      .then((fileStat) => fileStat.mtimeMs)
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return version.createdAt.getTime()
        }
        throw error
      })
    let environment: string | undefined
    if (version.executionSnapshotJson && version.producerRunId) {
      const snapshot = JSON.parse(version.executionSnapshotJson) as {
        runs?: Array<{ runId?: string; environmentName?: string }>
      }
      environment = snapshot.runs?.find(
        (run) => run.runId === version.producerRunId
      )?.environmentName
    }

    return {
      id: version.id,
      artifactId: version.artifactId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
      producerRunId: version.producerRunId ?? undefined,
      environment,
      projectName: projectId,
      sessionId: appSessionId,
      runId: version.artifactRunId,
      name: version.filename,
      path: filePath,
      fileUrl: pathToFileURL(filePath).toString(),
      mimeType: version.contentType ?? undefined,
      size: Number(version.sizeBytes),
      mtimeMs: fileMtimeMs
    }
  }

  private async toDescriptor(
    version: PersistedVersionFileRecord & { state: string; messageId: string | null },
    projectId: string,
    appSessionId: string
  ): Promise<ArtifactVersionDescriptor> {
    const file = await this.toArtifactVersionFile(version, projectId, appSessionId)
    const { path, fileUrl, ...relocatableFile } = file
    void path
    void fileUrl
    return {
      ...relocatableFile,
      state: version.state as 'pending' | 'finalized',
      messageId: version.messageId ?? undefined
    }
  }
}

export {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceRepository
}
export type { ArtifactFinalizationProofReason, ArtifactProvenanceRepositoryOptions }
export type { ArtifactProjectReconciliationSnapshot }
