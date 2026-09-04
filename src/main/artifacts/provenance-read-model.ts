import {
  parseVersionHistoryCursor,
  versionHistoryPage,
  VERSION_HISTORY_PAGE_SIZE
} from '../../shared/version-history'
import { ProvenanceIntegrityError } from '../../shared/provenance-read-result'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactExecutionSnapshot,
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionEvidence,
  ArtifactVersionProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest,
  PersistedArtifactExecutionSnapshot,
  ProvenanceExecutionInputFile
} from '../../shared/artifact-provenance'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  sanitizeActivityGroup,
  sanitizeMessageAttribution,
  sanitizeToolActivity
} from '../../shared/session-persistence'
import type {
  ReviewFindingDispositionOutcome,
  ReviewFindingDispositionTrigger,
  ReviewWithProvenanceEvidence
} from '../../shared/reviewer'
import { flagStaleReviews } from '../reviewer/stale-reviews'
import type { ArtifactVersionContentResolver } from '../reviewer/host-sdk'
import { selectReviewChainForArtifactVersion } from '../reviewer/artifact-version-review'
import { toReview } from '../reviewer/repository'
import { loadReviewSubmissionProjection } from '../reviewer/review-submission-read-model'
import type { ArtifactDurability } from './durability'
import {
  parseArtifactExecutionSnapshot,
  validateArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { sha256 } from './provenance-canonical'
import { validateArtifactCoreEvidence } from './provenance-core-evidence'
import {
  decodeArtifactMessageSnapshot,
  decodeReviewScopeSnapshot
} from './provenance-snapshot-decoder'
import { projectPublicArtifactExecutionSnapshot } from './provenance-execution-projection'
import { readOptionalFile, resolveStorageKey } from './provenance-storage'
import type { PersistedVersionFileRecord } from './provenance-version-writer'
import { requireAgentArtifactVersion } from './provenance-version-kind'
import { resolveArtifactContentStatus } from './provenance-content-status'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

class UnsupportedMessageSnapshotVersionError extends Error {}

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
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
    throw new ProvenanceIntegrityError(
      'Artifact Version execution snapshot input metadata mismatch.'
    )
  }
}

type VersionDescriptorRecord = Omit<PersistedVersionFileRecord, 'artifactRunId'> & {
  artifactRunId: string | null
  state: string
  messageId: string | null
  originKind: string
  basedOnVersionId: string | null
}

type ResolvedArtifactExecutionSnapshot = Omit<PersistedArtifactExecutionSnapshot, 'inputFiles'> & {
  inputFiles: ProvenanceExecutionInputFile[]
}

type ArtifactVersionReconstructionProvenance = Omit<ArtifactVersionProvenance, 'execution'> & {
  execution?: ResolvedArtifactExecutionSnapshot
}

type ArtifactProvenanceReadModelOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  loadSession?: (
    projectId: string,
    appSessionId: string
  ) => Promise<PersistedChatSession | undefined>
  createId: () => string
  durability: ArtifactDurability
  reconcileSession: (projectId: string, appSessionId: string) => Promise<unknown>
  projectVersionDescriptor: (
    version: VersionDescriptorRecord,
    projectId: string,
    appSessionId: string
  ) => Promise<ArtifactVersionDescriptor>
  resolveArtifactVersion?: ArtifactVersionContentResolver
  resolveVersionDerivedPath: (
    request: GetArtifactVersionProvenanceRequest,
    filename: string
  ) => Promise<string>
}

class ArtifactProvenanceReadModel {
  constructor(private readonly options: ArtifactProvenanceReadModelOptions) {}

