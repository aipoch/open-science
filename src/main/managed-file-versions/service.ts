import { randomUUID } from 'node:crypto'
import {
  parseVersionHistoryCursor,
  versionHistoryPage,
  VERSION_HISTORY_PAGE_SIZE
} from '../../shared/version-history'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  MANAGED_TEXT_EDIT_MAX_BYTES,
  MANAGED_DIFF_MAX_INPUT_BYTES,
  inspectManagedTextEditEligibility,
  type ManagedFileIdentity,
  type ManagedFileSource,
  type ManagedFileVersionDescriptor,
  type ManagedFileVersionDiffRequest,
  type ManagedFileVersionDiffResult,
  type ManagedFileVersionErrorCode,
  type ManagedFileVersionInspectRequest,
  type ManagedFileVersionInspectResult,
  type ManagedFileVersionSaveTextEditRequest,
  type ManagedTextFormat,
  type SaveTextEditResult
} from '../../shared/managed-file-versions'
import { ManagedTextDiffTaskRunner } from './diff-task'
import { ManagedFileVersionError } from './error'
import {
  NodeVersionFileOperator,
  VersionFileOperatorError,
  type PlannedFile,
  type ReadLease,
  type VersionFileOperator,
  type VersionFileRecovery
} from './version-file-operator'
import { sha256 } from '../artifacts/provenance-canonical'
import { normalizeArtifactFilename } from '../artifacts/provenance-version-writer'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'

const COMPLETE_STATE = { artifact: 'finalized', upload: 'ready' } as const
const STORAGE_COLLISION_MAX_ATTEMPTS = 16
const INTEGRITY_AUDIT_BATCH_SIZE = 100
const INTEGRITY_AUDIT_MAX_ERRORS = 1000
const SAFE_STORAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

type ManagedFileVersionRecord = {
  id: string
  fileId: string
  versionNumber: number
  state: string
  managedVisibleAt?: Date | null
  originKind: string
  basedOnVersionId: string | null
  storageTag: string | null
  storedFilename: string | null
  writeOperationId: string | null
  contentStorageKey: string
  filename: string
  originalFilename: string | null
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  createdAt: Date
}

type ManagedLogicalFile = {
  source: ManagedFileSource
  id: string
  projectId: string
  sessionId: string
  displayName: string
  currentVersionId: string | null
}

type ResolvedManagedFileVersion = {
  logicalFile: ManagedLogicalFile
  version: ManagedFileVersionRecord
}

type ManagedFileReadLease = ResolvedManagedFileVersion & {
  path: string
  size: number
  versionToken: number
  snapshot: ManagedFileLeaseSnapshot
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  assertCanCopyTo?: (destinationPath: string) => Promise<void>
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}

type ManagedFileLeaseSnapshot = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
}

type ManagedFileVersionRecoveryResult = {
  recovered: number
  conflicted: number
  failed: number
  integrityErrors: ManagedFileVersionIntegrityError[]
}

type ManagedFileVersionIntegrityError = {
  source: ManagedFileSource
  fileId: string
  versionId: string
  code: 'CONTENT_INTEGRITY_FAILED'
}

type ManagedFileVersionTestFault =
  'after-journal' | 'after-temp-write' | 'after-file-publish' | 'after-file-ready'

type ManagedFileVersionServiceOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  versionFileOperator?: VersionFileOperator & VersionFileRecovery
  createId?: () => string
  now?: () => Date
  testFaultAt?: ManagedFileVersionTestFault
  diffTaskRunner?: Pick<ManagedTextDiffTaskRunner, 'run' | 'cancel'>
}

type AdoptLegacyArtifactRequest = {
  projectId: string
  sessionId: string
  sourceFileId: string
  logicalFilename: string
  content: Uint8Array
  contentType?: string
  messageId?: string
}

type AdoptedLegacyArtifact = {
  fileId: string
  versionId: string
  versionNumber: number
  storageRef: string
  storedFilename: string
  checksum: string
  sizeBytes: number
  contentType?: string
  createdAt: Date
}

type WriteOperationRecord = Prisma.ManagedFileVersionWriteOperationGetPayload<object>
type LegacyArtifactVersionRecord = Prisma.ArtifactVersionGetPayload<object>

const operationError = (code: ManagedFileVersionErrorCode, message: string): never => {
  throw new ManagedFileVersionError(code, message)
}

const translateVersionFileError = (error: unknown, message: string): ManagedFileVersionError => {
  if (error instanceof ManagedFileVersionError) return error
  if (error instanceof VersionFileOperatorError) {
    return new ManagedFileVersionError(error.code, message, { cause: error })
  }
  return new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', message, { cause: error })
}

const isRetryableRecoveryError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? error.code : undefined
  if (code === 'STORAGE_UNAVAILABLE' || code === 'PERMISSION_DENIED') return true
  if (code === 'EIO' || code === 'EBUSY' || code === 'ETIMEDOUT') return true
  return 'cause' in error && isRetryableRecoveryError(error.cause)
}

const assertSafeStorageSegment = (value: string, label: string): string => {
  if (!SAFE_STORAGE_SEGMENT.test(value)) {
    operationError('INVALID_REQUEST', `Invalid ${label}.`)
  }
  return value
}

const toDescriptor = (
  source: ManagedFileSource,
  displayName: string,
  version: ManagedFileVersionRecord
): ManagedFileVersionDescriptor => ({
  id: version.id,
  source,
  fileId: version.fileId,
  versionNumber: version.versionNumber,
  displayName,
  originKind: version.originKind as ManagedFileVersionDescriptor['originKind'],
  basedOnVersionId: version.basedOnVersionId,
  contentType: version.contentType,
  sizeBytes: Number(version.sizeBytes),
  checksum: version.checksum,
  createdAt: version.createdAt.toISOString()
})

const normalizeTextBytes = (content: string, format: ManagedTextFormat): Buffer => {
  if (content.includes('\0')) operationError('CONTAINS_NUL', 'Text content contains NUL bytes.')
  const newline = format.newline === 'crlf' ? '\r\n' : '\n'
  const normalized = content.replace(/\r\n|\r|\n/gu, '\n').replace(/\n/gu, newline)
  const body = Buffer.from(normalized, 'utf8')
  if (new TextDecoder('utf-8', { fatal: true }).decode(body) !== normalized) {
    operationError('INVALID_UTF8', 'Text content is not valid UTF-8.')
  }
  const bytes = format.hasUtf8Bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
  if (bytes.byteLength > MANAGED_TEXT_EDIT_MAX_BYTES) {
    operationError('EDIT_LIMIT_EXCEEDED', 'Text content exceeds the edit size limit.')
  }
  return bytes
}

const isManagedVisibleArtifactVersion = (version: ManagedFileVersionRecord): boolean =>
  version.originKind !== 'agent_generated' || version.managedVisibleAt != null

class ManagedFileVersionService {
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly versionFileOperator: VersionFileOperator & VersionFileRecovery
  private readonly diffTaskRunner: Pick<ManagedTextDiffTaskRunner, 'run' | 'cancel'>
  private readonly activeDiffs = new Map<string, { cancelled: boolean; workerStarted: boolean }>()

  constructor(private readonly options: ManagedFileVersionServiceOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.versionFileOperator =
      options.versionFileOperator ??
      new NodeVersionFileOperator({ storageRoot: options.storageRoot })
    this.diffTaskRunner = options.diffTaskRunner ?? new ManagedTextDiffTaskRunner()
  }

