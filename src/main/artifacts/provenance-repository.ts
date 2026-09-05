import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PrismaClient } from '@prisma/client'
import { ManagedFileVersionService } from '../managed-file-versions/service'

import type {
  AppGeneratedArtifactProducer,
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionFile,
  ArtifactVersionProvenance,
  ArtifactWriteReservation,
  CreateArtifactVersionRequest,
  FinalizeArtifactVersionsRequest,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest,
  ReleaseArtifactWriteReservationRequest,
  ReserveArtifactWriteRequest,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS,
  type ResolveArtifactVersionDescriptorsRequest
} from '../../shared/artifacts'
import { parseOwnedExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
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
import { ArtifactProvenanceDependencyReader } from './provenance-dependency-reader'
import type { HostLineageDependencyRelation, HostLineageDirection } from '../../shared/host-lineage'
import { requireAgentArtifactVersion } from './provenance-version-kind'
import type { LocalResourceBudgetOverrides } from '../resource-budget'
import { ArtifactWriteBudgetOwner } from './write-budget-owner'
import {
  NodeVersionFileOperator,
  VERSION_FILE_CANDIDATE_LIMIT,
  VersionFileOperatorError,
  type Integrity,
  type PlanImmutableInput,
  type PlannedFile,
  type VersionFileOperator,
  type VersionFileRecovery
} from '../managed-file-versions/version-file-operator'
import { bindArtifactReconstructionEvidence } from './provenance-reconstruction-evidence'
import { ReviewerTurnFileEvidenceReader } from './reviewer-turn-file-evidence-reader'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ArtifactProvenanceRepositoryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  inputAuthority?: Pick<ImmutableInputAuthority, 'validateVersion'>
  compatibilityRepository?: ArtifactRepository
  notebookRepository?: Pick<NotebookRunRepository, 'readSessionDocuments'>
  loadSession?: (
    projectId: string,
    appSessionId: string
  ) => Promise<PersistedChatSession | undefined>
  createId?: () => string
  now?: () => Date
  durability?: ArtifactDurability
  resourceBudgets?: LocalResourceBudgetOverrides
  versionFileOperator?: VersionFileOperator & VersionFileRecovery
  managedFileVersions?: Pick<ManagedFileVersionService, 'openVersion'>
}

type ProjectableVersionFileRecord = Omit<PersistedVersionFileRecord, 'artifactRunId'> & {
  artifactRunId: string | null
}

type VersionDescriptorRecord = ProjectableVersionFileRecord & {
  state: string
  messageId: string | null
  originKind: string
  basedOnVersionId: string | null
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
  producer?: AppGeneratedArtifactProducer
}

type ArtifactStorageReconciliationResult = {
  recoveredVersionIds: string[]
  quarantinedVersionIds: string[]
  recoveredMessageArtifacts: Array<{ messageId: string; artifacts: ArtifactVersionFile[] }>
  nativeFinalizationRunIds: string[]
  unresolvedNativeFinalizationRunIds: string[]
  invalidProofNativeFinalizationRunIds?: string[]
}

type ProjectVersionWriteOperation = {
  operationId: string
  source: string
  projectId: string
  sourceFileId: string
  storageTag: string
  storedFilename: string
  contentStorageKey: string
  checksum: string
  sizeBytes: bigint
}

type JournalRecoveryPlan = {
  input: PlanImmutableInput
  plannedFile: PlannedFile
}

