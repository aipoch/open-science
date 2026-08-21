import { createHash, randomInt, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  MANAGED_TEXT_EDIT_MAX_BYTES,
  MANAGED_DIFF_MAX_INPUT_BYTES,
  buildManagedVersionStoredFilename,
  createManagedVersionStorageTag,
  inspectManagedTextEditEligibility,
  isManagedVersionStoredFilename,
  type ManagedFileSource,
  type ManagedFileVersionDescriptor,
  type ManagedFileVersionDiffRequest,
  type ManagedFileVersionDiffResult,
  type ManagedFileVersionErrorCode,
  type ManagedFileVersionInspectRequest,
  type ManagedFileVersionInspectResult,
  type ManagedFileVersionHostCapability,
  type ManagedFileVersionResolveRequest,
  type ManagedFileVersionSaveTextEditRequest,
  type ManagedTextFormat,
  type SaveTextEditResult
} from '../../shared/managed-file-versions'
import { ManagedTextDiffTaskRunner } from './diff-task'
import { defaultArtifactDurability, type ArtifactDurability } from '../artifacts/durability'
import { sha256 } from '../artifacts/provenance-canonical'
import {
  readAnchoredFile,
  readAnchoredFileBounded,
  listAnchoredDirectory,
  managedFileVersionNativeCapability,
  removeAnchoredFile,
  publishVerifiedAnchoredFileNoReplace,
  verifyAnchoredFile,
  writeAndPublishNoReplace
} from '../uploads/atomic-no-replace-publisher'

const COMPLETE_STATE = { artifact: 'finalized', upload: 'ready' } as const
const STORAGE_COLLISION_MAX_ATTEMPTS = 16
const ORPHAN_TEMP_MIN_AGE_MS = 24 * 60 * 60 * 1000
const INTEGRITY_AUDIT_BATCH_SIZE = 100
const INTEGRITY_AUDIT_MAX_ERRORS = 1000
const SAFE_STORAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MANAGED_VERSION_TEMP_PATTERN = /^\.(v[a-z0-9]{8}_.+)\.[a-f0-9]{16}\.tmp$/u

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
  path: string
}

type ManagedFileReadLease = ResolvedManagedFileVersion & {
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
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}

type ManagedFileLeaseSnapshot = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs'>

const leaseSnapshotMatches = (snapshot: ManagedFileLeaseSnapshot, current: BigIntStats): boolean =>
  current.isFile() &&
  current.dev === snapshot.dev &&
  current.ino === snapshot.ino &&
  current.size === snapshot.size &&
  current.mtimeNs === snapshot.mtimeNs

const readExactFromHandle = async (
  fileHandle: FileHandle,
  buffer: Uint8Array,
  position: number
): Promise<void> => {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset
    )
    if (bytesRead <= 0) throw new Error('Managed file changed during trusted consumption.')
    offset += bytesRead
  }
}

const checksumOpenHandle = async (fileHandle: FileHandle, size: number): Promise<string> => {
  const hash = createHash('sha256')
  let position = 0
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
    await readExactFromHandle(fileHandle, buffer, position)
    hash.update(buffer)
    position += buffer.byteLength
  }
  return hash.digest('hex')
}