  async adoptLegacyArtifact(request: AdoptLegacyArtifactRequest): Promise<AdoptedLegacyArtifact> {
    assertSafeStorageSegment(request.projectId, 'project id')
    assertSafeStorageSegment(request.sessionId, 'session id')
    assertSafeStorageSegment(request.sourceFileId, 'legacy artifact id')
    if (!(request.content instanceof Uint8Array)) {
      operationError('INVALID_REQUEST', 'Legacy Artifact content must be bytes.')
    }
    assertWithinResourceBudget(
      'file',
      request.content.byteLength,
      LOCAL_RESOURCE_BUDGETS.artifactFileBytes
    )

    const client = await this.options.getClient()
    await this.assertProjectWritable(client, request.projectId)
    const normalizedFilename = normalizeArtifactFilename(request.logicalFilename)
    const bytes = Buffer.from(request.content)
    const checksum = sha256(bytes)
    const lineage = await client.$transaction(async (tx) => {
      const origin = await tx.fileOriginSession.upsert({
        where: {
          projectId_sessionId: {
            projectId: request.projectId,
            sessionId: request.sessionId
          }
        },
        create: { projectId: request.projectId, sessionId: request.sessionId },
        update: {}
      })
      if (origin.state !== 'active' || origin.deletedAt || origin.deletionOperationId) {
        operationError('FILE_DELETED', 'Legacy Artifact origin Session is not active.')
      }

      const existing = await tx.artifactLineage.findUnique({
        where: {
          projectId_sessionId_normalizedFilename: {
            projectId: request.projectId,
            sessionId: request.sessionId,
            normalizedFilename
          }
        }
      })
      if (existing) return existing
      const idOwner = await tx.artifactLineage.findUnique({
        where: { id: request.sourceFileId },
        select: { id: true }
      })
      return tx.artifactLineage.create({
        data: {
          id: idOwner ? this.createId() : request.sourceFileId,
          projectId: request.projectId,
          sessionId: request.sessionId,
          normalizedFilename,
          filename: request.logicalFilename
        }
      })
    })

    if (lineage.currentVersionId) {
      const current = await client.artifactVersion.findFirst({
        where: {
          id: lineage.currentVersionId,
          artifactId: lineage.id,
          state: 'finalized'
        }
      })
      if (!current) {
        operationError('CONTENT_INTEGRITY_FAILED', 'Legacy Artifact head is not finalized.')
      }
      return this.toAdoptedLegacyArtifact(
        current ?? operationError('CONTENT_INTEGRITY_FAILED', 'Legacy Artifact head is missing.')
      )
    }

    const operationId = `legacy-artifact-${sha256(
      JSON.stringify([request.projectId, request.sessionId, lineage.id])
    )}`
    let version = await client.artifactVersion.findUnique({
      where: { writeOperationId: operationId }
    })
    if (version) {
      if (
        version.artifactId !== lineage.id ||
        version.originKind !== 'legacy' ||
        version.filename !== request.logicalFilename ||
        version.checksum !== checksum ||
        version.sizeBytes !== BigInt(bytes.byteLength) ||
        (version.contentType ?? undefined) !== request.contentType
      ) {
        operationError('OPERATION_REUSED', 'Legacy Artifact changed during immutable adoption.')
      }
    } else {
      for (
        let candidateIndex = 0;
        candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
        candidateIndex += 1
      ) {
        const plannedFile = this.versionFileOperator.planImmutable({
          operationId,
          scope: {
            source: 'artifact',
            projectId: request.projectId,
            sessionId: request.sessionId,
            logicalFileId: lineage.id
          },
          logicalFilename: request.logicalFilename,
          candidateIndex
        })
        try {
          version = await client.artifactVersion.create({
            data: {
              id: this.createId(),
              artifactId: lineage.id,
              versionNumber: 1,
              filename: request.logicalFilename,
              originKind: 'legacy',
              writeOperationId: operationId,
              state: 'staging',
              storageTag: `v${plannedFile.versionToken}`,
              storedFilename: plannedFile.storedFilename,
              contentStorageKey: plannedFile.storageRef,
              contentType: request.contentType,
              sizeBytes: BigInt(bytes.byteLength),
              checksum,
              messageId: request.messageId,
              createdAt: this.now()
            }
          })
          break
        } catch (error) {
          const replay = await client.artifactVersion.findUnique({
            where: { writeOperationId: operationId }
          })
          if (replay) {
            version = replay
            break
          }
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'P2002'
          ) {
            continue
          }
          throw error
        }
      }
    }
    let activeVersion =
      version ?? operationError('STORAGE_COLLISION', 'Could not allocate legacy Artifact storage.')
    if (activeVersion.state === 'finalized') {
      const current = await client.artifactLineage.findUniqueOrThrow({ where: { id: lineage.id } })
      if (current.currentVersionId !== activeVersion.id) {
        operationError(
          'CONTENT_INTEGRITY_FAILED',
          'Legacy Artifact version is not the current head.'
        )
      }
      return this.toAdoptedLegacyArtifact(activeVersion)
    }
    if (activeVersion.state !== 'staging') {
      operationError('CONTENT_INTEGRITY_FAILED', 'Legacy Artifact adoption state is invalid.')
    }

    let plannedFile = this.legacyArtifactPlan(request, lineage.id, operationId, activeVersion)
    for (let collisionAttempt = 0; ; collisionAttempt += 1) {
      try {
        await this.versionFileOperator.publishImmutable({
          operationId,
          scope: {
            source: 'artifact',
            projectId: request.projectId,
            sessionId: request.sessionId,
            logicalFileId: lineage.id
          },
          logicalFilename: request.logicalFilename,
          candidateIndex: plannedFile.candidateIndex,
          plannedFile,
          content: bytes
        })
        break
      } catch (error) {
        if (
          !(error instanceof VersionFileOperatorError) ||
          error.reason !== 'DESTINATION_COLLISION' ||
          collisionAttempt + 1 >= STORAGE_COLLISION_MAX_ATTEMPTS
        ) {
          throw translateVersionFileError(error, 'Unable to publish legacy Artifact v1.')
        }
        activeVersion = await this.reallocateLegacyArtifactDestination(
          client,
          request,
          lineage.id,
          operationId,
          activeVersion,
          plannedFile.candidateIndex + 1
        )
        plannedFile = this.legacyArtifactPlan(request, lineage.id, operationId, activeVersion)
      }
    }

