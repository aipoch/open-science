import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PrismaClient } from '@prisma/client'

import type {
  ArtifactExecutionSnapshot,
  ArtifactLineageProvenance,
  ArtifactMessageSnapshotFile,
  ArtifactVersionDescriptor,
  ArtifactVersionEvidence,
  ArtifactVersionFile,
  ArtifactVersionProvenance,
  CreateArtifactVersionRequest,
  FinalizeArtifactVersionsRequest,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest,
  PersistedArtifactExecutionSnapshot,
  ProvenanceExecutionInputFile,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS,
  type ResolveArtifactVersionDescriptorsRequest
} from '../../shared/artifacts'
import { ArtifactRepository } from './repository'
import { defaultArtifactDurability, type ArtifactDurability } from './durability'
import {
  ArtifactProvenanceVersionWriter,
  normalizeArtifactFilename as normalizeFilename,
  type PersistedVersionFileRecord
} from './provenance-version-writer'
import { NotebookRunRepository } from '../notebook/repository'
import type { NotebookRunInputFile } from '../../shared/notebook'
import { canonicalJson, sha256 } from './provenance-canonical'
import { ArtifactProvenanceProducerCapture } from './provenance-producer-capture'
import {
  parseArtifactExecutionSnapshot,
  validateArtifactExecutionSnapshot
} from './provenance-execution-evidence'
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
import { readOptionalFile, resolveStorageKey, storageKey } from './provenance-storage'
import { toCheck, toReview } from '../reviewer/repository'
import { selectReviewChainForArtifactVersion } from '../reviewer/artifact-version-review'
import { flagStaleReviews } from '../reviewer/stale-reviews'
import type {
  ReviewFindingDispositionOutcome,
  ReviewFindingDispositionTrigger,
  ReviewScopeSnapshotBlock,
  ReviewWithProvenanceEvidence
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { sanitizeActivityGroup, sanitizeToolActivity } from '../../shared/session-persistence'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ArtifactProvenanceRepositoryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
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

type PersistedExecutionInputRow = {
  ordinal: number
  inputFileVersionId: string
  sourceKind: string
  sourceFileId: string
  sourceVersionNumber: number | null
  sourceCreatedAt: Date | null
  sourceProjectId: string
  sourceSessionId: string
  filename: string
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  storageKey: string
  strongestAssociation: string
}

const validateArtifactExecutionInputs = (
  snapshot: PersistedArtifactExecutionSnapshot,
  evidence: ArtifactVersionEvidence,
  rows: PersistedExecutionInputRow[]
): void => {
  const snapshotKeys = new Set(
    snapshot.inputFiles.map((input) => `${input.sourceKind}\0${input.inputFileVersionId}`)
  )
  const invalidRunKey = snapshot.runs.some((run) =>
    run.inputFileVersionKeys.some(
      (input) => !snapshotKeys.has(`${input.sourceKind}\0${input.inputFileVersionId}`)
    )
  )
  const invalidInput = snapshot.inputFiles.some((input, ordinal) => {
    const evidenceInput = evidence.inputs[ordinal]
    const row = rows[ordinal]
    return (
      !evidenceInput ||
      !row ||
      evidenceInput.ordinal !== ordinal ||
      row.ordinal !== ordinal ||
      input.inputFileVersionId !== evidenceInput.input_file_version_id ||
      input.inputFileVersionId !== row.inputFileVersionId ||
      input.sourceKind !== evidenceInput.source_kind ||
      input.sourceKind !== row.sourceKind ||
      input.sourceFileId !== evidenceInput.source_file_id ||
      input.sourceFileId !== row.sourceFileId ||
      input.sourceVersionNumber !== evidenceInput.source_version_number ||
      input.sourceVersionNumber !== (row.sourceVersionNumber ?? undefined) ||
      input.sourceCreatedAt !== evidenceInput.source_created_at ||
      input.sourceCreatedAt !== row.sourceCreatedAt?.toISOString() ||
      input.sourceProjectId !== evidenceInput.source_project_id ||
      input.sourceProjectId !== row.sourceProjectId ||
      input.sourceSessionId !== evidenceInput.source_session_id ||
      input.sourceSessionId !== row.sourceSessionId ||
      input.filename !== evidenceInput.filename ||
      input.filename !== row.filename ||
      input.contentType !== evidenceInput.content_type ||
      input.contentType !== (row.contentType ?? undefined) ||
      input.sizeBytes !== evidenceInput.size_bytes ||
      input.sizeBytes !== Number(row.sizeBytes) ||
      input.checksum !== evidenceInput.checksum ||
      input.checksum !== row.checksum ||
      input.storageKey !== evidenceInput.storage_key ||
      input.storageKey !== row.storageKey ||
      input.association !== evidenceInput.strongest_association ||
      input.association !== row.strongestAssociation
    )
  })
  if (
    invalidRunKey ||
    invalidInput ||
    snapshot.inputFiles.length !== evidence.inputs.length ||
    snapshot.inputFiles.length !== rows.length
  ) {
    throw new Error('Artifact Version execution snapshot input metadata mismatch.')
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
    this.producerCapture = new ArtifactProvenanceProducerCapture({
      getClient: options.getClient,
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

  // SQLite is the normal read authority. A missing reconciliation mirror must not turn a GET into a
  // filesystem mutation (or make a read-only/Windows volume fail); an existing mirror is still
  // checked byte-for-byte so conflicting durable evidence remains fail-closed.
  private async readCanonicalMirror(
    path: string,
    canonical: string,
    checksum: string,
    corruptMessage: string
  ): Promise<string> {
    if (sha256(canonical) !== checksum) throw new Error(corruptMessage)
    const bytes = await readOptionalFile(path)
    if (!bytes) return canonical
    const value = bytes.toString('utf8')
    if (value !== canonical || sha256(bytes) !== checksum) throw new Error(corruptMessage)
    return value
  }

  private async projectExecutionInput(
    input: NotebookRunInputFile
  ): Promise<ProvenanceExecutionInputFile> {
    const { storageKey: inputStorageKey, ...safeInput } = input
    const content = await readOptionalFile(
      resolveStorageKey(this.options.storageRoot, inputStorageKey)
    )
    return {
      ...safeInput,
      availability: !content
        ? { state: 'unavailable', reason: 'input-content-missing' }
        : sha256(content) === input.checksum
          ? { state: 'available' }
          : { state: 'unavailable', reason: 'input-content-corrupt' }
    }
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
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    let artifactId: string
    try {
      artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    } catch {
      // Legacy managed-file ids can contain Session/message/filename segments. They never identify a
      // native lineage, so absence is the compatible result rather than an IPC-visible validation error.
      return undefined
    }
    const client = await this.options.getClient()
    let lineage = await client.artifactLineage.findFirst({
      where: { id: artifactId, projectId, sessionId: appSessionId },
      include: {
        originSession: true,
        versions: {
          where: { state: { in: ['pending', 'finalized'] } },
          orderBy: [{ versionNumber: 'asc' }, { id: 'asc' }]
        }
      }
    })
    if (!lineage) {
      await this.reconcileSession(projectId, appSessionId)
      lineage = await client.artifactLineage.findFirst({
        where: { id: artifactId, projectId, sessionId: appSessionId },
        include: {
          originSession: true,
          versions: {
            where: { state: { in: ['pending', 'finalized'] } },
            orderBy: [{ versionNumber: 'asc' }, { id: 'asc' }]
          }
        }
      })
    }
    if (!lineage) return undefined

    const versions = await Promise.all(
      lineage.versions.map(async (version) =>
        this.toDescriptor(version, projectId, lineage.sessionId)
      )
    )
    return {
      artifactId: lineage.id,
      filename: lineage.filename,
      originSession: {
        sessionId: lineage.sessionId,
        state: lineage.originSession.state as 'active' | 'deleting' | 'deleted',
        title: lineage.originSession.titleSnapshot ?? undefined,
        deletedAt: lineage.originSession.deletedAt?.toISOString()
      },
      versions
    }
  }

  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections: { execution: boolean; messages: boolean; review: boolean } = {
      execution: true,
      messages: true,
      review: true
    }
  ): Promise<ArtifactVersionProvenance> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    const artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const client = await this.options.getClient()
    let version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        artifactId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: {
        artifact: true,
        messageSnapshot: true,
        inputs: { orderBy: { ordinal: 'asc' } }
      }
    })
    if (!version) {
      await this.reconcileSession(projectId, appSessionId)
      version = await client.artifactVersion.findFirst({
        where: {
          id: versionId,
          artifactId,
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId, sessionId: appSessionId } }
        },
        include: {
          artifact: true,
          messageSnapshot: true,
          inputs: { orderBy: { ordinal: 'asc' } }
        }
      })
    }
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)

    const evidencePath = resolveStorageKey(this.options.storageRoot, version.evidenceStorageKey)
    const evidenceMirror = await this.readCanonicalMirror(
      evidencePath,
      version.evidenceJson,
      version.evidenceChecksum,
      `Artifact Version evidence is corrupt: ${versionId}`
    )
    const evidence = JSON.parse(evidenceMirror) as ArtifactVersionEvidence
    const contentPath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const contentStatus: ArtifactVersionProvenance['contentStatus'] = await readFile(contentPath)
      .then((content) =>
        sha256(content) === version.checksum
          ? ({ state: 'available' } as const)
          : ({ state: 'unavailable', reason: 'checksum-mismatch' } as const)
      )
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return { state: 'unavailable', reason: 'missing' } as const
        }
        throw error
      })

    let execution: ArtifactExecutionSnapshot | undefined
    if (
      sections.execution &&
      version.executionSnapshotJson &&
      version.executionSnapshotChecksum &&
      version.executionSnapshotStorageKey
    ) {
      const executionMirror = await this.readCanonicalMirror(
        resolveStorageKey(this.options.storageRoot, version.executionSnapshotStorageKey),
        version.executionSnapshotJson,
        version.executionSnapshotChecksum,
        `Artifact Version execution snapshot is corrupt: ${versionId}`
      )
      const persistedExecution = parseArtifactExecutionSnapshot(executionMirror)
      validateArtifactExecutionSnapshot(persistedExecution, {
        rootFrameId: version.rootFrameId,
        agentFrameId: version.agentFrameId,
        messageBranchId: version.messageBranchId,
        promptMessageId: version.promptMessageId,
        producerRunId: version.producerRunId,
        producerRunIndex: version.producerRunIndex,
        executionSnapshotChecksum: version.executionSnapshotChecksum,
        evidence
      })
      validateArtifactExecutionInputs(persistedExecution, evidence, version.inputs)
      execution = {
        ...persistedExecution,
        inputFiles: await Promise.all(
          persistedExecution.inputFiles.map((input) => this.projectExecutionInput(input))
        )
      }
    }

    let messages: ArtifactVersionProvenance['messages'] = {
      state: 'unavailable',
      reason: sections.messages ? 'message-snapshot-pending' : 'not-loaded'
    }
    if (sections.messages && version.messageSnapshot?.state === 'ready') {
      try {
        const serializedSnapshot = await readFile(
          resolveStorageKey(this.options.storageRoot, version.messageSnapshot.storageKey),
          'utf8'
        )
        const snapshotChecksum = sha256(serializedSnapshot)
        if (
          version.messageSnapshot.checksum &&
          version.messageSnapshot.checksum !== snapshotChecksum
        ) {
          throw new Error('Message snapshot checksum mismatch.')
        }
        const snapshot = JSON.parse(serializedSnapshot) as ArtifactMessageSnapshotFile
        const hasValidPath = snapshot.messages.every(
          (message, index) =>
            index === 0 || message.parentMessageId === snapshot.messages[index - 1]?.id
        )
        if (
          (snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) ||
          snapshot.snapshotId !== version.messageSnapshot.id ||
          snapshot.rootFrameId !== version.rootFrameId ||
          snapshot.agentFrameId !== version.agentFrameId ||
          snapshot.messageBranchId !== version.messageBranchId ||
          snapshot.terminalMessageId !== version.messageId ||
          snapshot.messages.length !== version.messageSnapshot.messageCount ||
          snapshot.messages.at(-1)?.id !== version.messageId ||
          !hasValidPath
        ) {
          throw new Error('Message snapshot metadata mismatch.')
        }
        if (
          snapshot.schemaVersion === 3 &&
          (!Array.isArray(snapshot.activities) || !Array.isArray(snapshot.activityGroups))
        ) {
          throw new Error('Message snapshot activity metadata mismatch.')
        }
        if (!version.messageSnapshot.checksum) {
          const updated = await client.artifactMessageSnapshot.updateMany({
            where: { id: version.messageSnapshot.id, state: 'ready', checksum: '' },
            data: { checksum: snapshotChecksum }
          })
          if (updated.count !== 1) throw new Error('Message snapshot checksum backfill raced.')
        }
        const rawActivities = snapshot.schemaVersion === 3 ? snapshot.activities : []
        const rawActivityGroups = snapshot.schemaVersion === 3 ? snapshot.activityGroups : []
        const activities = rawActivities.flatMap((activity) => {
          const sanitized = sanitizeToolActivity(activity)
          return sanitized ? [sanitized] : []
        })
        const activityGroups = rawActivityGroups.flatMap((group) => {
          const sanitized = sanitizeActivityGroup(group)
          return sanitized ? [sanitized] : []
        })
        const activityIds = new Set(activities.map((activity) => activity.id))
        if (
          activities.length !== rawActivities.length ||
          activityGroups.length !== rawActivityGroups.length ||
          activityGroups.some((group) =>
            group.activityIds.some((activityId) => !activityIds.has(activityId))
          )
        ) {
          throw new Error('Message snapshot activity metadata mismatch.')
        }
        messages = { state: 'available', items: snapshot.messages, activities, activityGroups }
      } catch {
        messages = { state: 'unavailable', reason: 'message-snapshot-corrupt' }
      }
    }

    let review: ArtifactVersionProvenance['review'] = {
      state: 'unavailable',
      reason: sections.review ? 'not-triggered' : 'not-loaded'
    }
    if (sections.review) {
      const reviewRows = await client.review.findMany({
        where: { projectId, sessionId: version.artifact.sessionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      })
      const provenanceReviews: ReviewWithProvenanceEvidence[] = await Promise.all(
        reviewRows.map(async (reviewRow) => {
          const [checkRows, snapshot] = await Promise.all([
            client.finding.findMany({
              where: { reviewId: reviewRow.id },
              orderBy: [{ sortIndex: 'asc' }, { id: 'asc' }]
            }),
            client.reviewScopeSnapshot.findUnique({ where: { reviewId: reviewRow.id } })
          ])
          let scopeSnapshot: ReviewWithProvenanceEvidence['scopeSnapshot'] = {
            state: 'unavailable',
            reason: snapshot ? 'pending' : 'legacy'
          }
          if (snapshot?.state === 'ready') {
            try {
              const payload = JSON.parse(snapshot.snapshotJson) as {
                schemaVersion?: unknown
                blocks?: unknown
              }
              if (
                (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) ||
                !Array.isArray(payload.blocks) ||
                sha256(snapshot.snapshotJson) !== snapshot.checksum
              ) {
                throw new Error('Review scope snapshot checksum mismatch.')
              }
              scopeSnapshot = {
                state: 'available',
                blocks: payload.blocks as ReviewScopeSnapshotBlock[]
              }
            } catch {
              scopeSnapshot = { state: 'unavailable', reason: 'corrupt' }
            }
          }
          return {
            ...toReview(reviewRow),
            checks: checkRows.map(toCheck),
            scopeSnapshot
          }
        })
      )
      // Active Sessions are re-resolved before their verdict is projected so edits cannot make an old
      // pass look current. Deleted origins intentionally keep their frozen historical verdict: there is
      // no live conversation to recompute and Provenance never offers a re-run from this surface.
      const origin = await client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: { projectId, sessionId: version.artifact.sessionId }
        },
        select: { state: true }
      })
      let sourceSessionUnavailable = false
      let resolvedReviews = provenanceReviews
      if (this.options.loadSession && origin?.state === 'active') {
        const session = await this.options
          .loadSession(projectId, version.artifact.sessionId)
          .catch(() => undefined)
        if (
          !session ||
          session.projectId !== projectId ||
          session.id !== version.artifact.sessionId
        ) {
          sourceSessionUnavailable = provenanceReviews.length > 0
        } else {
          resolvedReviews = (
            await flagStaleReviews(
              provenanceReviews,
              session,
              this.options.storageRoot,
              (request) => this.resolveVersionContent(request)
            )
          ).map((review, index) => ({ ...provenanceReviews[index]!, stale: review.stale }))
        }
      }
      const findingIds = resolvedReviews.flatMap((candidate) =>
        candidate.checks.map((check) => check.id)
      )
      const dispositionRows =
        findingIds.length > 0
          ? await client.reviewFindingDisposition.findMany({
              where: { sourceFindingId: { in: findingIds } },
              orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }]
            })
          : []
      if (sourceSessionUnavailable) {
        review = { state: 'unavailable', reason: 'source-session-unavailable' }
      } else {
        const projection = selectReviewChainForArtifactVersion({
          selectedVersionId: versionId,
          versionMessageId: version.messageId ?? undefined,
          reviews: resolvedReviews,
          dispositions: dispositionRows.map((disposition) => ({
            id: disposition.id,
            sourceFindingId: disposition.sourceFindingId,
            causeReviewId: disposition.causeReviewId ?? undefined,
            sequence: disposition.sequence,
            trigger: disposition.trigger as ReviewFindingDispositionTrigger,
            outcome: disposition.outcome as ReviewFindingDispositionOutcome,
            note: disposition.note ?? undefined,
            assessedArtifactVersionId: disposition.assessedArtifactVersionId ?? undefined,
            createdAt: disposition.createdAt.getTime()
          }))
        })
        if (projection) review = { state: 'available', value: projection }
      }
    }

    return {
      descriptor: await this.toDescriptor(version, projectId, version.artifact.sessionId),
      contentStatus,
      evidence,
      execution,
      messages,
      review
    }
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
    return this.getVersionProvenance(request, {
      execution: false,
      messages: false,
      review: false
    })
  }

  async getVersionExecution(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'execution'>> {
    const value = await this.getVersionProvenance(request, {
      execution: true,
      messages: false,
      review: false
    })
    return { execution: value.execution }
  }

  async getVersionMessages(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'messages'>> {
    const value = await this.getVersionProvenance(request, {
      execution: false,
      messages: true,
      review: false
    })
    return { messages: value.messages }
  }

  async getVersionReview(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'review'>> {
    const value = await this.getVersionProvenance(request, {
      execution: false,
      messages: false,
      review: true
    })
    return { review: value.review }
  }

  async readCodeReconstructionCache(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<string | undefined> {
    const path = await this.resolveVersionDerivedPath(request, 'code-reconstruction.json')
    return readFile(path, 'utf8').catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    })
  }

  async writeCodeReconstructionCache(
    request: GetArtifactVersionProvenanceRequest,
    serialized: string
  ): Promise<void> {
    const path = await this.resolveVersionDerivedPath(request, 'code-reconstruction.json')
    const temporaryPath = `${path}.${this.createId()}.tmp`
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })
      await this.durability.syncFile(temporaryPath)
      await rename(temporaryPath, path)
      await this.durability.syncDirectory(dirname(path))
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
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