type ProjectLogicalFileOwner = {
  sessionId: string
  logicalFilename: string
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

const journalRecoveryPlan = (
  operator: VersionFileOperator,
  operation: ProjectVersionWriteOperation,
  owner: ProjectLogicalFileOwner | undefined
): JournalRecoveryPlan | undefined => {
  if ((operation.source !== 'artifact' && operation.source !== 'upload') || !owner) return undefined
  // Storage references remain operator-owned. The database supplies the logical owner fields needed
  // to reproduce a plan without teaching project deletion about any adapter's physical layout.
  for (let candidateIndex = 0; candidateIndex < VERSION_FILE_CANDIDATE_LIMIT; candidateIndex += 1) {
    const input: PlanImmutableInput = {
      operationId: operation.operationId,
      scope: {
        source: operation.source,
        projectId: operation.projectId,
        sessionId: owner.sessionId,
        logicalFileId: operation.sourceFileId
      },
      logicalFilename: owner.logicalFilename,
      candidateIndex
    }
    const plannedFile = operator.planImmutable(input)
    if (
      plannedFile.storageRef === operation.contentStorageKey &&
      plannedFile.storedFilename === operation.storedFilename &&
      `v${plannedFile.versionToken}` === operation.storageTag &&
      plannedFile.candidateIndex === candidateIndex
    ) {
      return { input, plannedFile }
    }
  }
  return undefined
}

class ArtifactProvenanceRepository {
  private readonly compatibilityRepository: ArtifactRepository
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly durability: ArtifactDurability
  private readonly dependencyReader: ArtifactProvenanceDependencyReader
  private readonly finalizationRecovery: ArtifactProvenanceFinalizationRecovery
  private readonly messageFinalizer: ArtifactProvenanceMessageFinalizer
  private readonly notebookRepository: Pick<NotebookRunRepository, 'readSessionDocuments'>
  private readonly producerCapture: ArtifactProvenanceProducerCapture
  private readonly readModel: ArtifactProvenanceReadModel
  private readonly reviewerTurnFileEvidenceReader: ReviewerTurnFileEvidenceReader
  private readonly stagingRecovery: ArtifactProvenanceStagingRecovery
  private readonly unindexedRecovery: ArtifactProvenanceUnindexedRecovery
  private readonly versionWriter: ArtifactProvenanceVersionWriter
  private readonly writeBudgetOwner: ArtifactWriteBudgetOwner
  private readonly versionFileOperator: VersionFileOperator & VersionFileRecovery

  constructor(private readonly options: ArtifactProvenanceRepositoryOptions) {
    this.compatibilityRepository =
      options.compatibilityRepository ?? new ArtifactRepository(options.storageRoot)
    this.notebookRepository =
      options.notebookRepository ?? new NotebookRunRepository(options.storageRoot)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.durability = options.durability ?? defaultArtifactDurability
    this.versionFileOperator =
      options.versionFileOperator ??
      new NodeVersionFileOperator({ storageRoot: options.storageRoot })
    this.writeBudgetOwner = new ArtifactWriteBudgetOwner({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      compatibilityRepository: this.compatibilityRepository,
      resourceBudgets: options.resourceBudgets,
      now: () => this.now().getTime()
    })
    const inputAuthority =
      options.inputAuthority ??
      new ImmutableInputAuthority({
        storageRoot: options.storageRoot,
        managedFileVersions:
          options.managedFileVersions ??
          new ManagedFileVersionService({
            storageRoot: options.storageRoot,
            getClient: options.getClient,
            versionFileOperator: this.versionFileOperator
          })
      })
    this.dependencyReader = new ArtifactProvenanceDependencyReader(options.getClient)
    this.reviewerTurnFileEvidenceReader = new ReviewerTurnFileEvidenceReader({
      storageRoot: options.storageRoot,
      getClient: options.getClient,
      notebookRepository: this.notebookRepository
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
      resolveArtifactVersion: options.managedFileVersions
        ? async (request) => {
            if (!request.fileId) {
              throw new Error('Artifact Version content requires a logical file identity.')
            }
            const lease = await options.managedFileVersions!.openVersion(
              {
                source: 'artifact',
                projectId: request.projectId,
                fileId: request.fileId
              },
              request.versionId
            )
            if (lease.logicalFile.sessionId !== request.sessionId) {
              await lease.close()
              throw new Error('Artifact Version belongs to a different Session.')
            }
            return {
              filename: lease.version.filename,
              ...(lease.version.contentType ? { contentType: lease.version.contentType } : {}),
              checksum: lease.version.checksum,
              size: lease.size,
              readRange: lease.readRange,
              verifyUnchanged: lease.verifyUnchanged,
              close: lease.close
            }
          }
        : undefined,
      resolveVersionDerivedPath: (request, filename) =>
        this.resolveVersionDerivedPath(request, filename)
    })
    bindArtifactReconstructionEvidence(this, (request) =>
      this.readModel.getVersionProvenance(
        request,
        { execution: true, messages: false, review: false },
        { includePrivateHelperSource: true }
      )
    )
    this.producerCapture = new ArtifactProvenanceProducerCapture({
      inputAuthority,
      notebookRepository: this.notebookRepository,
      storageRoot: options.storageRoot,
      createId: this.createId,
      computeJobReader: {
        findByProducer: async (projectId, sessionId, producerRunId) => {
          const client = await options.getClient()
          const jobs = await client.computeJob.findMany({
            where: { projectId, sessionId, producerRunId },
            select: {
              id: true,
              providerId: true,
              shape: true,
              status: true,
              fileEvidence: true,
              createdAt: true
            },
            orderBy: { createdAt: 'asc' },
            take: 100
          })
          return jobs.map((job) => {
            let fileEvidence
            try {
              fileEvidence = job.fileEvidence
                ? parseOwnedExecutionFileEvidenceSummary(JSON.parse(job.fileEvidence), {
                    activityId: job.id,
                    activityKind: 'compute-job',
                    parentActivityId: producerRunId,
                    storageKey: `execution-file-evidence/${projectId}/${sessionId}/activity-${job.id}/evidence.json`
                  })
                : undefined
            } catch {
              fileEvidence = undefined
            }
            return {
              activity_id: job.id,
              provider_id: job.providerId,
              shape: job.shape,
              status: job.status as import('../../shared/compute').ComputeJobStatus,
              file_evidence: {
                state: fileEvidence?.state ?? 'unavailable',
                ...(fileEvidence?.evidenceId ? { evidence_id: fileEvidence.evidenceId } : {}),
                ...(fileEvidence?.checksum ? { checksum: fileEvidence.checksum } : {}),
                ...(fileEvidence?.storageKey ? { storage_key: fileEvidence.storageKey } : {}),
                ...(fileEvidence?.generationCount !== undefined
                  ? { generation_count: fileEvidence.generationCount }
                  : {}),
                reason_codes: fileEvidence?.reasonCodes ?? ['evidence-persistence-failed']
              }
            }
          })
        }
      }
    })
    this.messageFinalizer = new ArtifactProvenanceMessageFinalizer({
      getClient: options.getClient,
      now: this.now,
      loadSession: options.loadSession,
      projectVersionFile: (version, projectId, appSessionId) =>
        this.toArtifactVersionFile(version, projectId, appSessionId)
    })
    this.finalizationRecovery = new ArtifactProvenanceFinalizationRecovery({
      getClient: options.getClient,
      compatibilityRepository: this.compatibilityRepository,
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
      resourceBudgets: options.resourceBudgets,
      writeBudgetOwner: this.writeBudgetOwner,
      captureProducer: (request, createdAt, checksum, appGeneratedProducer) =>
        this.producerCapture.captureProducer(request, createdAt, checksum, appGeneratedProducer),
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
    const { content, kind, producer, ...versionRequest } = request
    const writeOperationId = `artifact-app-write-${this.createId()}`
    const reservationScope = {
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      artifactRunId: request.artifactRunId
    }

    return this.versionWriter.withSessionWrite(versionRequest, (writeVersion) =>
      this.compatibilityRepository.withPendingFileTransaction(
        {
          projectId: request.projectId,
          sessionId: request.artifactStorageSessionId,
          runId: request.artifactRunId,
          filename: request.filename,
          mimeType: request.contentType,
          kind,
          source: { kind: 'inline', content, encoding: 'utf8' }
        },
        {
          reserveFile: (fileBytes) =>
            this.writeBudgetOwner.reserve({
              ...reservationScope,
              writeOperationId,
              filename: request.filename,
              fileBytes
            }),
          releaseFileReservation: (reservationId) =>
            this.writeBudgetOwner.release({ ...reservationScope, reservationId })
        },
        async (
          _pendingFile,
          _sourceFileObservation,
          bindVersionRouting,
          fileDigest,
          reservation
        ) => {
          if (!reservation) throw new Error('App-owned Artifact write reservation was not created.')
          const contentChecksum = fileDigest.checksum
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

          return writeVersion(
            {
              ...versionRequest,
              writeOperationId,
              writeRequestChecksum,
              sourceKind: 'inline',
              resourceReservationId: reservation.id,
              resourceSizeBytes: fileDigest.sizeBytes,
              resourceChecksum: fileDigest.checksum
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
              ),
            undefined,
            producer
          )
        }
      )
    )
  }

  async createVersion(
    request: CreateArtifactVersionRequest,
    signal?: AbortSignal
  ): Promise<ArtifactVersionFile> {
    return this.versionWriter.writeVersion(
      request,
      this.stagingRecovery.routingPublisher(
        request.projectId,
        request.artifactStorageSessionId,
        request.filename
      ),
      signal
    )
  }

  reserveWrite(request: ReserveArtifactWriteRequest): Promise<ArtifactWriteReservation> {
    return this.writeBudgetOwner.reserve(request)
  }

  releaseWriteReservation(request: ReleaseArtifactWriteReservationRequest): Promise<void> {
    return this.writeBudgetOwner.release(request)
  }

  releaseRunWriteReservations(request: {
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
  }): Promise<void> {
    return this.writeBudgetOwner.releaseRun(request)
  }

  releaseAllWriteReservations(): Promise<void> {
    return this.writeBudgetOwner.releaseAll()
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
    const agentVersion = requireAgentArtifactVersion(existing)
    const producerMatches =
      request.producerRunId !== undefined
        ? (agentVersion.producerRunId ?? undefined) === request.producerRunId
        : agentVersion.producerRunId === null ||
          hasServerInferredProducer(agentVersion.evidenceJson)
    if (
      agentVersion.artifact.projectId !== projectId ||
      agentVersion.artifact.sessionId !== appSessionId ||
      agentVersion.artifactRunId !== artifactRunId ||
      agentVersion.artifact.normalizedFilename !== normalizedFilename ||
      (agentVersion.contentType ?? undefined) !== request.contentType ||
      !producerMatches
    ) {
      throw new Error(
        `Artifact write operation was reused for a different request: ${writeOperationId}`
      )
    }
    if (agentVersion.state === 'staging') {
      return this.stagingRecovery.recoverVersion(
        agentVersion,
        projectId,
        appSessionId,
        request.filename,
        this.stagingRecovery.routingPublisher(projectId, artifactStorageSessionId, request.filename)
      )
    }
    if (agentVersion.state !== 'pending' && agentVersion.state !== 'finalized') {
      throw new Error(`Artifact write has an invalid lifecycle state: ${writeOperationId}`)
    }
    if (agentVersion.state === 'pending') {
      await this.stagingRecovery.routingPublisher(
        projectId,
        artifactStorageSessionId,
        request.filename
      )(agentVersion, { replaceUnroutedBytes: true })
    }
    return this.toArtifactVersionFile(agentVersion, projectId, appSessionId)
  }

  async validateFinalizationOwnership(request: FinalizeArtifactVersionsRequest): Promise<void> {
    return this.messageFinalizer.validateOwnership(request)
  }

  async finalizeRun(request: FinalizeArtifactVersionsRequest): Promise<ArtifactVersionFile[]> {
    return this.messageFinalizer.finalizeRun(request)
  }

  async activateFinalizedRun(
    request: FinalizeArtifactVersionsRequest
  ): Promise<ArtifactVersionFile[]> {
    return this.messageFinalizer.activateFinalizedRun(request)
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
        originKind: 'agent_generated',
        artifactRunId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: { artifact: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })

    return Promise.all(
      versions.map((version) =>
        this.toArtifactVersionFile(requireAgentArtifactVersion(version), projectId, appSessionId)
      )
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
      artifactRunIds?: string[]
      artifactVersionIds?: string[]
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
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
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
      options?.projectReconciliation,
      options?.artifactRunIds,
      options?.artifactVersionIds
    )
    result.recoveredVersionIds.push(...finalizationResult.recoveredVersionIds)
    result.recoveredMessageArtifacts.push(...finalizationResult.recoveredMessageArtifacts)
    result.nativeFinalizationRunIds.push(...finalizationResult.nativeFinalizationRunIds)
    result.unresolvedNativeFinalizationRunIds.push(
      ...finalizationResult.unresolvedNativeFinalizationRunIds
    )
    if (finalizationResult.invalidProofNativeFinalizationRunIds?.length) {
      result.invalidProofNativeFinalizationRunIds = [
        ...finalizationResult.invalidProofNativeFinalizationRunIds
      ]
    }

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

  // Reviewer lookup starts from the immutable Version id held by TurnScope. Resolve its owning
  // lineage/session inside the provenance authority so neither the model nor Session prose can
  // supply or widen those locators.
  async getReviewerVersionTrace(request: {
    projectId: string
    versionId: string
  }): Promise<ArtifactVersionProvenance> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const versionId = assertSafeSegment(request.versionId, 'artifact version id')
    const client = await this.options.getClient()
    const version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId } }
      },
      select: { artifactId: true, artifact: { select: { sessionId: true } } }
    })
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)
    return this.readModel.getVersionProvenance(
      {
        projectId,
        appSessionId: version.artifact.sessionId,
        artifactId: version.artifactId,
        versionId
      },
      { execution: true, messages: false, review: false }
    )
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
        originKind: 'agent_generated',
        state: 'finalized',
        artifact: { is: { projectId } }
      },
      include: { artifact: true }
    })
    const versionsById = new Map(
      versions.map((version) => {
        const agentVersion = requireAgentArtifactVersion(version)
        return [agentVersion.id, agentVersion] as const
      })
    )

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

  async resolveReviewerTurnFileEvidence(request: {
    projectId: string
    sessionId: string
    artifactVersionIds: readonly string[]
    messageIds: readonly string[]
  }): ReturnType<ReviewerTurnFileEvidenceReader['resolve']> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const sessionId = assertSafeSegment(request.sessionId, 'session id')
    return this.reviewerTurnFileEvidenceReader.resolve({
      ...request,
      projectId,
      sessionId
    })
  }

  async readDependencyRelations(request: {
    projectId: string
    versionId: string
    direction: HostLineageDirection
  }): Promise<HostLineageDependencyRelation[]> {
    return this.dependencyReader.readDependencyRelations(request)
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

  // Project deletion is the terminal provenance boundary. Session deletion intentionally keeps this
  // graph; deleting the Project removes every SQLite authority row plus immutable managed bytes.
  async deleteProjectProvenance(projectIdValue: string): Promise<void> {
    const projectId = assertSafeSegment(projectIdValue, 'project id')
    const client = await this.options.getClient()
    const [artifactVersions, uploadVersions, versionWriteOperations, artifactOwners, uploadOwners] =
      await Promise.all([
        client.artifactVersion.findMany({
          where: { artifact: { is: { projectId } } },
          select: { contentStorageKey: true, sizeBytes: true, checksum: true }
        }),
        client.uploadVersion.findMany({
          where: { uploadFile: { is: { projectId } } },
          select: { contentStorageKey: true, sizeBytes: true, checksum: true }
        }),
        client.managedFileVersionWriteOperation.findMany({
          where: { projectId, source: { in: ['artifact', 'upload'] } },
          orderBy: { operationId: 'asc' },
          select: {
            operationId: true,
            source: true,
            projectId: true,
            sourceFileId: true,
            storageTag: true,
            storedFilename: true,
            contentStorageKey: true,
            sizeBytes: true,
            checksum: true
          }
        }),
        client.artifactLineage.findMany({
          where: { projectId },
          select: { id: true, sessionId: true, filename: true }
        }),
        client.uploadFile.findMany({
          where: { projectId },
          select: { id: true, sessionId: true, filename: true, originalFilename: true }
        })
      ])
    const journalOwners = new Map<string, ProjectLogicalFileOwner>()
    for (const owner of artifactOwners) {
      journalOwners.set(`artifact:${owner.id}`, {
        sessionId: owner.sessionId,
        logicalFilename: owner.filename
      })
    }
    for (const owner of uploadOwners) {
      journalOwners.set(`upload:${owner.id}`, {
        sessionId: owner.sessionId,
        logicalFilename: owner.originalFilename || owner.filename
      })
    }

    // Version rows remain the retry authority until every immutable byte has been removed. A write
    // journal may share that storage reference only when both authorities agree on its integrity.
    const immutableStorage = new Map<string, Integrity>()
    const integrityFor = (entry: {
      contentStorageKey: string
      sizeBytes: bigint
      checksum: string
    }): Integrity => {
      const sizeBytes = Number(entry.sizeBytes)
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(
          `Immutable Version size is outside the supported range: ${entry.contentStorageKey}`
        )
      }
      return { sizeBytes, checksum: entry.checksum }
    }
    for (const entry of [...artifactVersions, ...uploadVersions]) {
      const integrity = integrityFor(entry)
      const existing = immutableStorage.get(entry.contentStorageKey)
      if (
        existing &&
        (existing.sizeBytes !== integrity.sizeBytes || existing.checksum !== integrity.checksum)
      ) {
        throw new Error(`Conflicting immutable Version integrity: ${entry.contentStorageKey}`)
      }
      immutableStorage.set(entry.contentStorageKey, integrity)
    }
    for (const [storageRef, expectedIntegrity] of immutableStorage) {
      await this.versionFileOperator.removeImmutable(storageRef, expectedIntegrity)
    }

    for (const operation of versionWriteOperations) {
      const expectedIntegrity = integrityFor(operation)
      const versionIntegrity = immutableStorage.get(operation.contentStorageKey)
      if (versionIntegrity) {
        if (
          versionIntegrity.sizeBytes !== expectedIntegrity.sizeBytes ||
          versionIntegrity.checksum !== expectedIntegrity.checksum
        ) {
          throw new Error(`Conflicting immutable Version integrity: ${operation.contentStorageKey}`)
        }
        continue
      }

      // Legacy journals have no durable claim and can only be removed when their complete bytes
      // match. Current journals use the operator claim to distinguish owned partial writes from
      // unrelated occupants before any incomplete content is removed.
      const recoveryPlan = journalRecoveryPlan(
        this.versionFileOperator,
        operation,
        journalOwners.get(`${operation.source}:${operation.sourceFileId}`)
      )
      if (!recoveryPlan) {
        await this.versionFileOperator.removeImmutable(
          operation.contentStorageKey,
          expectedIntegrity
        )
        continue
      }
      const inspection = await this.versionFileOperator.inspectRecovery({
        ...recoveryPlan.input,
        plannedFile: recoveryPlan.plannedFile,
        expectedIntegrity
      })
      if (inspection.state === 'complete') {
        await this.versionFileOperator.removeImmutable(
          operation.contentStorageKey,
          expectedIntegrity
        )
      } else if (inspection.state === 'incomplete') {
        await this.versionFileOperator.removeIncomplete({
          ...recoveryPlan.input,
          plannedFile: recoveryPlan.plannedFile,
          actualIntegrity: inspection.actualIntegrity
        })
      } else if (inspection.state === 'occupied') {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          `Unclaimed Version journal storage is occupied: ${operation.contentStorageKey}`
        )
      }
    }

    // Auxiliary provenance evidence and legacy compatibility files are not immutable Version
    // content. Remove both source roots before the database transaction so failure keeps authority.
    await rm(resolveStorageKey(this.options.storageRoot, storageKey('artifacts', projectId)), {
      recursive: true,
      force: true
    })
    await rm(resolveStorageKey(this.options.storageRoot, storageKey('uploads', projectId)), {
      recursive: true,
      force: true
    })

    await client.$transaction(async (tx) => {
      await tx.artifactVersionInput.deleteMany({
        where: {
          OR: [
            { sourceProjectId: projectId },
            { artifactVersion: { is: { artifact: { is: { projectId } } } } }
          ]
        }
      })
      await tx.managedFileVersionWriteOperation.deleteMany({ where: { projectId } })
      await tx.artifactLineage.updateMany({
        where: { projectId },
        data: { currentVersionId: null }
      })
      await tx.uploadFile.updateMany({
        where: { projectId },
        data: { currentVersionId: null }
      })
      const artifactVersions = await tx.artifactVersion.findMany({
        where: { artifact: { is: { projectId } } },
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      for (const version of artifactVersions) {
        await tx.artifactVersion.delete({ where: { id: version.id } })
      }
      const uploadVersionRows = await tx.uploadVersion.findMany({
        where: { uploadFile: { is: { projectId } } },
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      for (const version of uploadVersionRows) {
        await tx.uploadVersion.delete({ where: { id: version.id } })
      }
      await tx.artifactLineage.deleteMany({ where: { projectId } })
      await tx.uploadFile.deleteMany({ where: { projectId } })
      await tx.artifactMessageSnapshot.deleteMany({ where: { projectId } })
      await tx.fileOriginSession.deleteMany({ where: { projectId } })
    })
  }

  private async toArtifactVersionFile(
    version: ProjectableVersionFileRecord,
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
      isPublished:
        version.state === 'finalized' &&
        (version.originKind !== 'agent_generated' || version.managedVisibleAt !== null),
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
      producerRunId: version.producerRunId ?? undefined,
      environment,
      projectId,
      sessionId: appSessionId,
      runId: version.artifactRunId ?? undefined,
      name: version.filename,
      path: filePath,
      fileUrl: pathToFileURL(filePath).toString(),
      mimeType: version.contentType ?? undefined,
      size: Number(version.sizeBytes),
      mtimeMs: fileMtimeMs
    }
  }

  private async toDescriptor(
    version: VersionDescriptorRecord,
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
      messageId: version.messageId ?? undefined,
      originKind: version.originKind as 'agent_generated' | 'user_edit' | 'legacy',
      basedOnVersionId: version.basedOnVersionId ?? undefined
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