    const lease = await this.versionFileOperator.openImmutable(activeVersion.contentStorageKey, {
      sizeBytes: bytes.byteLength,
      checksum
    })
    await lease.close()
    const published = await client.$transaction(async (tx) => {
      const logicalFile = await this.loadLogicalFile(tx, {
        source: 'artifact',
        projectId: request.projectId,
        fileId: lineage.id
      })
      await this.assertPublicationAllowed(tx, logicalFile)
      const current = await tx.artifactLineage.findUniqueOrThrow({ where: { id: lineage.id } })
      if (current.currentVersionId && current.currentVersionId !== activeVersion.id) {
        operationError('VERSION_CONFLICT', 'Legacy Artifact gained a different current version.')
      }
      const finalized = await tx.artifactVersion.update({
        where: { id: activeVersion.id },
        data: { state: 'finalized', managedVisibleAt: this.now() }
      })
      await tx.artifactLineage.update({
        where: { id: lineage.id },
        data: { currentVersionId: finalized.id }
      })
      return finalized
    })
    return this.toAdoptedLegacyArtifact(published)
  }

  async inspect(
    request: ManagedFileVersionInspectRequest
  ): Promise<ManagedFileVersionInspectResult> {
    const resolved = await this.resolveRecord(request)
    let before: number | undefined
    try {
      before = parseVersionHistoryCursor(request.cursor)
    } catch {
      operationError('INVALID_REQUEST', 'Invalid version history cursor.')
    }
    const page = versionHistoryPage(await this.listVersions(resolved.logicalFile, before))
    const head =
      resolved.version.id === resolved.logicalFile.currentVersionId
        ? resolved
        : await this.resolveRecord({
            ...request,
            versionId: resolved.logicalFile.currentVersionId!
          })
    const [previous, next] = await Promise.all([
      this.listVersions(resolved.logicalFile, resolved.version.versionNumber, undefined, 1),
      this.listVersions(resolved.logicalFile, undefined, resolved.version.versionNumber, 1)
    ])
    const writeUnavailableReason = await this.writeUnavailableReason(resolved.logicalFile)
    const eligibility = await this.readTextEligibility(resolved)

    return {
      source: request.source,
      projectId: request.projectId,
      fileId: request.fileId,
      sessionId: resolved.logicalFile.sessionId,
      displayName: resolved.logicalFile.displayName,
      headVersionId: resolved.logicalFile.currentVersionId!,
      selectedVersionId: resolved.version.id,
      versions: page.versions.map((version) =>
        toDescriptor(request.source, resolved.logicalFile.displayName, version)
      ),
      nextCursor: page.nextCursor,
      previousVersion: previous[0]
        ? toDescriptor(request.source, resolved.logicalFile.displayName, previous[0])
        : undefined,
      nextVersion: next[0]
        ? toDescriptor(request.source, resolved.logicalFile.displayName, next[0])
        : undefined,
      selectedVersion: toDescriptor(
        request.source,
        resolved.logicalFile.displayName,
        resolved.version
      ),
      headVersion: toDescriptor(request.source, resolved.logicalFile.displayName, head.version),
      canEdit: eligibility.editable && writeUnavailableReason === undefined,
      canDiff: eligibility.editable && resolved.version.basedOnVersionId !== null,
      ...(eligibility.editable ? { text: eligibility.text, textFormat: eligibility.format } : {}),
      ...(writeUnavailableReason
        ? { unavailableReason: writeUnavailableReason }
        : eligibility.editable
          ? {}
          : { unavailableReason: eligibility.reason })
    }
  }

  async openLatest(request: ManagedFileIdentity): Promise<ManagedFileReadLease> {
    return this.openVersionLease(await this.resolveRecord(request))
  }

  async openVersion(
    request: ManagedFileIdentity,
    versionId: string
  ): Promise<ManagedFileReadLease> {
    return this.openVersionLease(await this.resolveRecord({ ...request, versionId }))
  }

  /**
   * Producer read-back of one exact version that may not be published yet: the lineage head may
   * still be unassigned and an agent-generated version may not be managed-visible until message
   * finalization. Intended for trusted main-process callers that hold the version id they just
   * wrote (for example the Session Plan write-then-verify path); never expose over renderer IPC.
   */
  async openUnpublishedVersion(
    request: ManagedFileIdentity,
    versionId: string
  ): Promise<ManagedFileReadLease> {
    return this.openVersionLease(
      await this.resolveRecord({ ...request, versionId }, { unpublished: true })
    )
  }

  async diffText(request: ManagedFileVersionDiffRequest): Promise<ManagedFileVersionDiffResult> {
    return this.diffVersion(request, request.versionId, request.requestId)
  }

  async diffVersion(
    request: ManagedFileIdentity,
    versionId: string,
    requestId: string
  ): Promise<ManagedFileVersionDiffResult> {
    if (!requestId) operationError('INVALID_REQUEST', 'Diff request id is required.')
    if (this.activeDiffs.has(requestId)) {
      operationError('INVALID_REQUEST', 'Diff request id is already active.')
    }
    const active = { cancelled: false, workerStarted: false }
    this.activeDiffs.set(requestId, active)
    const assertNotCancelled = (): void => {
      if (active.cancelled) operationError('DIFF_CANCELLED', 'Diff request was cancelled.')
    }
    try {
      const selected = await this.resolveRecord({ ...request, versionId })
      assertNotCancelled()
      const baseVersionId = selected.version.basedOnVersionId
      if (!baseVersionId)
        operationError('DIFF_BASE_NOT_FOUND', 'Selected version has no diff base.')
      const ownedBaseVersionId = baseVersionId as string
      const base = await this.resolveRecord({ ...request, versionId: ownedBaseVersionId })
      assertNotCancelled()
      const before = await this.readTextForDiff(base)
      const after = await this.readTextForDiff(selected)
      assertNotCancelled()
      active.workerStarted = true
      const lines = await this.diffTaskRunner.run({ requestId, before, after })
      assertNotCancelled()
      return { baseVersionId: ownedBaseVersionId, selectedVersionId: selected.version.id, lines }
    } finally {
      if (this.activeDiffs.get(requestId) === active) {
        this.activeDiffs.delete(requestId)
      }
    }
  }

  cancelDiff(requestId: string): boolean {
    const active = this.activeDiffs.get(requestId)
    if (!active) return false
    active.cancelled = true
    if (active.workerStarted) this.diffTaskRunner.cancel(requestId)
    return true
  }

  private async resolveRecord(
    request: ManagedFileIdentity & { versionId?: string },
    options: { unpublished?: boolean } = {}
  ): Promise<ResolvedManagedFileVersion> {
    this.assertIdentity(request)
    const client = await this.options.getClient()
    const logicalFile = await this.loadLogicalFile(client, request)
    await this.assertReadable(client, logicalFile)
    const headVersionId = logicalFile.currentVersionId
    if (!options.unpublished) {
      if (!headVersionId) {
        throw new ManagedFileVersionError(
          'VERSION_NOT_FOUND',
          'Managed file has no published version.'
        )
      }
    }
    const versionId = request.versionId ?? headVersionId
    if (!versionId) {
      throw new ManagedFileVersionError('VERSION_NOT_FOUND', 'Managed file version was not found.')
    }
    const version = await this.loadVersion(client, logicalFile, versionId)
    if (!version) {
      throw new ManagedFileVersionError('VERSION_NOT_FOUND', 'Managed file version was not found.')
    }
    if (version.fileId !== logicalFile.id) {
      operationError('VERSION_NOT_IN_FILE', 'Managed file version belongs to another file.')
    }
    if (!options.unpublished) {
      if (request.source === 'artifact' && !isManagedVisibleArtifactVersion(version)) {
        operationError('VERSION_NOT_FOUND', 'Managed file version is not published.')
      }
      if (version.state !== COMPLETE_STATE[request.source]) {
        operationError('VERSION_NOT_FOUND', 'Managed file version is not published.')
      }
    } else if (request.source === 'artifact') {
      // Producer read-back still requires a committed write: a staging row's content is not yet
      // owned by its write operation. 'pending' precedes message finalization; 'finalized' is the
      // ordinary complete state.
      if (version.state !== 'pending' && version.state !== 'finalized') {
        operationError('VERSION_NOT_FOUND', 'Managed file version write has not completed.')
      }
    } else if (version.state !== COMPLETE_STATE.upload) {
      operationError('VERSION_NOT_FOUND', 'Managed file version write has not completed.')
    }
    return { logicalFile, version }
  }

  async saveTextEdit(request: ManagedFileVersionSaveTextEditRequest): Promise<SaveTextEditResult> {
    this.assertSaveRequest(request)
    const client = await this.options.getClient()
    await this.assertProjectWritable(client, request.projectId)
    const logicalFile = await this.loadLogicalFile(client, request)
    await this.assertFileWritable(client, logicalFile)
    // Keep the fast path honest, while publishDatabaseTransaction repeats this barrier under its
    // write transaction to close the race with a concurrent deletion.
    await this.assertPublicationAllowed(client, logicalFile)
    const existing = await client.managedFileVersionWriteOperation.findUnique({
      where: { operationId: request.operationId }
    })
    if (existing) {
      const format = this.parseOperationFormat(existing.textFormatJson)
      const replayBytes = normalizeTextBytes(request.content, format)
      this.assertOperationMatches(existing, request, sha256(replayBytes), replayBytes.byteLength)
      return this.resumeOperation(client, logicalFile, existing, replayBytes, 0, true)
    }
    const headVersionId = logicalFile.currentVersionId
    if (!headVersionId) {
      throw new ManagedFileVersionError(
        'VERSION_NOT_FOUND',
        'Managed file has no published version.'
      )
    }

    const basedOn = await this.loadVersion(client, logicalFile, request.basedOnVersionId)
    if (!basedOn) {
      throw new ManagedFileVersionError('VERSION_NOT_FOUND', 'Base version was not found.')
    }
    if (request.source === 'artifact' && !isManagedVisibleArtifactVersion(basedOn)) {
      operationError('VERSION_NOT_FOUND', 'Base version is not published.')
    }
    if (basedOn.fileId !== logicalFile.id) {
      operationError('VERSION_NOT_IN_FILE', 'Base version belongs to another file.')
    }
    if (basedOn.state !== COMPLETE_STATE[request.source]) {
      operationError('VERSION_NOT_FOUND', 'Base version is not published.')
    }
    const eligibility = await this.readTextEligibility({
      logicalFile,
      version: basedOn
    })
    if (!eligibility.editable) {
      throw new ManagedFileVersionError(
        eligibility.reason,
        'Managed file is not editable as UTF-8 text.'
      )
    }
    const bytes = normalizeTextBytes(request.content, eligibility.format)
    const outputEligibility = inspectManagedTextEditEligibility(logicalFile.displayName, bytes)
    if (!outputEligibility.editable) {
      throw new ManagedFileVersionError(
        outputEligibility.reason,
        'Edited managed file content is not valid UTF-8 text.'
      )
    }
    const contentChecksum = sha256(bytes)
    const head = await this.loadVersion(client, logicalFile, headVersionId)
    if (!head || head.state !== COMPLETE_STATE[request.source]) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file head is not a published version.'
      )
    }

    if (headVersionId !== request.expectedHeadVersionId) {
      return {
        kind: 'conflict',
        expectedHeadVersionId: request.expectedHeadVersionId,
        actualHead: toDescriptor(request.source, logicalFile.displayName, head)
      }
    }

    if (contentChecksum === basedOn.checksum && bytes.byteLength === Number(basedOn.sizeBytes)) {
      return this.noOpResult(client, logicalFile, request, basedOn)
    }

    const operation = await this.createOperation(
      client,
      logicalFile,
      request,
      contentChecksum,
      bytes.byteLength,
      eligibility.format
    )
    this.maybeCrash('after-journal')
    return this.resumeOperation(client, logicalFile, operation, bytes)
  }

  async recoverPendingWrites(): Promise<ManagedFileVersionRecoveryResult> {
    const client = await this.options.getClient()
    const result: ManagedFileVersionRecoveryResult = {
      recovered: 0,
      conflicted: 0,
      failed: 0,
      integrityErrors: []
    }
    let operationCursor: string | undefined
    for (;;) {
      const operations = await client.managedFileVersionWriteOperation.findMany({
        where: {
          state: { in: ['staging', 'file_ready'] },
          ...(operationCursor ? { operationId: { gt: operationCursor } } : {})
        },
        orderBy: { operationId: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE
      })
      for (const operation of operations) {
        try {
          const logicalFile = await this.loadLogicalFile(client, {
            source: operation.source as ManagedFileSource,
            projectId: operation.projectId,
            fileId: operation.sourceFileId
          })
          const resumed = await this.resumeOperation(client, logicalFile, operation)
          if (resumed.kind === 'created') result.recovered += 1
          else if (resumed.kind === 'conflict') result.conflicted += 1
        } catch (error) {
          if (isRetryableRecoveryError(error)) continue
          await this.failOperation(client, operation, 'CONTENT_INTEGRITY_FAILED')
          result.failed += 1
        }
      }
      if (operations.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      operationCursor = operations.at(-1)?.operationId
      if (!operationCursor) break
      await new Promise<void>((resolveRecoveryYield) => setImmediate(resolveRecoveryYield))
    }

    await this.cleanupTerminalOperations(client)
    await this.rebuildHeadProjections(client)
    return result
  }

  async auditActiveVersionIntegrity(): Promise<ManagedFileVersionIntegrityError[]> {
    const client = await this.options.getClient()
    return this.auditActiveVersions(client)
  }

  private legacyArtifactPlan(
    request: AdoptLegacyArtifactRequest,
    fileId: string,
    operationId: string,
    version: Pick<
      LegacyArtifactVersionRecord,
      'contentStorageKey' | 'storedFilename' | 'storageTag'
    >
  ): PlannedFile {
    for (
      let candidateIndex = 0;
      candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
      candidateIndex += 1
    ) {
      const plannedFile = this.versionFileOperator.planImmutable({
        operationId,
        scope: {
          source: 'artifact',
          projectId: request.projectId,
          sessionId: request.sessionId,
          logicalFileId: fileId
        },
        logicalFilename: request.logicalFilename,
        candidateIndex
      })
      if (
        plannedFile.storageRef === version.contentStorageKey &&
        plannedFile.storedFilename === version.storedFilename &&
        `v${plannedFile.versionToken}` === version.storageTag
      ) {
        return plannedFile
      }
    }
    return operationError(
      'CONTENT_INTEGRITY_FAILED',
      'Legacy Artifact has an invalid immutable storage plan.'
    )
  }

  private async reallocateLegacyArtifactDestination(
    client: PrismaClient,
    request: AdoptLegacyArtifactRequest,
    fileId: string,
    operationId: string,
    version: LegacyArtifactVersionRecord,
    firstCandidateIndex: number
  ): Promise<LegacyArtifactVersionRecord> {
    for (
      let candidateIndex = firstCandidateIndex;
      candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
      candidateIndex += 1
    ) {
      const plannedFile = this.versionFileOperator.planImmutable({
        operationId,
        scope: {
          source: 'artifact',
          projectId: request.projectId,
          sessionId: request.sessionId,
          logicalFileId: fileId
        },
        logicalFilename: request.logicalFilename,
        candidateIndex
      })
      try {
        return await client.artifactVersion.update({
          where: { id: version.id, state: 'staging' },
          data: {
            storageTag: `v${plannedFile.versionToken}`,
            storedFilename: plannedFile.storedFilename,
            contentStorageKey: plannedFile.storageRef
          }
        })
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          continue
        }
        throw error
      }
    }
    return operationError('STORAGE_COLLISION', 'Could not reallocate legacy Artifact storage.')
  }

  private toAdoptedLegacyArtifact(
    version: Pick<
      LegacyArtifactVersionRecord,
      | 'id'
      | 'artifactId'
      | 'versionNumber'
      | 'contentStorageKey'
      | 'storedFilename'
      | 'filename'
      | 'checksum'
      | 'sizeBytes'
      | 'contentType'
      | 'createdAt'
    >
  ): AdoptedLegacyArtifact {
    const sizeBytes = Number(version.sizeBytes)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      operationError('CONTENT_INTEGRITY_FAILED', 'Legacy Artifact version metadata is invalid.')
    }
    const storedFilename = version.storedFilename ?? version.filename
    return {
      fileId: version.artifactId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      storageRef: version.contentStorageKey,
      storedFilename,
      checksum: version.checksum,
      sizeBytes,
      contentType: version.contentType ?? undefined,
      createdAt: version.createdAt
    }
  }

  private assertIdentity(request: ManagedFileIdentity & { versionId?: string }): void {
    if (!request || (request.source !== 'artifact' && request.source !== 'upload')) {
      operationError('INVALID_REQUEST', 'Managed file source is invalid.')
    }
    assertSafeStorageSegment(request.projectId, 'project id')
    assertSafeStorageSegment(request.fileId, 'file id')
    if (request.versionId !== undefined) assertSafeStorageSegment(request.versionId, 'version id')
  }

  private assertSaveRequest(request: ManagedFileVersionSaveTextEditRequest): void {
    this.assertIdentity(request)
    assertSafeStorageSegment(request.basedOnVersionId, 'base version id')
    assertSafeStorageSegment(request.expectedHeadVersionId, 'expected head version id')
    assertSafeStorageSegment(request.operationId, 'operation id')
    if (typeof request.content !== 'string') {
      operationError('INVALID_REQUEST', 'Text edit content must be a string.')
    }
    // Every UTF-16 code unit produces at least one UTF-8 byte. Rejecting this conservative bound
    // here prevents oversized renderer input from being copied by newline normalization or Buffer.
    if (request.content.length > MANAGED_TEXT_EDIT_MAX_BYTES) {
      operationError('EDIT_LIMIT_EXCEEDED', 'Text content exceeds the edit size limit.')
    }
  }

  private async assertProjectWritable(client: PrismaClient, projectId: string): Promise<void> {
    const project = await client.project.findUnique({
      where: { id: projectId },
      select: { archivedAt: true }
    })
    const deleting = await client.projectDeletionIntent.findUnique({ where: { projectId } })
    if (!project || project.archivedAt || deleting) {
      operationError('PROJECT_NOT_WRITABLE', 'Project is not writable.')
    }
  }

  private async assertFileWritable(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile
  ): Promise<void> {
    const projection = await client.managedFile.findUnique({
      where: {
        projectId_source_sourceFileId: {
          projectId: logicalFile.projectId,
          source: logicalFile.source,
          sourceFileId: logicalFile.id
        }
      },
      select: { deletedAt: true }
    })
    if (projection?.deletedAt) operationError('FILE_DELETED', 'Managed file is deleted.')
  }

  private async assertReadable(
    client: PrismaClient | Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile
  ): Promise<void> {
    const [project, deleting, origin, sync, projection] = await Promise.all([
      client.project.findUnique({
        where: { id: logicalFile.projectId },
        select: { id: true }
      }),
      client.projectDeletionIntent.findUnique({
        where: { projectId: logicalFile.projectId },
        select: { projectId: true }
      }),
      client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { state: true, deletedAt: true, deletionOperationId: true }
      }),
      client.managedFileSessionSync.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      }),
      client.managedFile.findUnique({
        where: {
          projectId_source_sourceFileId: {
            projectId: logicalFile.projectId,
            source: logicalFile.source,
            sourceFileId: logicalFile.id
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      })
    ])
    if (!project) operationError('FILE_NOT_FOUND', 'Managed file project was not found.')
    if (
      deleting ||
      (origin && (origin.state !== 'active' || origin.deletedAt || origin.deletionOperationId)) ||
      sync?.deletedAt ||
      sync?.deleteOperationId ||
      projection?.deletedAt ||
      projection?.deleteOperationId
    ) {
      operationError('FILE_DELETED', 'Managed file or its Session is deleted.')
    }
  }

  private async assertPublicationAllowed(
    client: PrismaClient | Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile
  ): Promise<void> {
    const [project, deleting, origin, sync, projection] = await Promise.all([
      client.project.findUnique({
        where: { id: logicalFile.projectId },
        select: { archivedAt: true }
      }),
      client.projectDeletionIntent.findUnique({
        where: { projectId: logicalFile.projectId },
        select: { projectId: true }
      }),
      client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { state: true, deletedAt: true, deletionOperationId: true }
      }),
      client.managedFileSessionSync.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      }),
      client.managedFile.findUnique({
        where: {
          projectId_source_sourceFileId: {
            projectId: logicalFile.projectId,
            source: logicalFile.source,
            sourceFileId: logicalFile.id
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      })
    ])
    if (!project || project.archivedAt || deleting) {
      operationError('PROJECT_NOT_WRITABLE', 'Project is not writable.')
    }
    if (
      (origin && (origin.state !== 'active' || origin.deletedAt || origin.deletionOperationId)) ||
      sync?.deletedAt ||
      sync?.deleteOperationId ||
      projection?.deletedAt ||
      projection?.deleteOperationId
    ) {
      operationError('FILE_DELETED', 'Managed file or its Session is deleted.')
    }
  }

  private async writeUnavailableReason(
    logicalFile: ManagedLogicalFile
  ): Promise<'PROJECT_NOT_WRITABLE' | 'FILE_DELETED' | undefined> {
    const client = await this.options.getClient()
    const [project, deleting, origin, sync, projection] = await Promise.all([
      client.project.findUnique({
        where: { id: logicalFile.projectId },
        select: { archivedAt: true }
      }),
      client.projectDeletionIntent.findUnique({
        where: { projectId: logicalFile.projectId },
        select: { projectId: true }
      }),
      client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { state: true, deletedAt: true, deletionOperationId: true }
      }),
      client.managedFileSessionSync.findUnique({
        where: {
          projectId_sessionId: {
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      }),
      client.managedFile.findUnique({
        where: {
          projectId_source_sourceFileId: {
            projectId: logicalFile.projectId,
            source: logicalFile.source,
            sourceFileId: logicalFile.id
          }
        },
        select: { deletedAt: true, deleteOperationId: true }
      })
    ])
    if (
      (origin && (origin.state !== 'active' || origin.deletedAt || origin.deletionOperationId)) ||
      sync?.deletedAt ||
      sync?.deleteOperationId ||
      projection?.deletedAt ||
      projection?.deleteOperationId
    ) {
      return 'FILE_DELETED'
    }
    if (!project || project.archivedAt || deleting) return 'PROJECT_NOT_WRITABLE'
    return undefined
  }

  private async loadLogicalFile(
    client: PrismaClient | Prisma.TransactionClient,
    request: { source: ManagedFileSource; projectId: string; fileId: string }
  ): Promise<ManagedLogicalFile> {
    if (request.source === 'artifact') {
      const file = await client.artifactLineage.findFirst({
        where: { id: request.fileId, projectId: request.projectId },
        select: {
          id: true,
          projectId: true,
          sessionId: true,
          filename: true,
          currentVersionId: true
        }
      })
      if (!file) {
        throw new ManagedFileVersionError('FILE_NOT_FOUND', 'Managed Artifact was not found.')
      }
      return { source: 'artifact', displayName: file.filename, ...file }
    }
    const file = await client.uploadFile.findFirst({
      where: { id: request.fileId, projectId: request.projectId },
      select: {
        id: true,
        projectId: true,
        sessionId: true,
        filename: true,
        originalFilename: true,
        currentVersionId: true
      }
    })
    if (!file) {
      throw new ManagedFileVersionError('FILE_NOT_FOUND', 'Managed Upload was not found.')
    }
    return {
      source: 'upload',
      id: file.id,
      projectId: file.projectId,
      sessionId: file.sessionId,
      displayName: file.originalFilename || file.filename,
      currentVersionId: file.currentVersionId
    }
  }

  private async loadVersion(
    client: PrismaClient | Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile,
    versionId: string
  ): Promise<ManagedFileVersionRecord | null> {
    if (logicalFile.source === 'artifact') {
      const version = await client.artifactVersion.findUnique({ where: { id: versionId } })
      return version
        ? {
            ...version,
            fileId: version.artifactId,
            originalFilename: null,
            createdAt: version.createdAt
          }
        : null
    }
    const version = await client.uploadVersion.findUnique({ where: { id: versionId } })
    return version
      ? {
          ...version,
          fileId: version.uploadFileId,
          createdAt: version.createdAt ?? version.registeredAt
        }
      : null
  }

  private async listVersions(
    logicalFile: ManagedLogicalFile,
    before?: number,
    after?: number,
    take = VERSION_HISTORY_PAGE_SIZE + 1
  ): Promise<ManagedFileVersionRecord[]> {
    const client = await this.options.getClient()
    if (logicalFile.source === 'artifact') {
      const versions = await client.artifactVersion.findMany({
        where: {
          artifactId: logicalFile.id,
          ...(before === undefined
            ? after === undefined
              ? {}
              : { versionNumber: { gt: after } }
            : { versionNumber: { lt: before } }),
          state: 'finalized',
          OR: [{ originKind: { not: 'agent_generated' } }, { managedVisibleAt: { not: null } }]
        },
        orderBy: { versionNumber: after === undefined ? 'desc' : 'asc' },
        take
      })
      return versions.map((version) => ({
        ...version,
        fileId: version.artifactId,
        originalFilename: null,
        createdAt: version.createdAt
      }))
    }
    const versions = await client.uploadVersion.findMany({
      where: {
        uploadFileId: logicalFile.id,
        state: 'ready',
        ...(before === undefined
          ? after === undefined
            ? {}
            : { versionNumber: { gt: after } }
          : { versionNumber: { lt: before } })
      },
      orderBy: { versionNumber: after === undefined ? 'desc' : 'asc' },
      take
    })
    return versions.map((version) => ({
      ...version,
      fileId: version.uploadFileId,
      createdAt: version.createdAt ?? version.registeredAt
    }))
  }

  private async openVersionLease(
    resolved: ResolvedManagedFileVersion
  ): Promise<ManagedFileReadLease> {
    let operatorLease: ReadLease
    try {
      operatorLease = await this.versionFileOperator.openImmutable(
        resolved.version.contentStorageKey,
        {
          sizeBytes: Number(resolved.version.sizeBytes),
          checksum: resolved.version.checksum
        }
      )
    } catch (error) {
      throw translateVersionFileError(
        error,
        'Managed file version content is unavailable or corrupt.'
      )
    }

    const versionToken = resolved.version.createdAt.getTime()
    const snapshot: ManagedFileLeaseSnapshot = {
      dev: 0n,
      ino: BigInt(`0x${resolved.version.checksum.slice(0, 16)}`),
      size: BigInt(operatorLease.sizeBytes),
      mtimeNs: BigInt(versionToken) * 1_000_000n
    }
    return {
      ...resolved,
      path: operatorLease.localPath,
      size: operatorLease.sizeBytes,
      versionToken,
      snapshot,
      read: async (buffer, offset, length, position) => {
        if (position >= operatorLease.sizeBytes || length <= 0) return { bytesRead: 0 }
        const end = Math.min(position + length, operatorLease.sizeBytes)
        const bytes = await operatorLease.readRange(position, end)
        buffer.set(bytes, offset)
        return { bytesRead: bytes.byteLength }
      },
      readRange: operatorLease.readRange,
      copyTo: (destinationPath, options) => operatorLease.copyTo(destinationPath, options),
      assertCanCopyTo: operatorLease.assertCanCopyTo,
      verifyUnchanged: operatorLease.verifyUnchanged,
      close: operatorLease.close
    }
  }

  private async readTextEligibility(
    resolved: ResolvedManagedFileVersion
  ): Promise<ReturnType<typeof inspectManagedTextEditEligibility>> {
    if (resolved.version.sizeBytes > BigInt(MANAGED_TEXT_EDIT_MAX_BYTES)) {
      return { editable: false, reason: 'EDIT_LIMIT_EXCEEDED' }
    }
    let lease: ManagedFileReadLease | undefined
    try {
      lease = await this.openVersionLease(resolved)
      const bytes = lease.size === 0 ? new Uint8Array() : await lease.readRange(0, lease.size)
      return inspectManagedTextEditEligibility(resolved.logicalFile.displayName, bytes)
    } finally {
      await lease?.close().catch(() => undefined)
    }
  }

  private async readTextForDiff(resolved: ResolvedManagedFileVersion): Promise<string> {
    if (resolved.version.sizeBytes > BigInt(MANAGED_DIFF_MAX_INPUT_BYTES)) {
      operationError('DIFF_INPUT_LIMIT_EXCEEDED', 'Managed file exceeds the diff input limit.')
    }
    const eligibility = await this.readTextEligibility(resolved)
    if (!eligibility.editable) {
      if (eligibility.reason === 'EDIT_LIMIT_EXCEEDED') {
        operationError('DIFF_INPUT_LIMIT_EXCEEDED', 'Managed file exceeds the diff input limit.')
      }
      operationError(eligibility.reason, 'Managed file is not eligible for text diff.')
    }
    return (eligibility as Extract<typeof eligibility, { editable: true }>).text
  }

  private async verifyResolvedVersion(resolved: ResolvedManagedFileVersion): Promise<void> {
    const lease = await this.openVersionLease(resolved)
    await lease.close()
  }

  private async createOperation(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    request: ManagedFileVersionSaveTextEditRequest,
    checksum: string,
    sizeBytes: number,
    format: ManagedTextFormat
  ): Promise<WriteOperationRecord> {
    for (let attempt = 0; attempt < STORAGE_COLLISION_MAX_ATTEMPTS; attempt += 1) {
      const plannedFile = this.versionFileOperator.planImmutable({
        operationId: request.operationId,
        scope: {
          source: logicalFile.source,
          projectId: logicalFile.projectId,
          sessionId: logicalFile.sessionId,
          logicalFileId: logicalFile.id
        },
        logicalFilename: logicalFile.displayName,
        candidateIndex: attempt
      })
      const storageTag = `v${plannedFile.versionToken}`
      const storedFilename = plannedFile.storedFilename
      const contentStorageKey = plannedFile.storageRef
      const existingKey = await client.managedFileVersionWriteOperation.findFirst({
        where: { contentStorageKey },
        select: { operationId: true }
      })
      if (existingKey) continue
      try {
        return await client.managedFileVersionWriteOperation.create({
          data: {
            operationId: request.operationId,
            source: logicalFile.source,
            projectId: logicalFile.projectId,
            sourceFileId: logicalFile.id,
            basedOnVersionId: request.basedOnVersionId,
            expectedHeadVersionId: request.expectedHeadVersionId,
            state: 'staging',
            storageTag,
            storedFilename,
            contentStorageKey,
            checksum,
            sizeBytes: BigInt(sizeBytes),
            textFormatJson: JSON.stringify(format)
          }
        })
      } catch (error) {
        const existing = await client.managedFileVersionWriteOperation.findUnique({
          where: { operationId: request.operationId }
        })
        if (existing) {
          this.assertOperationMatches(existing, request, checksum, sizeBytes)
          return existing
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          continue
        }
        throw error
      }
    }
    throw new ManagedFileVersionError(
      'STORAGE_COLLISION',
      'Could not allocate immutable managed file storage.'
    )
  }

  private assertOperationMatches(
    operation: WriteOperationRecord,
    request: ManagedFileVersionSaveTextEditRequest,
    checksum: string,
    sizeBytes: number
  ): void {
    if (
      operation.source !== request.source ||
      operation.projectId !== request.projectId ||
      operation.sourceFileId !== request.fileId ||
      operation.basedOnVersionId !== request.basedOnVersionId ||
      operation.expectedHeadVersionId !== request.expectedHeadVersionId ||
      operation.checksum !== checksum ||
      operation.sizeBytes !== BigInt(sizeBytes)
    ) {
      operationError('OPERATION_REUSED', 'Write operation id was reused for another edit.')
    }
  }

  private parseOperationFormat(value: string): ManagedTextFormat {
    try {
      const parsed = JSON.parse(value) as Partial<ManagedTextFormat>
      if (
        (parsed.newline !== 'lf' && parsed.newline !== 'crlf') ||
        typeof parsed.hasUtf8Bom !== 'boolean' ||
        typeof parsed.hasTrailingNewline !== 'boolean'
      ) {
        throw new Error('invalid text format')
      }
      return parsed as ManagedTextFormat
    } catch (error) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file write operation has an invalid text format.',
        { cause: error }
      )
    }
  }

  private async resumeOperation(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    initialOperation: WriteOperationRecord,
    bytes?: Buffer,
    collisionAttempt = 0,
    recoverExistingAttempt = false
  ): Promise<SaveTextEditResult> {
    const operation = initialOperation
    if (operation.state === 'published') return this.publishedResult(client, logicalFile, operation)
    if (operation.state === 'conflict') return this.conflictResult(client, logicalFile, operation)
    if (operation.state === 'failed') {
      operationError('CONTENT_INTEGRITY_FAILED', 'Managed file write operation failed recovery.')
    }

    return this.resumeVersionFileOperation(
      client,
      logicalFile,
      operation,
      bytes,
      collisionAttempt,
      recoverExistingAttempt
    )
  }

  private plannedFileForOperation(
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): PlannedFile {
    for (
      let candidateIndex = 0;
      candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
      candidateIndex += 1
    ) {
      const plannedFile = this.versionFileOperator.planImmutable({
        operationId: operation.operationId,
        scope: {
          source: logicalFile.source,
          projectId: logicalFile.projectId,
          sessionId: logicalFile.sessionId,
          logicalFileId: logicalFile.id
        },
        logicalFilename: logicalFile.displayName,
        candidateIndex
      })
      if (
        plannedFile.storageRef === operation.contentStorageKey &&
        plannedFile.storedFilename === operation.storedFilename &&
        `v${plannedFile.versionToken}` === operation.storageTag
      ) {
        return plannedFile
      }
    }
    return operationError(
      'CONTENT_INTEGRITY_FAILED',
      'Managed file write operation has an invalid immutable storage plan.'
    )
  }

  private async resumeVersionFileOperation(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    initialOperation: WriteOperationRecord,
    bytes?: Buffer,
    collisionAttempt = 0,
    recoverExistingAttempt = false
  ): Promise<SaveTextEditResult> {
    let operation = initialOperation
    const expectedIntegrity = {
      sizeBytes: Number(operation.sizeBytes),
      checksum: operation.checksum
    }

    if (operation.state === 'staging') {
      const plannedFile = this.plannedFileForOperation(logicalFile, operation)
      const recoveryPlan = {
        operationId: operation.operationId,
        scope: {
          source: logicalFile.source,
          projectId: logicalFile.projectId,
          sessionId: logicalFile.sessionId,
          logicalFileId: logicalFile.id
        },
        logicalFilename: logicalFile.displayName,
        candidateIndex: plannedFile.candidateIndex,
        plannedFile
      }
      if (bytes) {
        try {
          let shouldPublish = true
          if (recoverExistingAttempt) {
            const inspection = await this.versionFileOperator.inspectRecovery({
              ...recoveryPlan,
              expectedIntegrity
            })
            if (inspection.state === 'complete') {
              shouldPublish = false
            } else if (inspection.state === 'incomplete') {
              const removable = await this.isOperationStorageUnowned(client, operation, ['staging'])
              if (!removable) {
                operationError(
                  'CONTENT_INTEGRITY_FAILED',
                  'Incomplete managed version storage is no longer owned by its write operation.'
                )
              }
              await this.versionFileOperator.removeIncomplete({
                ...recoveryPlan,
                actualIntegrity: inspection.actualIntegrity
              })
            }
          }
          if (shouldPublish) {
            const stored = await this.versionFileOperator.publishImmutable({
              ...recoveryPlan,
              content: bytes
            })
            if (
              stored.storageRef !== operation.contentStorageKey ||
              stored.storedFilename !== operation.storedFilename ||
              stored.sizeBytes !== expectedIntegrity.sizeBytes ||
              stored.checksum !== expectedIntegrity.checksum
            ) {
              operationError(
                'CONTENT_INTEGRITY_FAILED',
                'Version file operator returned a mismatched publication.'
              )
            }
          }
        } catch (error) {
          if (
            error instanceof VersionFileOperatorError &&
            error.reason === 'DESTINATION_COLLISION'
          ) {
            if (collisionAttempt + 1 >= STORAGE_COLLISION_MAX_ATTEMPTS) {
              await this.failOperation(client, operation, 'STORAGE_COLLISION', false)
              operationError('STORAGE_COLLISION', 'Managed version destination already exists.')
            }
            const reallocated = await this.reallocateOperationDestination(
              client,
              logicalFile,
              operation
            )
            return this.resumeVersionFileOperation(
              client,
              logicalFile,
              reallocated,
              bytes,
              collisionAttempt + 1,
              false
            )
          }
          throw translateVersionFileError(error, 'Unable to publish immutable managed file.')
        }
        this.maybeCrash('after-temp-write')
      } else {
        const inspection = await this.versionFileOperator.inspectRecovery({
          ...recoveryPlan,
          expectedIntegrity
        })
        if (inspection.state !== 'complete') {
          await this.failOperation(client, operation, 'CONTENT_INTEGRITY_FAILED', false)
          if (inspection.state === 'incomplete') {
            const removable = await this.isOperationStorageUnowned(client, operation, ['failed'])
            if (removable) {
              await this.versionFileOperator.removeIncomplete({
                ...recoveryPlan,
                actualIntegrity: inspection.actualIntegrity
              })
            }
          }
          operationError(
            'CONTENT_INTEGRITY_FAILED',
            'Managed file write bytes are unavailable for recovery.'
          )
        }
      }

      this.maybeCrash('after-file-publish')
      const advanced = await client.managedFileVersionWriteOperation.updateMany({
        where: { operationId: operation.operationId, state: 'staging' },
        data: { state: 'file_ready', errorCode: null }
      })
      operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: operation.operationId }
      })
      if (advanced.count !== 1) {
        if (operation.state === 'published') {
          return this.publishedResult(client, logicalFile, operation)
        }
        if (operation.state === 'conflict') {
          return this.conflictResult(client, logicalFile, operation)
        }
        if (operation.state !== 'file_ready') {
          operationError('CONTENT_INTEGRITY_FAILED', 'Managed file write state is invalid.')
        }
      }
      this.maybeCrash('after-file-ready')
    }

    try {
      const lease = await this.versionFileOperator.openImmutable(
        operation.contentStorageKey,
        expectedIntegrity
      )
      await lease.close()
    } catch (error) {
      const translated = translateVersionFileError(error, 'Managed version publication is corrupt.')
      if (!isRetryableRecoveryError(translated)) {
        await this.failOperation(client, operation, 'CONTENT_INTEGRITY_FAILED')
      }
      throw translated
    }
    const result = await this.publishDatabaseTransaction(client, logicalFile, operation)
    if (result.kind === 'conflict') await this.removeFinalIfUnowned(client, operation)
    return result
  }

  private async reallocateOperationDestination(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): Promise<WriteOperationRecord> {
    const planFor = (candidateIndex: number): PlannedFile =>
      this.versionFileOperator.planImmutable({
        operationId: operation.operationId,
        scope: {
          source: logicalFile.source,
          projectId: logicalFile.projectId,
          sessionId: logicalFile.sessionId,
          logicalFileId: logicalFile.id
        },
        logicalFilename: logicalFile.displayName,
        candidateIndex
      })
    let nextCandidateIndex = 0
    for (
      let candidateIndex = 0;
      candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
      candidateIndex += 1
    ) {
      if (planFor(candidateIndex).storageRef === operation.contentStorageKey) {
        nextCandidateIndex = candidateIndex + 1
        break
      }
    }
    for (
      let candidateIndex = nextCandidateIndex;
      candidateIndex < STORAGE_COLLISION_MAX_ATTEMPTS;
      candidateIndex += 1
    ) {
      const plannedFile = planFor(candidateIndex)
      const storageTag = `v${plannedFile.versionToken}`
      const storedFilename = plannedFile.storedFilename
      const contentStorageKey = plannedFile.storageRef
      try {
        return await client.managedFileVersionWriteOperation.update({
          where: { operationId: operation.operationId, state: 'staging' },
          data: { storageTag, storedFilename, contentStorageKey }
        })
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          continue
        }
        throw error
      }
    }
    await this.failOperation(client, operation, 'STORAGE_COLLISION', false)
    throw new ManagedFileVersionError(
      'STORAGE_COLLISION',
      'Could not reallocate immutable managed file storage.'
    )
  }

  private async publishDatabaseTransaction(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): Promise<SaveTextEditResult> {
    return client.$transaction(async (tx) => {
      const currentFile = await this.loadLogicalFile(tx, {
        source: logicalFile.source,
        projectId: logicalFile.projectId,
        fileId: logicalFile.id
      })
      await this.assertPublicationAllowed(tx, currentFile)
      if (currentFile.currentVersionId !== operation.expectedHeadVersionId) {
        const conflicted = await tx.managedFileVersionWriteOperation.updateMany({
          where: { operationId: operation.operationId, state: 'file_ready' },
          data: { state: 'conflict', errorCode: 'VERSION_CONFLICT' }
        })
        if (conflicted.count !== 1) {
          const currentOperation = await tx.managedFileVersionWriteOperation.findUniqueOrThrow({
            where: { operationId: operation.operationId }
          })
          if (currentOperation.state === 'published') {
            const publishedVersion = await this.loadVersion(
              tx,
              currentFile,
              currentOperation.resultVersionId ?? ''
            )
            this.assertPublishedVersionMatches(currentOperation, currentFile, publishedVersion)
            return {
              kind: 'created',
              replayed: true,
              version: toDescriptor(logicalFile.source, logicalFile.displayName, publishedVersion),
              headVersionId: publishedVersion.id
            }
          }
        }
        const actualHead = currentFile.currentVersionId
          ? await this.loadVersion(tx, currentFile, currentFile.currentVersionId)
          : null
        if (!actualHead) {
          throw new ManagedFileVersionError(
            'CONTENT_INTEGRITY_FAILED',
            'Actual head is unavailable.'
          )
        }
        return {
          kind: 'conflict',
          expectedHeadVersionId: operation.expectedHeadVersionId,
          actualHead: toDescriptor(logicalFile.source, logicalFile.displayName, actualHead)
        }
      }
      const basedOn = await this.loadVersion(tx, currentFile, operation.basedOnVersionId)
      if (
        !basedOn ||
        basedOn.state !== COMPLETE_STATE[logicalFile.source] ||
        (logicalFile.source === 'artifact' && !isManagedVisibleArtifactVersion(basedOn))
      ) {
        throw new ManagedFileVersionError(
          'VERSION_NOT_FOUND',
          'Base version is unavailable during publication.'
        )
      }
      const maxVersionNumber = await this.maxVersionNumber(tx, logicalFile)
      const versionId = this.createId()
      const createdAt = this.now()
      const version = await this.insertUserEditVersion(
        tx,
        logicalFile,
        operation,
        versionId,
        maxVersionNumber + 1,
        basedOn,
        createdAt
      )
      await this.advanceHead(tx, logicalFile, operation.expectedHeadVersionId, versionId)
      await this.upsertProjection(tx, logicalFile, version, createdAt)
      const published = await tx.managedFileVersionWriteOperation.updateMany({
        where: { operationId: operation.operationId, state: 'file_ready' },
        data: { state: 'published', resultVersionId: versionId, errorCode: null }
      })
      if (published.count !== 1) {
        operationError('CONTENT_INTEGRITY_FAILED', 'Managed file write lost publication ownership.')
      }
      return {
        kind: 'created',
        replayed: false,
        version: toDescriptor(logicalFile.source, logicalFile.displayName, version),
        headVersionId: versionId
      }
    })
  }

  private async maxVersionNumber(
    tx: Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile
  ): Promise<number> {
    if (logicalFile.source === 'artifact') {
      return (
        (
          await tx.artifactVersion.aggregate({
            where: { artifactId: logicalFile.id },
            _max: { versionNumber: true }
          })
        )._max.versionNumber ?? 0
      )
    }
    return (
      (
        await tx.uploadVersion.aggregate({
          where: { uploadFileId: logicalFile.id },
          _max: { versionNumber: true }
        })
      )._max.versionNumber ?? 0
    )
  }

  private async insertUserEditVersion(
    tx: Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord,
    versionId: string,
    versionNumber: number,
    basedOn: ManagedFileVersionRecord,
    createdAt: Date
  ): Promise<ManagedFileVersionRecord> {
    if (logicalFile.source === 'artifact') {
      const version = await tx.artifactVersion.create({
        data: {
          id: versionId,
          artifactId: logicalFile.id,
          versionNumber,
          filename: logicalFile.displayName,
          originKind: 'user_edit',
          basedOnVersionId: basedOn.id,
          storageTag: operation.storageTag,
          storedFilename: operation.storedFilename,
          writeOperationId: operation.operationId,
          state: 'finalized',
          managedVisibleAt: createdAt,
          contentStorageKey: operation.contentStorageKey,
          contentType: basedOn.contentType,
          sizeBytes: operation.sizeBytes,
          checksum: operation.checksum,
          createdAt
        }
      })
      return { ...version, fileId: version.artifactId, originalFilename: null, createdAt }
    }
    const version = await tx.uploadVersion.create({
      data: {
        id: versionId,
        uploadFileId: logicalFile.id,
        versionNumber,
        state: 'ready',
        originKind: 'user_edit',
        basedOnVersionId: basedOn.id,
        storageTag: operation.storageTag,
        storedFilename: operation.storedFilename,
        writeOperationId: operation.operationId,
        contentStorageKey: operation.contentStorageKey,
        filename: logicalFile.displayName,
        originalFilename: logicalFile.displayName,
        contentType: basedOn.contentType,
        sizeBytes: operation.sizeBytes,
        checksum: operation.checksum,
        createdAt
      }
    })
    return { ...version, fileId: version.uploadFileId, createdAt }
  }

  private async advanceHead(
    tx: Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile,
    expectedHeadVersionId: string,
    resultVersionId: string
  ): Promise<void> {
    const updated =
      logicalFile.source === 'artifact'
        ? await tx.artifactLineage.updateMany({
            where: { id: logicalFile.id, currentVersionId: expectedHeadVersionId },
            data: { currentVersionId: resultVersionId }
          })
        : await tx.uploadFile.updateMany({
            where: { id: logicalFile.id, currentVersionId: expectedHeadVersionId },
            data: { currentVersionId: resultVersionId }
          })
    if (updated.count !== 1) operationError('VERSION_CONFLICT', 'Managed file head changed.')
  }

  private async upsertProjection(
    tx: Prisma.TransactionClient,
    logicalFile: ManagedLogicalFile,
    version: ManagedFileVersionRecord,
    timestamp: Date
  ): Promise<void> {
    await tx.managedFile.upsert({
      where: {
        projectId_source_sourceFileId: {
          projectId: logicalFile.projectId,
          source: logicalFile.source,
          sourceFileId: logicalFile.id
        }
      },
      create: {
        source: logicalFile.source,
        sourceFileId: logicalFile.id,
        sourceVersionId: version.id,
        checksum: version.checksum,
        projectId: logicalFile.projectId,
        sessionId: logicalFile.sessionId,
        displayName: logicalFile.displayName,
        storageKey: version.contentStorageKey,
        mimeType: version.contentType,
        sizeBytes: version.sizeBytes,
        mtimeMs: BigInt(timestamp.getTime()),
        sortAtMs: BigInt(timestamp.getTime())
      },
      update: {
        sourceVersionId: version.id,
        checksum: version.checksum,
        sessionId: logicalFile.sessionId,
        displayName: logicalFile.displayName,
        storageKey: version.contentStorageKey,
        mimeType: version.contentType,
        sizeBytes: version.sizeBytes,
        mtimeMs: BigInt(timestamp.getTime()),
        sortAtMs: BigInt(timestamp.getTime()),
        messageId: null,
        deletedAt: null,
        deleteOperationId: null
      }
    })
  }

  private async publishedResult(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): Promise<SaveTextEditResult> {
    const resultVersionId = operation.resultVersionId
    if (!resultVersionId) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Published operation has no result version.'
      )
    }
    const version = await this.loadVersion(client, logicalFile, resultVersionId)
    this.assertPublishedVersionMatches(operation, logicalFile, version)
    await this.verifyResolvedVersion({
      logicalFile,
      version
    })
    return {
      kind: 'created',
      replayed: true,
      version: toDescriptor(logicalFile.source, logicalFile.displayName, version),
      headVersionId: version.id
    }
  }

  private assertPublishedVersionMatches(
    operation: WriteOperationRecord,
    logicalFile: ManagedLogicalFile,
    version: ManagedFileVersionRecord | null
  ): asserts version is ManagedFileVersionRecord {
    if (
      !version ||
      version.fileId !== logicalFile.id ||
      version.state !== COMPLETE_STATE[logicalFile.source] ||
      version.writeOperationId !== operation.operationId ||
      version.contentStorageKey !== operation.contentStorageKey ||
      version.checksum !== operation.checksum ||
      version.sizeBytes !== operation.sizeBytes
    ) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Published result version does not match its write operation.'
      )
    }
  }

  private async conflictResult(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): Promise<SaveTextEditResult> {
    const headVersionId = logicalFile.currentVersionId
    if (!headVersionId) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file has no actual head.'
      )
    }
    const actualHead = await this.loadVersion(client, logicalFile, headVersionId)
    if (!actualHead) {
      throw new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'Actual head is missing.')
    }
    return {
      kind: 'conflict',
      expectedHeadVersionId: operation.expectedHeadVersionId,
      actualHead: toDescriptor(logicalFile.source, logicalFile.displayName, actualHead)
    }
  }

  private async noOpResult(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    request: ManagedFileVersionSaveTextEditRequest,
    basedOn: ManagedFileVersionRecord
  ): Promise<SaveTextEditResult> {
    return client.$transaction(async (tx) => {
      const currentFile = await this.loadLogicalFile(tx, {
        source: logicalFile.source,
        projectId: logicalFile.projectId,
        fileId: logicalFile.id
      })
      await this.assertPublicationAllowed(tx, currentFile)
      const actualHeadVersionId = currentFile.currentVersionId
      if (!actualHeadVersionId) {
        throw new ManagedFileVersionError(
          'CONTENT_INTEGRITY_FAILED',
          'Managed file has no actual head.'
        )
      }
      const actualHead = await this.loadVersion(tx, currentFile, actualHeadVersionId)
      if (!actualHead || actualHead.state !== COMPLETE_STATE[currentFile.source]) {
        throw new ManagedFileVersionError(
          'CONTENT_INTEGRITY_FAILED',
          'Managed file head is not a published version.'
        )
      }
      if (actualHeadVersionId !== request.expectedHeadVersionId) {
        return {
          kind: 'conflict',
          expectedHeadVersionId: request.expectedHeadVersionId,
          actualHead: toDescriptor(currentFile.source, currentFile.displayName, actualHead)
        }
      }
      return {
        kind: 'noop',
        version: toDescriptor(currentFile.source, currentFile.displayName, basedOn),
        headVersionId: actualHead.id
      }
    })
  }

  private async failOperation(
    client: PrismaClient,
    operation: WriteOperationRecord,
    errorCode: ManagedFileVersionErrorCode,
    removeFinal = true
  ): Promise<void> {
    const failed = await client.managedFileVersionWriteOperation.updateMany({
      where: {
        operationId: operation.operationId,
        state: { in: ['staging', 'file_ready'] }
      },
      data: { state: 'failed', errorCode }
    })
    if (failed.count !== 1) return
    if (removeFinal) await this.removeFinalIfUnowned(client, operation)
  }

  private async removeFinalIfUnowned(
    client: PrismaClient,
    operation: WriteOperationRecord
  ): Promise<void> {
    const removable = await this.isOperationStorageUnowned(client, operation, [
      'staging',
      'file_ready',
      'failed',
      'conflict'
    ])
    if (!removable) return
    try {
      const logicalFile = await this.loadLogicalFile(client, {
        source: operation.source as ManagedFileSource,
        projectId: operation.projectId,
        fileId: operation.sourceFileId
      })
      const plannedFile = this.plannedFileForOperation(logicalFile, operation)
      const expectedIntegrity = {
        sizeBytes: Number(operation.sizeBytes),
        checksum: operation.checksum
      }
      const inspection = await this.versionFileOperator.inspectRecovery({
        operationId: operation.operationId,
        scope: {
          source: logicalFile.source,
          projectId: logicalFile.projectId,
          sessionId: logicalFile.sessionId,
          logicalFileId: logicalFile.id
        },
        logicalFilename: logicalFile.displayName,
        candidateIndex: plannedFile.candidateIndex,
        plannedFile,
        expectedIntegrity
      })
      if (inspection.state === 'complete') {
        await this.versionFileOperator.removeImmutable(
          operation.contentStorageKey,
          expectedIntegrity
        )
      } else if (inspection.state === 'incomplete') {
        await this.versionFileOperator.removeIncomplete({
          operationId: operation.operationId,
          scope: {
            source: logicalFile.source,
            projectId: logicalFile.projectId,
            sessionId: logicalFile.sessionId,
            logicalFileId: logicalFile.id
          },
          logicalFilename: logicalFile.displayName,
          candidateIndex: plannedFile.candidateIndex,
          plannedFile,
          actualIntegrity: inspection.actualIntegrity
        })
      }
    } catch {
      return
    }
  }

  private async isOperationStorageUnowned(
    client: PrismaClient,
    operation: WriteOperationRecord,
    allowedStates: string[]
  ): Promise<boolean> {
    return client.$transaction(async (tx) => {
      const [journal, artifactOwner, uploadOwner] = await Promise.all([
        tx.managedFileVersionWriteOperation.findUnique({
          where: { operationId: operation.operationId },
          select: { state: true, resultVersionId: true, contentStorageKey: true }
        }),
        tx.artifactVersion.findUnique({
          where: { contentStorageKey: operation.contentStorageKey },
          select: { id: true }
        }),
        tx.uploadVersion.findUnique({
          where: { contentStorageKey: operation.contentStorageKey },
          select: { id: true }
        })
      ])
      return (
        !!journal &&
        journal.contentStorageKey === operation.contentStorageKey &&
        allowedStates.includes(journal.state) &&
        journal.resultVersionId === null &&
        !artifactOwner &&
        !uploadOwner
      )
    })
  }

  private async auditActiveVersions(
    client: PrismaClient
  ): Promise<ManagedFileVersionIntegrityError[]> {
    const integrityErrors: ManagedFileVersionIntegrityError[] = []
    let artifactCursor: string | undefined
    for (;;) {
      const artifacts = await client.artifactLineage.findMany({
        where: { currentVersionId: { not: null } },
        include: { currentVersion: true },
        orderBy: { id: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE,
        ...(artifactCursor ? { cursor: { id: artifactCursor }, skip: 1 } : {})
      })
      for (const file of artifacts) {
        const version = file.currentVersion
        if (!version || version.state !== 'finalized') continue
        const record: ManagedFileVersionRecord = {
          ...version,
          fileId: version.artifactId,
          originalFilename: null,
          createdAt: version.createdAt
        }
        try {
          await this.verifyResolvedVersion({
            logicalFile: {
              source: 'artifact',
              id: file.id,
              projectId: file.projectId,
              sessionId: file.sessionId,
              displayName: file.filename,
              currentVersionId: file.currentVersionId
            },
            version: record
          })
        } catch {
          integrityErrors.push({
            source: 'artifact',
            fileId: file.id,
            versionId: version.id,
            code: 'CONTENT_INTEGRITY_FAILED'
          })
        }
        if (integrityErrors.length >= INTEGRITY_AUDIT_MAX_ERRORS) return integrityErrors
      }
      if (artifacts.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      artifactCursor = artifacts.at(-1)?.id
      if (!artifactCursor) break
      await new Promise<void>((resolveAuditYield) => setImmediate(resolveAuditYield))
    }

    let uploadCursor: string | undefined
    for (;;) {
      const uploads = await client.uploadFile.findMany({
        where: { currentVersionId: { not: null } },
        include: { currentVersion: true },
        orderBy: { id: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE,
        ...(uploadCursor ? { cursor: { id: uploadCursor }, skip: 1 } : {})
      })
      for (const file of uploads) {
        const version = file.currentVersion
        if (!version || version.state !== 'ready') continue
        const record: ManagedFileVersionRecord = {
          ...version,
          fileId: version.uploadFileId,
          createdAt: version.createdAt ?? version.registeredAt
        }
        try {
          await this.verifyResolvedVersion({
            logicalFile: {
              source: 'upload',
              id: file.id,
              projectId: file.projectId,
              sessionId: file.sessionId,
              displayName: file.originalFilename || file.filename,
              currentVersionId: file.currentVersionId
            },
            version: record
          })
        } catch {
          integrityErrors.push({
            source: 'upload',
            fileId: file.id,
            versionId: version.id,
            code: 'CONTENT_INTEGRITY_FAILED'
          })
        }
        if (integrityErrors.length >= INTEGRITY_AUDIT_MAX_ERRORS) return integrityErrors
      }
      if (uploads.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      uploadCursor = uploads.at(-1)?.id
      if (!uploadCursor) break
      await new Promise<void>((resolveAuditYield) => setImmediate(resolveAuditYield))
    }
    return integrityErrors
  }

  private async cleanupTerminalOperations(client: PrismaClient): Promise<void> {
    let cursor: string | undefined
    for (;;) {
      const operations = await client.managedFileVersionWriteOperation.findMany({
        where: { state: { in: ['conflict', 'failed'] } },
        orderBy: { operationId: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE,
        ...(cursor ? { cursor: { operationId: cursor }, skip: 1 } : {})
      })
      for (const operation of operations) {
        await this.removeFinalIfUnowned(client, operation)
      }
      if (operations.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      cursor = operations.at(-1)?.operationId
      if (!cursor) break
      await new Promise<void>((resolveCleanupYield) => setImmediate(resolveCleanupYield))
    }
  }

  private async rebuildHeadProjections(client: PrismaClient): Promise<void> {
    let artifactCursor: string | undefined
    for (;;) {
      const artifacts = await client.artifactLineage.findMany({
        where: { currentVersionId: { not: null } },
        include: { currentVersion: true },
        orderBy: { id: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE,
        ...(artifactCursor ? { cursor: { id: artifactCursor }, skip: 1 } : {})
      })
      for (const file of artifacts) {
        await client.$transaction(async (tx) => {
          const version = file.currentVersion
          if (!version || version.state !== 'finalized') return
          if (await this.hasProjectionBarrier(tx, file.projectId, file.sessionId)) return
          const existing = await tx.managedFile.findUnique({
            where: {
              projectId_source_sourceFileId: {
                projectId: file.projectId,
                source: 'artifact',
                sourceFileId: file.id
              }
            },
            select: { deletedAt: true }
          })
          // Runtime recovery repairs an already-visible Files tile. It must not create one for an Agent
          // head whose compatibility bytes or durable Message graph have not become visible yet.
          if (!existing || existing.deletedAt) return
          await this.upsertProjection(
            tx,
            {
              source: 'artifact',
              id: file.id,
              projectId: file.projectId,
              sessionId: file.sessionId,
              displayName: file.filename,
              currentVersionId: version.id
            },
            {
              ...version,
              fileId: version.artifactId,
              originalFilename: null,
              createdAt: version.createdAt
            },
            version.createdAt
          )
        })
      }
      if (artifacts.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      artifactCursor = artifacts.at(-1)?.id
      if (!artifactCursor) break
      await new Promise<void>((resolveProjectionYield) => setImmediate(resolveProjectionYield))
    }

    let uploadCursor: string | undefined
    for (;;) {
      const uploads = await client.uploadFile.findMany({
        where: { currentVersionId: { not: null } },
        include: { currentVersion: true },
        orderBy: { id: 'asc' },
        take: INTEGRITY_AUDIT_BATCH_SIZE,
        ...(uploadCursor ? { cursor: { id: uploadCursor }, skip: 1 } : {})
      })
      for (const file of uploads) {
        await client.$transaction(async (tx) => {
          const version = file.currentVersion
          if (!version || version.state !== 'ready') return
          if (await this.hasProjectionBarrier(tx, file.projectId, file.sessionId)) return
          const existing = await tx.managedFile.findUnique({
            where: {
              projectId_source_sourceFileId: {
                projectId: file.projectId,
                source: 'upload',
                sourceFileId: file.id
              }
            },
            select: { deletedAt: true }
          })
          if (!existing || existing.deletedAt) return
          const createdAt = version.createdAt ?? version.registeredAt
          await this.upsertProjection(
            tx,
            {
              source: 'upload',
              id: file.id,
              projectId: file.projectId,
              sessionId: file.sessionId,
              displayName: file.originalFilename || file.filename,
              currentVersionId: version.id
            },
            { ...version, fileId: version.uploadFileId, createdAt },
            createdAt
          )
        })
      }
      if (uploads.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      uploadCursor = uploads.at(-1)?.id
      if (!uploadCursor) break
      await new Promise<void>((resolveProjectionYield) => setImmediate(resolveProjectionYield))
    }
  }

  private async hasProjectionBarrier(
    tx: Prisma.TransactionClient,
    projectId: string,
    sessionId: string
  ): Promise<boolean> {
    const [project, deleting, origin, sync] = await Promise.all([
      tx.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } }),
      tx.projectDeletionIntent.findUnique({ where: { projectId }, select: { projectId: true } }),
      tx.fileOriginSession.findUnique({
        where: { projectId_sessionId: { projectId, sessionId } },
        select: { state: true, deletedAt: true, deletionOperationId: true }
      }),
      tx.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId, sessionId } },
        select: { deletedAt: true, deleteOperationId: true }
      })
    ])
    return (
      !project ||
      !!project.archivedAt ||
      !!deleting ||
      !origin ||
      origin.state !== 'active' ||
      !!origin.deletedAt ||
      !!origin.deletionOperationId ||
      !!sync?.deletedAt ||
      !!sync?.deleteOperationId
    )
  }

  private maybeCrash(phase: ManagedFileVersionTestFault): void {
    if (this.options.testFaultAt === phase) {
      throw new Error(`simulated managed version crash: ${phase}`)
    }
  }
}

export { ManagedFileVersionError, ManagedFileVersionService }
export type {
  AdoptedLegacyArtifact,
  AdoptLegacyArtifactRequest,
  ManagedFileReadLease,
  ManagedFileVersionRecoveryResult,
  ManagedFileVersionServiceOptions,
  ResolvedManagedFileVersion
}