const openManagedFileReadLease = async (
  resolved: ResolvedManagedFileVersion
): Promise<ManagedFileReadLease> => {
  const expectedSize = Number(resolved.version.sizeBytes)
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    operationError('CONTENT_INTEGRITY_FAILED', 'Managed file version size is invalid.')
  }

  const fileHandle = await open(resolved.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let closed = false
  let snapshot: ManagedFileLeaseSnapshot
  try {
    const before = await fileHandle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(expectedSize)) {
      throw new Error('Managed file version size or type changed before trusted consumption.')
    }
    snapshot = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs
    }
    const actualChecksum = await checksumOpenHandle(fileHandle, expectedSize)
    const after = await fileHandle.stat({ bigint: true })
    if (actualChecksum !== resolved.version.checksum || !leaseSnapshotMatches(snapshot, after)) {
      throw new Error('Managed file version changed during trusted verification.')
    }
  } catch (error) {
    await fileHandle.close().catch(() => undefined)
    throw new ManagedFileVersionError(
      'CONTENT_INTEGRITY_FAILED',
      'Managed file version content is unavailable or corrupt.',
      { cause: error }
    )
  }

  const assertOpen = (): void => {
    if (closed) throw new Error('Managed file read lease is closed.')
  }
  const verifyUnchanged = async (): Promise<void> => {
    assertOpen()
    const current = await fileHandle.stat({ bigint: true })
    if (!leaseSnapshotMatches(snapshot, current)) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file version changed during trusted consumption.'
      )
    }
  }
  const readRange = async (begin: number, end: number): Promise<Uint8Array> => {
    assertOpen()
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end <= begin ||
      end > expectedSize
    ) {
      throw new Error('Invalid managed file lease range.')
    }
    const buffer = Buffer.allocUnsafe(end - begin)
    await readExactFromHandle(fileHandle, buffer, begin)
    await verifyUnchanged()
    return new Uint8Array(buffer)
  }
  const copyTo = async (
    destinationPath: string,
    options?: { exclusive?: boolean }
  ): Promise<void> => {
    assertOpen()
    const destinationHandle = await open(
      destinationPath,
      constants.O_CREAT | constants.O_RDWR | (options?.exclusive ? constants.O_EXCL : 0),
      0o666
    )
    try {
      const sourceStat = await fileHandle.stat()
      const destinationStat = await destinationHandle.stat()
      if (destinationStat.dev === sourceStat.dev && destinationStat.ino === sourceStat.ino) {
        throw new Error('Cannot save a managed file over its source.')
      }
      await destinationHandle.truncate(0)
      const hash = createHash('sha256')
      let position = 0
      while (position < expectedSize) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize - position))
        await readExactFromHandle(fileHandle, buffer, position)
        hash.update(buffer)
        let written = 0
        while (written < buffer.byteLength) {
          const result = await destinationHandle.write(
            buffer,
            written,
            buffer.byteLength - written,
            position + written
          )
          if (result.bytesWritten <= 0) throw new Error('Managed file destination write stalled.')
          written += result.bytesWritten
        }
        position += buffer.byteLength
      }
      if (hash.digest('hex') !== resolved.version.checksum) {
        throw new ManagedFileVersionError(
          'CONTENT_INTEGRITY_FAILED',
          'Managed file version changed during export.'
        )
      }
      await verifyUnchanged()
    } finally {
      await destinationHandle.close()
    }
  }

  return {
    ...resolved,
    size: expectedSize,
    versionToken: Number(snapshot.mtimeNs) / 1_000_000,
    snapshot: { ...snapshot },
    read: async (buffer, offset, length, position) => {
      assertOpen()
      return fileHandle.read(buffer, offset, length, position)
    },
    readRange,
    copyTo,
    verifyUnchanged,
    close: async () => {
      if (closed) return
      closed = true
      await fileHandle.close()
    }
  }
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
  createId?: () => string
  createStorageTag?: () => string
  now?: () => Date
  durability?: ArtifactDurability
  writeAndPublish?: typeof writeAndPublishNoReplace
  readAnchored?: typeof readAnchoredFile
  readAnchoredBounded?: typeof readAnchoredFileBounded
  verifyAnchored?: typeof verifyAnchoredFile
  publishVerified?: typeof publishVerifiedAnchoredFileNoReplace
  listAnchored?: typeof listAnchoredDirectory
  removeAnchored?: typeof removeAnchoredFile
  testFaultAt?: ManagedFileVersionTestFault
  nativeWriteAvailable?: boolean
  nativeReadFallbackAvailable?: boolean
  diffTaskRunner?: Pick<ManagedTextDiffTaskRunner, 'run' | 'cancel'>
}

type WriteOperationRecord = Prisma.ManagedFileVersionWriteOperationGetPayload<object>

class ManagedFileVersionError extends Error {
  readonly name = 'ManagedFileVersionError'