  async getLineage(
    request: GetArtifactLineageRequest
  ): Promise<ArtifactLineageProvenance | undefined> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    let artifactId: string
    try {
      artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    } catch {
      return undefined
    }
    const before = parseVersionHistoryCursor(request.cursor)
    const client = await this.options.getClient()
    const visible = {
      artifactId,
      artifact: { is: { projectId, sessionId: appSessionId } },
      OR: [
        { originKind: 'agent_generated', state: { in: ['pending', 'finalized'] } },
        { originKind: { in: ['user_edit', 'legacy'] }, state: 'finalized' }
      ]
    } satisfies Prisma.ArtifactVersionWhereInput
    const findLineage = (): Promise<Prisma.ArtifactLineageGetPayload<{
      include: { originSession: true }
    }> | null> =>
      client.artifactLineage.findFirst({
        where: { id: artifactId, projectId, sessionId: appSessionId },
        include: { originSession: true }
      })
    let lineage = await findLineage()
    if (!lineage) {
      await this.options.reconcileSession(projectId, appSessionId)
      lineage = await findLineage()
    }
    if (!lineage) return undefined
    const [records, head, exact] = await Promise.all([
      client.artifactVersion.findMany({
        where: { ...visible, ...(before === undefined ? {} : { versionNumber: { lt: before } }) },
        orderBy: { versionNumber: 'desc' },
        take: VERSION_HISTORY_PAGE_SIZE + 1
      }),
      client.artifactVersion.findFirst({ where: visible, orderBy: { versionNumber: 'desc' } }),
      request.versionId
        ? client.artifactVersion.findFirst({ where: { ...visible, id: request.versionId } })
        : undefined
    ])
    const selected = request.versionId ? exact : head
    const basedOn = selected?.basedOnVersionId
      ? await client.artifactVersion.findFirst({
          where: { ...visible, id: selected.basedOnVersionId }
        })
      : undefined
    const project = (version: NonNullable<typeof head>): Promise<ArtifactVersionDescriptor> =>
      this.options.projectVersionDescriptor(version, projectId, appSessionId)
    const [previous, next] = selected
      ? await Promise.all([
          client.artifactVersion.findFirst({
            where: { ...visible, versionNumber: { lt: selected.versionNumber } },
            orderBy: { versionNumber: 'desc' }
          }),
          client.artifactVersion.findFirst({
            where: { ...visible, versionNumber: { gt: selected.versionNumber } },
            orderBy: { versionNumber: 'asc' }
          })
        ])
      : [undefined, undefined]
    const page = versionHistoryPage(records)
    return {
      artifactId: lineage.id,
      filename: lineage.filename,
      originSession: {
        sessionId: lineage.sessionId,
        state: lineage.originSession.state as 'active' | 'deleting' | 'deleted',
        title: lineage.originSession.titleSnapshot ?? undefined,
        deletedAt: lineage.originSession.deletedAt?.toISOString()
      },
      versions: await Promise.all(page.versions.map(project)),
      nextCursor: page.nextCursor,
      previousVersion: previous ? await project(previous) : undefined,
      nextVersion: next ? await project(next) : undefined,
      selectedVersion: selected ? await project(selected) : undefined,
      headVersion: head ? await project(head) : undefined,
      basedOnVersion: basedOn ? await project(basedOn) : undefined
    }
  }

  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections?: { execution: boolean; messages: boolean; review: boolean }
  ): Promise<ArtifactVersionProvenance>
  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections: { execution: boolean; messages: boolean; review: boolean },
    options: { includePrivateHelperSource: true }
  ): Promise<ArtifactVersionReconstructionProvenance>
  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections: { execution: boolean; messages: boolean; review: boolean } = {
      execution: true,
      messages: true,
      review: true
    },
    options?: { includePrivateHelperSource?: boolean }
  ): Promise<ArtifactVersionProvenance | ArtifactVersionReconstructionProvenance> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    const artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const client = await this.options.getClient()
    // Prisma derives the included relation payload from this exact query shape.
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const findVersion = () =>
      client.artifactVersion.findFirst({
        where: {
          id: versionId,
          artifactId,
          originKind: 'agent_generated',
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId, sessionId: appSessionId } }
        },
        include: {
          artifact: true,
          messageSnapshot: true,
          inputs: { orderBy: { ordinal: 'asc' as const } }
        }
      })
    let version = await findVersion()
    if (!version) {
      await this.options.reconcileSession(projectId, appSessionId)
      version = await findVersion()
    }
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)
    const agentVersion = requireAgentArtifactVersion(version)

    const evidenceMirror = await this.readCanonicalMirror(
      resolveStorageKey(this.options.storageRoot, agentVersion.evidenceStorageKey),
      agentVersion.evidenceJson,
      agentVersion.evidenceChecksum,
      `Artifact Version evidence is corrupt: ${versionId}`
    )
    const evidence = JSON.parse(evidenceMirror) as ArtifactVersionEvidence
    validateArtifactCoreEvidence(evidence, version)
    const contentStatus = await resolveArtifactContentStatus({
      storageRoot: this.options.storageRoot,
      projectId,
      sessionId: appSessionId,
      fileId: artifactId,
      versionId,
      contentStorageKey: version.contentStorageKey,
      checksum: version.checksum,
      resolveVersion: this.options.resolveArtifactVersion
    })

    let execution: ArtifactExecutionSnapshot | ResolvedArtifactExecutionSnapshot | undefined
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
        rootFrameId: agentVersion.rootFrameId,
        agentFrameId: agentVersion.agentFrameId,
        messageBranchId: agentVersion.messageBranchId,
        promptMessageId: agentVersion.promptMessageId,
        producerRunId: version.producerRunId,
        producerRunIndex: version.producerRunIndex,
        executionSnapshotChecksum: version.executionSnapshotChecksum,
        evidence
      })
      validateArtifactExecutionInputs(persistedExecution, evidence, version.inputs)
      const projectedInputs = await Promise.all(
        persistedExecution.inputFiles.map((input) => this.projectExecutionInput(input))
      )
      execution = options?.includePrivateHelperSource
        ? { ...persistedExecution, inputFiles: projectedInputs }
        : projectPublicArtifactExecutionSnapshot(persistedExecution, projectedInputs)
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
          throw new ProvenanceIntegrityError('Message snapshot checksum mismatch.')
        }
        const decodedSnapshot = decodeArtifactMessageSnapshot(serializedSnapshot)
        if (decodedSnapshot.status === 'unsupported') {
          throw new UnsupportedMessageSnapshotVersionError()
        }
        if (decodedSnapshot.status === 'corrupt') {
          throw new ProvenanceIntegrityError('Message snapshot schema is invalid.')
        }
        const snapshot = decodedSnapshot.value
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
          throw new ProvenanceIntegrityError('Message snapshot metadata mismatch.')
        }
        if (
          snapshot.schemaVersion === 3 &&
          (!Array.isArray(snapshot.activities) || !Array.isArray(snapshot.activityGroups))
        ) {
          throw new ProvenanceIntegrityError('Message snapshot activity metadata mismatch.')
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
          throw new ProvenanceIntegrityError('Message snapshot activity metadata mismatch.')
        }
        const items = snapshot.messages.map((message) => {
          const attribution = sanitizeMessageAttribution(message.attribution)
          const { attribution: _untrustedAttribution, ...rest } = message
          void _untrustedAttribution
          return attribution ? { ...rest, attribution } : rest
        })
        messages = { state: 'available', items, activities, activityGroups }
      } catch (error) {
        if (!(error instanceof UnsupportedMessageSnapshotVersionError)) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new ProvenanceIntegrityError('Message snapshot file is missing.')
          }
          throw error
        }
        messages = {
          state: 'unavailable',
          reason: 'message-snapshot-unsupported'
        }
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
          const [submission, snapshot] = await Promise.all([
            loadReviewSubmissionProjection(client, reviewRow.id),
            client.reviewScopeSnapshot.findUnique({ where: { reviewId: reviewRow.id } })
          ])
          let scopeSnapshot: ReviewWithProvenanceEvidence['scopeSnapshot'] = {
            state: 'unavailable',
            reason: snapshot ? 'pending' : 'legacy'
          }
          if (snapshot?.state === 'ready') {
            try {
              if (sha256(snapshot.snapshotJson) !== snapshot.checksum) {
                throw new ProvenanceIntegrityError('Review scope snapshot checksum mismatch.')
              }
              const decodedSnapshot = decodeReviewScopeSnapshot(snapshot.snapshotJson)
              if (
                decodedSnapshot.status === 'unsupported' ||
                decodedSnapshot.status === 'corrupt'
              ) {
                throw new ProvenanceIntegrityError('Review scope snapshot schema is invalid.')
              }
              scopeSnapshot = {
                state: 'available',
                blocks: decodedSnapshot.value
              }
            } catch {
              scopeSnapshot = { state: 'unavailable', reason: 'corrupt' }
            }
          }
          return {
            ...toReview(reviewRow),
            ...submission,
            scopeSnapshot
          }
        })
      )
      // Active Sessions are re-resolved before their verdict is projected so edits cannot make an old
      // pass look current. Deleted origins intentionally keep their frozen historical verdict.
      const origin = await client.fileOriginSession.findUnique({
        where: { projectId_sessionId: { projectId, sessionId: version.artifact.sessionId } },
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
              this.options.resolveArtifactVersion
            )
          ).map((candidate, index) => ({ ...provenanceReviews[index]!, stale: candidate.stale }))
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

    const result = {
      descriptor: await this.options.projectVersionDescriptor(
        agentVersion,
        projectId,
        version.artifact.sessionId
      ),
      contentStatus,
      evidence,
      execution,
      messages,
      review
    }
    return options?.includePrivateHelperSource
      ? (result as ArtifactVersionReconstructionProvenance)
      : (result as ArtifactVersionProvenance)
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
    const path = await this.options.resolveVersionDerivedPath(request, 'code-reconstruction.json')
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
    const path = await this.options.resolveVersionDerivedPath(request, 'code-reconstruction.json')
    const temporaryPath = `${path}.${this.options.createId()}.tmp`
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })
      await this.options.durability.syncFile(temporaryPath)
      await rename(temporaryPath, path)
      await this.options.durability.syncDirectory(dirname(path))
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async readCanonicalMirror(
    path: string,
    canonical: string,
    checksum: string,
    corruptMessage: string
  ): Promise<string> {
    if (sha256(canonical) !== checksum) throw new ProvenanceIntegrityError(corruptMessage)
    const bytes = await readOptionalFile(path)
    if (!bytes) return canonical
    const value = bytes.toString('utf8')
    if (value !== canonical || sha256(bytes) !== checksum)
      throw new ProvenanceIntegrityError(corruptMessage)
    return value
  }

  private async projectExecutionInput(
    input: NotebookRunInputFile
  ): Promise<ProvenanceExecutionInputFile> {
    const { storageKey, ...safeInput } = input
    const content = await readOptionalFile(resolveStorageKey(this.options.storageRoot, storageKey))
    return {
      ...safeInput,
      availability: !content
        ? { state: 'unavailable', reason: 'input-content-missing' }
        : sha256(content) === input.checksum
          ? { state: 'available' }
          : { state: 'unavailable', reason: 'input-content-corrupt' }
    }
  }
}

export { ArtifactProvenanceReadModel, projectPublicArtifactExecutionSnapshot }
export type { ArtifactVersionReconstructionProvenance, ResolvedArtifactExecutionSnapshot }
export type { ArtifactProvenanceReadModelOptions }