  constructor(
    readonly code: ManagedFileVersionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

const operationError = (code: ManagedFileVersionErrorCode, message: string): never => {
  throw new ManagedFileVersionError(code, message)
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const isExists = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

const isRetryableRecoveryError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? error.code : undefined
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

const temporaryFilename = (operationId: string, storedFilename: string): string =>
  `.${storedFilename}.${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}.tmp`

const isManagedVisibleArtifactVersion = (version: ManagedFileVersionRecord): boolean =>
  version.originKind !== 'agent_generated' || version.managedVisibleAt != null

class ManagedFileVersionService {
  private readonly createId: () => string
  private readonly createStorageTag: () => string
  private readonly now: () => Date
  private readonly durability: ArtifactDurability
  private readonly writeAndPublish: typeof writeAndPublishNoReplace
  private readonly readAnchoredBounded: typeof readAnchoredFileBounded
  private readonly verifyAnchored: typeof verifyAnchoredFile
  private readonly publishVerified: typeof publishVerifiedAnchoredFileNoReplace
  private readonly listAnchored: typeof listAnchoredDirectory
  private readonly removeAnchored: typeof removeAnchoredFile
  private readonly nativeWriteAvailable: boolean
  private readonly nativeReadFallbackAvailable: boolean
  private readonly diffTaskRunner: Pick<ManagedTextDiffTaskRunner, 'run' | 'cancel'>
  private readonly activeDiffs = new Map<string, { cancelled: boolean; workerStarted: boolean }>()

  constructor(private readonly options: ManagedFileVersionServiceOptions) {
    this.createId = options.createId ?? randomUUID
    this.createStorageTag =
      options.createStorageTag ??
      (() => createManagedVersionStorageTag((limit) => randomInt(limit)))
    this.now = options.now ?? (() => new Date())
    this.durability = options.durability ?? defaultArtifactDurability
    this.writeAndPublish = options.writeAndPublish ?? writeAndPublishNoReplace
    this.readAnchoredBounded =
      options.readAnchoredBounded ??
      (options.readAnchored
        ? (rootPath, parentPath, name, maxBytes) => {
            const bytes = options.readAnchored!(rootPath, parentPath, name)
            if (bytes.byteLength > maxBytes) {
              throw Object.assign(new Error('bounded read overflow'), { code: 'EFBIG' })
            }
            return bytes
          }
        : readAnchoredFileBounded)
    this.verifyAnchored =
      options.verifyAnchored ??
      (options.readAnchored
        ? (rootPath, parentPath, name, expectedSizeBytes, expectedSha256) => {
            const bytes = options.readAnchored!(rootPath, parentPath, name)
            return bytes.byteLength === expectedSizeBytes && sha256(bytes) === expectedSha256
          }
        : verifyAnchoredFile)
    this.publishVerified = options.publishVerified ?? publishVerifiedAnchoredFileNoReplace
    this.listAnchored = options.listAnchored ?? listAnchoredDirectory
    this.removeAnchored = options.removeAnchored ?? removeAnchoredFile
    const nativeCapability = managedFileVersionNativeCapability()
    this.nativeWriteAvailable = options.nativeWriteAvailable ?? nativeCapability.available
    this.nativeReadFallbackAvailable =
      options.nativeReadFallbackAvailable ??
      (options.nativeWriteAvailable === undefined ? nativeCapability.readFallbackAvailable : false)
    this.diffTaskRunner = options.diffTaskRunner ?? new ManagedTextDiffTaskRunner()
  }

  getCapability(): ManagedFileVersionHostCapability {
    return this.nativeWriteAvailable
      ? { available: true }
      : { available: false, reason: 'NATIVE_WRITE_REQUIRED' }
  }

  async inspect(
    request: ManagedFileVersionInspectRequest
  ): Promise<ManagedFileVersionInspectResult> {
    const resolved = await this.resolveRecord(request)
    const versions = await this.listVersions(resolved.logicalFile)
    const writeUnavailableReason = await this.writeUnavailableReason(resolved.logicalFile)
    if (writeUnavailableReason === 'NATIVE_WRITE_REQUIRED' && !this.nativeReadFallbackAvailable) {
      return {
        source: request.source,
        projectId: request.projectId,
        fileId: request.fileId,
        sessionId: resolved.logicalFile.sessionId,
        displayName: resolved.logicalFile.displayName,
        headVersionId: resolved.logicalFile.currentVersionId!,
        selectedVersionId: resolved.version.id,
        versions: versions.map((version) =>
          toDescriptor(request.source, resolved.logicalFile.displayName, version)
        ),
        canEdit: false,
        canDiff: false,
        unavailableReason: writeUnavailableReason
      }
    }
    const eligibility = await this.readTextEligibility(resolved)

    return {
      source: request.source,
      projectId: request.projectId,
      fileId: request.fileId,
      sessionId: resolved.logicalFile.sessionId,
      displayName: resolved.logicalFile.displayName,
      headVersionId: resolved.logicalFile.currentVersionId!,
      selectedVersionId: resolved.version.id,
      versions: versions.map((version) =>
        toDescriptor(request.source, resolved.logicalFile.displayName, version)
      ),
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

  async resolve(request: ManagedFileVersionResolveRequest): Promise<ResolvedManagedFileVersion> {
    const resolved = await this.resolveRecord(request)
    if (!this.nativeWriteAvailable) {
      operationError('NATIVE_WRITE_REQUIRED', 'Native anchored managed-file access is unavailable.')
    }
    this.verifyVersion(resolved.version)
    return resolved
  }

  // Resolves only the authoritative DB identity. Export callers use this after anchored reads report
  // that the host lacks native support, then pin and bound the resulting path with their own handle.
  async resolvePath(
    request: ManagedFileVersionResolveRequest
  ): Promise<ResolvedManagedFileVersion> {
    return this.resolveRecord(request)
  }

  async openResolved(request: ManagedFileVersionResolveRequest): Promise<ManagedFileReadLease> {
    const resolved = await this.resolveRecord(request)
    if (this.nativeWriteAvailable) this.verifyVersion(resolved.version)
    else if (!this.nativeReadFallbackAvailable) {
      operationError('NATIVE_WRITE_REQUIRED', 'Native anchored managed-file access is unavailable.')
    }
    return openManagedFileReadLease(resolved)
  }

  async diffText(request: ManagedFileVersionDiffRequest): Promise<ManagedFileVersionDiffResult> {
    if (!request.requestId) operationError('INVALID_REQUEST', 'Diff request id is required.')
    if (this.activeDiffs.has(request.requestId)) {
      operationError('INVALID_REQUEST', 'Diff request id is already active.')
    }
    const active = { cancelled: false, workerStarted: false }
    this.activeDiffs.set(request.requestId, active)
    const assertNotCancelled = (): void => {
      if (active.cancelled) operationError('DIFF_CANCELLED', 'Diff request was cancelled.')
    }
    try {
      const selected = await this.resolveRecord(request)
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
      const lines = await this.diffTaskRunner.run({ requestId: request.requestId, before, after })
      assertNotCancelled()
      return { baseVersionId: ownedBaseVersionId, selectedVersionId: selected.version.id, lines }
    } finally {
      if (this.activeDiffs.get(request.requestId) === active) {
        this.activeDiffs.delete(request.requestId)
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
    request: ManagedFileVersionResolveRequest
  ): Promise<ResolvedManagedFileVersion> {
    this.assertIdentity(request)
    const client = await this.options.getClient()
    const logicalFile = await this.loadLogicalFile(client, request)
    const headVersionId = logicalFile.currentVersionId
    if (!headVersionId) {
      throw new ManagedFileVersionError(
        'VERSION_NOT_FOUND',
        'Managed file has no published version.'
      )
    }
    const versionId = request.versionId ?? headVersionId
    const version = await this.loadVersion(client, logicalFile, versionId)
    if (!version) {
      throw new ManagedFileVersionError('VERSION_NOT_FOUND', 'Managed file version was not found.')
    }
    if (request.source === 'artifact' && !isManagedVisibleArtifactVersion(version)) {
      operationError('VERSION_NOT_FOUND', 'Managed file version is not published.')
    }
    if (version.fileId !== logicalFile.id) {
      operationError('VERSION_NOT_IN_FILE', 'Managed file version belongs to another file.')
    }
    if (version.state !== COMPLETE_STATE[request.source]) {
      operationError('VERSION_NOT_FOUND', 'Managed file version is not published.')
    }
    return { logicalFile, version, path: this.resolveStoragePath(version.contentStorageKey) }
  }

  async saveTextEdit(request: ManagedFileVersionSaveTextEditRequest): Promise<SaveTextEditResult> {
    this.assertSaveRequest(request)
    if (!this.nativeWriteAvailable) {
      operationError('NATIVE_WRITE_REQUIRED', 'Native anchored file writes are unavailable.')
    }
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
      return this.resumeOperation(client, logicalFile, existing, replayBytes)
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
      version: basedOn,
      path: this.resolveStoragePath(basedOn.contentStorageKey)
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

    if (contentChecksum === basedOn.checksum && bytes.byteLength === Number(basedOn.sizeBytes)) {
      return {
        kind: 'noop',
        version: toDescriptor(request.source, logicalFile.displayName, basedOn),
        headVersionId: head.id
      }
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
    await this.cleanupOrphanTemporaryFiles(client)
    await this.rebuildHeadProjections(client)
    return result
  }

  async auditActiveVersionIntegrity(): Promise<ManagedFileVersionIntegrityError[]> {
    const client = await this.options.getClient()
    return this.auditActiveVersions(client)
  }

  private assertIdentity(request: ManagedFileVersionResolveRequest): void {
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
  ): Promise<'NATIVE_WRITE_REQUIRED' | 'PROJECT_NOT_WRITABLE' | 'FILE_DELETED' | undefined> {
    if (!this.nativeWriteAvailable) return 'NATIVE_WRITE_REQUIRED'
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

  private async listVersions(logicalFile: ManagedLogicalFile): Promise<ManagedFileVersionRecord[]> {
    const client = await this.options.getClient()
    if (logicalFile.source === 'artifact') {
      const versions = await client.artifactVersion.findMany({
        where: {
          artifactId: logicalFile.id,
          state: 'finalized',
          OR: [{ originKind: { not: 'agent_generated' } }, { managedVisibleAt: { not: null } }]
        },
        orderBy: { versionNumber: 'asc' }
      })
      return versions.map((version) => ({
        ...version,
        fileId: version.artifactId,
        originalFilename: null,
        createdAt: version.createdAt
      }))
    }
    const versions = await client.uploadVersion.findMany({
      where: { uploadFileId: logicalFile.id, state: 'ready' },
      orderBy: { versionNumber: 'asc' }
    })
    return versions.map((version) => ({
      ...version,
      fileId: version.uploadFileId,
      createdAt: version.createdAt ?? version.registeredAt
    }))
  }

  private resolveStoragePath(contentStorageKey: string): string {
    if (
      isAbsolute(contentStorageKey) ||
      contentStorageKey.includes('\\') ||
      contentStorageKey
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      operationError('CONTENT_INTEGRITY_FAILED', 'Managed storage key is invalid.')
    }
    const path = resolve(this.options.storageRoot, ...contentStorageKey.split('/'))
    const relativePath = relative(resolve(this.options.storageRoot), path)
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      operationError('CONTENT_INTEGRITY_FAILED', 'Managed storage key escapes its root.')
    }
    return path
  }

  private versionAnchor(version: ManagedFileVersionRecord): {
    path: string
    parentPath: string
    name: string
  } {
    const path = this.resolveStoragePath(version.contentStorageKey)
    return { path, parentPath: dirname(path), name: basename(path) }
  }

  private verifyVersion(version: ManagedFileVersionRecord): void {
    const { parentPath, name } = this.versionAnchor(version)
    try {
      const matches = this.verifyAnchored(
        this.options.storageRoot,
        parentPath,
        name,
        Number(version.sizeBytes),
        version.checksum
      )
      if (!matches) {
        throw new Error('checksum or size mismatch')
      }
    } catch (error) {
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file version content is unavailable or corrupt.',
        { cause: error }
      )
    }
  }

  private async readTextEligibility(
    resolved: ResolvedManagedFileVersion
  ): Promise<ReturnType<typeof inspectManagedTextEditEligibility>> {
    if (resolved.version.sizeBytes > BigInt(MANAGED_TEXT_EDIT_MAX_BYTES)) {
      return { editable: false, reason: 'EDIT_LIMIT_EXCEEDED' }
    }
    if (this.nativeWriteAvailable) {
      const { parentPath, name } = this.versionAnchor(resolved.version)
      try {
        const bytes = this.readAnchoredBounded(
          this.options.storageRoot,
          parentPath,
          name,
          MANAGED_TEXT_EDIT_MAX_BYTES
        )
        if (
          bytes.byteLength !== Number(resolved.version.sizeBytes) ||
          sha256(bytes) !== resolved.version.checksum
        ) {
          throw new Error('checksum or size mismatch')
        }
        return inspectManagedTextEditEligibility(resolved.logicalFile.displayName, bytes)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EFBIG'
        ) {
          return { editable: false, reason: 'EDIT_LIMIT_EXCEEDED' }
        }
        throw new ManagedFileVersionError(
          'CONTENT_INTEGRITY_FAILED',
          'Managed file version content is unavailable or corrupt.',
          { cause: error }
        )
      }
    }
    if (!this.nativeReadFallbackAvailable) {
      operationError('NATIVE_WRITE_REQUIRED', 'Native anchored managed-file access is unavailable.')
    }
    let lease: ManagedFileReadLease | undefined
    try {
      lease = await openManagedFileReadLease(resolved)
      const bytes = lease.size === 0 ? new Uint8Array() : await lease.readRange(0, lease.size)
      return inspectManagedTextEditEligibility(resolved.logicalFile.displayName, bytes)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EFBIG'
      ) {
        return { editable: false, reason: 'EDIT_LIMIT_EXCEEDED' }
      }
      throw new ManagedFileVersionError(
        'CONTENT_INTEGRITY_FAILED',
        'Managed file version content is unavailable or corrupt.',
        { cause: error }
      )
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
    if (this.nativeWriteAvailable) {
      this.verifyVersion(resolved.version)
      return
    }
    if (!this.nativeReadFallbackAvailable) {
      operationError('NATIVE_WRITE_REQUIRED', 'Native anchored managed-file access is unavailable.')
    }
    const lease = await openManagedFileReadLease(resolved)
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
      const storageTag = this.createStorageTag()
      const storedFilename = buildManagedVersionStoredFilename(logicalFile.displayName, storageTag)
      const contentStorageKey = [
        `${logicalFile.source}s`,
        logicalFile.projectId,
        logicalFile.sessionId,
        logicalFile.id,
        'managed-versions',
        storedFilename
      ].join('/')
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
    collisionAttempt = 0
  ): Promise<SaveTextEditResult> {
    let operation = initialOperation
    if (operation.state === 'published') return this.publishedResult(client, logicalFile, operation)
    if (operation.state === 'conflict') return this.conflictResult(client, logicalFile, operation)
    if (operation.state === 'failed') {
      operationError('CONTENT_INTEGRITY_FAILED', 'Managed file write operation failed recovery.')
    }

    const finalPath = this.resolveStoragePath(operation.contentStorageKey)
    const parentPath = dirname(finalPath)
    const tempName = temporaryFilename(operation.operationId, operation.storedFilename)

    if (operation.state === 'staging') {
      if (!this.isOperationFileValid(operation, parentPath, operation.storedFilename)) {
        if (!bytes) {
          try {
            const tempBytes = this.readAnchoredBounded(
              this.options.storageRoot,
              parentPath,
              tempName,
              Number(operation.sizeBytes)
            )
            if (
              tempBytes.byteLength === Number(operation.sizeBytes) &&
              sha256(tempBytes) === operation.checksum
            ) {
              this.publishVerified(
                this.options.storageRoot,
                parentPath,
                tempName,
                operation.storedFilename,
                tempBytes
              )
            }
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }
        if (!bytes) {
          if (!this.isOperationFileValid(operation, parentPath, operation.storedFilename)) {
            await this.failOperation(client, operation, 'CONTENT_INTEGRITY_FAILED')
            throw new ManagedFileVersionError(
              'CONTENT_INTEGRITY_FAILED',
              'Managed file write bytes are unavailable for recovery.'
            )
          }
        }
        if (bytes)
          try {
            this.writeAndPublish(
              this.options.storageRoot,
              parentPath,
              tempName,
              operation.storedFilename,
              bytes
            )
            this.maybeCrash('after-temp-write')
          } catch (error) {
            if (isExists(error)) {
              if (collisionAttempt + 1 >= STORAGE_COLLISION_MAX_ATTEMPTS) {
                await this.failOperation(client, operation, 'STORAGE_COLLISION', false)
                operationError('STORAGE_COLLISION', 'Managed version destination already exists.')
              }
              const reallocated = await this.reallocateOperationDestination(
                client,
                logicalFile,
                operation
              )
              return this.resumeOperation(
                client,
                logicalFile,
                reallocated,
                bytes,
                collisionAttempt + 1
              )
            }
            throw error
          }
        await this.durability.syncDirectory(parentPath)
      }
      this.maybeCrash('after-file-publish')
      const advanced = await client.managedFileVersionWriteOperation.updateMany({
        where: { operationId: operation.operationId, state: 'staging' },
        data: { state: 'file_ready', errorCode: null }
      })
      if (advanced.count !== 1) {
        operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
          where: { operationId: operation.operationId }
        })
        if (operation.state === 'published') {
          return this.publishedResult(client, logicalFile, operation)
        }
        if (operation.state === 'conflict') {
          return this.conflictResult(client, logicalFile, operation)
        }
        if (operation.state !== 'file_ready') {
          operationError('CONTENT_INTEGRITY_FAILED', 'Managed file write state is invalid.')
        }
      } else {
        operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
          where: { operationId: operation.operationId }
        })
      }
      this.maybeCrash('after-file-ready')
    }

    if (!this.isOperationFileValid(operation, parentPath, operation.storedFilename)) {
      await this.failOperation(client, operation, 'CONTENT_INTEGRITY_FAILED')
      operationError('CONTENT_INTEGRITY_FAILED', 'Managed version publication is corrupt.')
    }
    const result = await this.publishDatabaseTransaction(client, logicalFile, operation)
    if (result.kind === 'conflict') {
      await this.removeFinalIfUnowned(client, operation)
    }
    this.tryRemoveAnchored(parentPath, tempName)
    return result
  }

  private async reallocateOperationDestination(
    client: PrismaClient,
    logicalFile: ManagedLogicalFile,
    operation: WriteOperationRecord
  ): Promise<WriteOperationRecord> {
    for (let attempt = 0; attempt < STORAGE_COLLISION_MAX_ATTEMPTS; attempt += 1) {
      const storageTag = this.createStorageTag()
      const storedFilename = buildManagedVersionStoredFilename(logicalFile.displayName, storageTag)
      const contentStorageKey = [
        `${logicalFile.source}s`,
        logicalFile.projectId,
        logicalFile.sessionId,
        logicalFile.id,
        'managed-versions',
        storedFilename
      ].join('/')
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
          data: { state: 'conflict', errorCode: 'HEAD_CHANGED' }
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
    if (updated.count !== 1) operationError('HEAD_CHANGED', 'Managed file head changed.')
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
    this.verifyVersion(version)
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

  private isOperationFileValid(
    operation: WriteOperationRecord,
    parentPath: string,
    name: string
  ): boolean {
    try {
      return this.verifyAnchored(
        this.options.storageRoot,
        parentPath,
        name,
        Number(operation.sizeBytes),
        operation.checksum
      )
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  private tryRemoveAnchored(parentPath: string, name: string): void {
    try {
      this.removeAnchored(this.options.storageRoot, parentPath, name)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  private async failOperation(
    client: PrismaClient,
    operation: WriteOperationRecord,
    errorCode: ManagedFileVersionErrorCode,
    removeFinal = true
  ): Promise<void> {
    const finalPath = this.resolveStoragePath(operation.contentStorageKey)
    const tempPath = join(
      dirname(finalPath),
      temporaryFilename(operation.operationId, operation.storedFilename)
    )
    const failed = await client.managedFileVersionWriteOperation.updateMany({
      where: {
        operationId: operation.operationId,
        state: { in: ['staging', 'file_ready'] }
      },
      data: { state: 'failed', errorCode }
    })
    if (failed.count !== 1) return
    if (removeFinal) await this.removeFinalIfUnowned(client, operation)
    this.tryRemoveAnchored(
      dirname(tempPath),
      temporaryFilename(operation.operationId, operation.storedFilename)
    )
  }

  private async removeFinalIfUnowned(
    client: PrismaClient,
    operation: WriteOperationRecord
  ): Promise<void> {
    const removable = await client.$transaction(async (tx) => {
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
        journal.state !== 'published' &&
        journal.resultVersionId === null &&
        !artifactOwner &&
        !uploadOwner
      )
    })
    if (!removable) return
    const finalPath = this.resolveStoragePath(operation.contentStorageKey)
    // A stale journal must not remove a path that now contains unrelated bytes. The database
    // ownership proof above prevents deleting a referenced Version; the byte proof prevents a
    // failed retry from deleting a reused or externally replaced destination.
    let fileMatchesJournal = false
    try {
      fileMatchesJournal = this.isOperationFileValid(
        operation,
        dirname(finalPath),
        operation.storedFilename
      )
    } catch {
      return
    }
    if (!fileMatchesJournal) return
    this.tryRemoveAnchored(dirname(finalPath), operation.storedFilename)
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
            version: record,
            path: this.resolveStoragePath(record.contentStorageKey)
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
            version: record,
            path: this.resolveStoragePath(record.contentStorageKey)
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
        this.tryRemoveAnchored(
          dirname(this.resolveStoragePath(operation.contentStorageKey)),
          temporaryFilename(operation.operationId, operation.storedFilename)
        )
      }
      if (operations.length < INTEGRITY_AUDIT_BATCH_SIZE) break
      cursor = operations.at(-1)?.operationId
      if (!cursor) break
      await new Promise<void>((resolveCleanupYield) => setImmediate(resolveCleanupYield))
    }
  }

  private async cleanupOrphanTemporaryFiles(client: PrismaClient): Promise<void> {
    const cutoff = this.now().getTime() - ORPHAN_TEMP_MIN_AGE_MS
    for (const source of ['upload', 'artifact'] as const) {
      let cursor: string | undefined
      for (;;) {
        const files =
          source === 'upload'
            ? await client.uploadFile.findMany({
                orderBy: { id: 'asc' },
                take: INTEGRITY_AUDIT_BATCH_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                select: { projectId: true, sessionId: true, id: true }
              })
            : await client.artifactLineage.findMany({
                orderBy: { id: 'asc' },
                take: INTEGRITY_AUDIT_BATCH_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                select: { projectId: true, sessionId: true, id: true }
              })
        for (const file of files) {
          const parentPath = this.resolveStoragePath(
            `${source}s/${file.projectId}/${file.sessionId}/${file.id}/managed-versions`
          )
          let entries: Array<{ name: string; isFile: boolean; mtimeMs: number }>
          try {
            entries = this.listAnchored(this.options.storageRoot, parentPath)
          } catch (error) {
            if (isMissing(error)) continue
            throw error
          }
          for (const entry of entries) {
            if (!entry.isFile) continue
            const match = MANAGED_VERSION_TEMP_PATTERN.exec(entry.name)
            if (!match || !isManagedVersionStoredFilename(match[1]!)) continue
            if (entry.mtimeMs > cutoff) continue
            const owners = await client.managedFileVersionWriteOperation.findMany({
              where: {
                source,
                projectId: file.projectId,
                sourceFileId: file.id,
                storedFilename: match[1]!
              },
              select: { operationId: true, storedFilename: true }
            })
            if (
              owners.some(
                (operation) =>
                  temporaryFilename(operation.operationId, operation.storedFilename) === entry.name
              )
            ) {
              continue
            }
            this.tryRemoveAnchored(parentPath, entry.name)
          }
        }
        if (files.length < INTEGRITY_AUDIT_BATCH_SIZE) break
        cursor = files.at(-1)?.id
        if (!cursor) break
        await new Promise<void>((resolveOrphanYield) => setImmediate(resolveOrphanYield))
      }
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
  ManagedFileReadLease,
  ManagedFileVersionRecoveryResult,
  ManagedFileVersionServiceOptions,
  ResolvedManagedFileVersion
}
