import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  PENDING_UPLOAD_SESSION_ID,
  formatUploadSizeLimit,
  parseUploadVersionReference,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type DeleteUploadRequest,
  type StageLocalUploadRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment,
  type PersistedUploadedAttachment
} from '../../shared/uploads'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

const UPLOADS_DIR = 'uploads'
const STAGING_UPLOAD_SESSION_ID = '.staging'
const LIVE_COPY_TEMP_SUFFIX = '.live-copy.tmp'
const LEGACY_CLEANUP_PRIVATE_SUFFIX = '.legacy-cleanup.private'
const LEGACY_CLEANUP_CANDIDATE = 'candidate'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type UploadRepositoryOptions = {
  maxFileBytes?: number
  getClient?: () => Promise<PrismaClient>
  getLegacyFileChecksum?: (path: string) => Promise<string>
  renameLegacyForCleanup?: (source: string, destination: string) => Promise<void>
  createLocalReadStream?: (
    sourcePath: string,
    options: { highWaterMark: number; signal: AbortSignal }
  ) => ReturnType<typeof createReadStream>
}

type ResolvedManagedUpload = {
  path: string
  name: string
}

type ActiveUploadTransfer = {
  transferId: string
  name: string
  mimeType?: string
  totalBytes: number
  receivedBytes: number
  stagingPath: string
  writing: boolean
  cancelled: boolean
}

type ActiveLocalTransfer = {
  stagingPath: string
  cancelled: boolean
  abortController: AbortController
  settled: Promise<void>
  resolveSettled: () => void
}

type CreateAttachmentInput = {
  id: string
  sessionId: string
  filename: string
  originalName: string
  filePath: string
  mimeType?: string
}

type LegacyUploadUpgradeOptions = {
  // Live callers cannot prove that every renderer has applied the returned path-free projection.
  // Preserve the legacy source until a later startup/deletion reconciliation runs without live state.
  // Orphan recovery also preserves it, but may only reuse authority left by the old deletion tail:
  // recreating identity after provenance succeeded could claim unrelated residual bytes.
  mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete'
}

// Accepts only path segments that cannot escape the managed upload layout.
const assertSafePathSegment = (segment: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid upload path segment: ${segment}`)
  }

  return segment
}

// Allows the temporary staging directory while still validating durable session ids.
const assertSafeSessionId = (sessionId: string): string => {
  if (sessionId === PENDING_UPLOAD_SESSION_ID) return sessionId

  return assertSafePathSegment(sessionId)
}

// Converts user-provided or clipboard filenames into safe, display-friendly basenames.
const toSafeUploadFilename = (filename: string): string => {
  const leafName = basename((filename.trim() || 'upload').replace(/\\/g, '/'))
  const safeName = leafName
    .replace(/[^A-Za-z0-9._ -]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/g, '')
    .replace(/[. ]+$/g, '')
    .trim()

  return safeName && safeName !== PENDING_UPLOAD_SESSION_ID ? safeName : 'upload'
}

// Keeps duplicate upload names stable by suffixing before the original extension.
const appendFilenameSuffix = (filename: string, suffix: number): string => {
  const extension = extname(filename)
  const baseName = basename(filename, extension)

  return `${baseName}-${suffix}${extension}`
}

// Rejects direct traversal and absolute-path escapes before and after canonicalization.
const assertPathInsideRoot = (
  rootPath: string,
  filePath: string,
  errorMessage = 'Upload file is outside upload storage.'
): void => {
  const relativePath = relative(rootPath, filePath)

  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(errorMessage)
  }
  if (isAbsolute(relativePath)) {
    throw new Error(errorMessage)
  }
}

// Narrows platform file errors without depending on Node-specific exception classes.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

// Detects exclusive-write collisions so callers can allocate the next available filename.
const isFileExistsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'EEXIST'

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

type FileIdentity = Awaited<ReturnType<typeof lstat>>

const hasSameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size

const hasSameFileSnapshot = (left: FileIdentity, right: FileIdentity): boolean =>
  hasSameFileIdentity(left, right) &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

class LegacyCleanupIncompleteError extends Error {}

// Terminal Project deletion may leave bytes only when reconciliation has positively proved that the
// deterministic legacy path no longer contains the Version-owned source. Callers must not use this
// type for missing/corrupt Version authority or transient filesystem/private-claim failures.
class UnsafeLegacyUploadResidualError extends Error {}

// Orphan adoption may suppress only this positively proven cross-version state: the Upload row is
// absent while candidate bytes exist or cannot safely be ruled out from the surviving locator.
// Database/filesystem failures and malformed surviving authority keep their original retry behavior.
class OrphanLegacyUploadAuthorityMissingError extends Error {}

// Promise.all rejects before sibling publication settles. Orphan recovery must not let a late
// sibling reactivate ManagedFile rows after its caller has already soft-deleted the Project index.
// Prefer an ordinary failure over the suppressible missing-authority state so DB/FS errors retain
// their durable intent instead of being accidentally collapsed into orphan-retained.
const settleSiblingOperations = async <Value>(operations: Promise<Value>[]): Promise<Value[]> => {
  const settled = await Promise.allSettled(operations)
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  const failure =
    failures.find(
      (result) => !(result.reason instanceof OrphanLegacyUploadAuthorityMissingError)
    ) ?? failures[0]
  if (failure) throw failure.reason
  return settled.map((result) => (result as PromiseFulfilledResult<Value>).value)
}

type LegacyCleanupResult =
  { status: 'absent' | 'removed' } | { status: 'unsafe-residual'; reason: string }

// Owns app-managed uploads so renderer paths are always validated in the main process.
class UploadRepository {
  private readonly activeTransfers = new Map<string, ActiveUploadTransfer>()
  private readonly activeLocalTransfers = new Map<string, ActiveLocalTransfer>()
  private stagingReady: Promise<void> | undefined

  // The storage root is the app persistence root; this class appends uploads/project/session.
  constructor(
    private readonly storageRoot: string,
    private readonly options: UploadRepositoryOptions = {}
  ) {}

  // Allocates an empty temporary file for sources that can only provide bytes (Web, clipboard,
  // synthetic File objects). Chunks are appended through appendTransfer and committed by finish.
  async beginTransfer(request: BeginUploadTransferRequest): Promise<UploadTransferStatus> {
    const transferId = assertSafePathSegment(request.transferId)
    const name = request.name.trim() || 'upload'
    const maxFileBytes = this.options.maxFileBytes ?? MAX_UPLOAD_FILE_BYTES

    if (!Number.isSafeInteger(request.size) || request.size < 0) {
      throw new Error(`Invalid upload size: ${name}`)
    }
    if (request.size > maxFileBytes) {
      throw new Error(
        `Upload exceeds the ${formatUploadSizeLimit(maxFileBytes)} per-file limit: ${name}`
      )
    }

    const existing = this.activeTransfers.get(transferId)
    if (existing) {
      if (
        existing.name !== name ||
        existing.mimeType !== request.mimeType ||
        existing.totalBytes !== request.size
      ) {
        throw new Error(`Upload transfer metadata does not match: ${transferId}`)
      }
      return this.toTransferStatus(existing)
    }
    if (this.activeLocalTransfers.has(transferId)) {
      throw new Error(`Upload transfer already exists: ${transferId}`)
    }

    const stagingDir = this.getSessionUploadDir(STAGING_UPLOAD_SESSION_ID)
    const stagingPath = join(stagingDir, `${transferId}.part`)
    await this.ensureStagingDirectory()

    const file = await open(stagingPath, 'wx')
    await file.close()

    const transfer: ActiveUploadTransfer = {
      transferId,
      name,
      mimeType: request.mimeType,
      totalBytes: request.size,
      receivedBytes: 0,
      stagingPath,
      writing: false,
      cancelled: false
    }
    this.activeTransfers.set(transferId, transfer)
    return this.toTransferStatus(transfer)
  }

  // Accepts exactly one bounded chunk at the caller's expected offset. This makes retries safe:
  // callers query status and resume from receivedBytes instead of duplicating data.
  async appendTransfer(request: AppendUploadTransferRequest): Promise<UploadTransferStatus> {
    const transfer = this.getActiveTransfer(request.transferId)
    if (!(request.chunk instanceof Uint8Array)) {
      throw new Error('Upload chunk must be binary data.')
    }
    if (request.chunk.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
      throw new Error('Upload chunk exceeds the maximum allowed chunk size.')
    }
    if (request.chunk.byteLength === 0) {
      throw new Error('Upload chunk must not be empty.')
    }
    if (request.offset !== transfer.receivedBytes) {
      throw new Error(
        `Upload chunk offset mismatch: expected ${transfer.receivedBytes}, received ${request.offset}.`
      )
    }
    if (transfer.writing) {
      throw new Error(`Upload transfer is already receiving a chunk: ${transfer.transferId}`)
    }
    if (transfer.receivedBytes + request.chunk.byteLength > transfer.totalBytes) {
      throw new Error(`Upload chunk exceeds the declared file size: ${transfer.name}`)
    }

    transfer.writing = true
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(transfer.stagingPath, 'r+')
      const bytes = Buffer.from(
        request.chunk.buffer,
        request.chunk.byteOffset,
        request.chunk.byteLength
      )
      let written = 0
      while (written < bytes.byteLength) {
        const result = await file.write(
          bytes,
          written,
          bytes.byteLength - written,
          transfer.receivedBytes + written
        )
        written += result.bytesWritten
      }
      transfer.receivedBytes += written
      if (transfer.cancelled) throw new Error(`Upload cancelled: ${transfer.name}`)
      return this.toTransferStatus(transfer)
    } finally {
      transfer.writing = false
      await file?.close()
      if (transfer.cancelled) {
        this.activeTransfers.delete(transfer.transferId)
        await rm(transfer.stagingPath, { force: true })
      }
    }
  }

  async getTransferStatus(request: UploadTransferRequest): Promise<UploadTransferStatus | null> {
    const transferId = assertSafePathSegment(request.transferId)
    const transfer = this.activeTransfers.get(transferId)
    return transfer ? this.toTransferStatus(transfer) : null
  }

  // Publishes a fully received temporary file into the same pending attachment namespace used by
  // desktop-path uploads. Incomplete transfers remain resumable until explicitly aborted.
  async finishTransfer(request: UploadTransferRequest): Promise<UploadedAttachment> {
    const transfer = this.getActiveTransfer(request.transferId)
    if (transfer.writing) {
      throw new Error(`Upload transfer is still receiving a chunk: ${transfer.transferId}`)
    }
    if (transfer.receivedBytes !== transfer.totalBytes) {
      throw new Error(
        `Upload transfer is incomplete: received ${transfer.receivedBytes} of ${transfer.totalBytes} bytes.`
      )
    }

    const pendingDir = this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID)
    await mkdir(pendingDir, { recursive: true })
    const { filename, filePath } = await this.moveToUniqueFile(
      transfer.stagingPath,
      pendingDir,
      toSafeUploadFilename(transfer.name)
    )
    this.activeTransfers.delete(transfer.transferId)

    return this.createAttachment({
      id: randomUUID(),
      sessionId: PENDING_UPLOAD_SESSION_ID,
      filename,
      originalName: transfer.name,
      filePath,
      mimeType: transfer.mimeType
    })
  }

  // Cancellation is idempotent so renderer cleanup can safely race a failed transfer.
  async abortTransfer(request: UploadTransferRequest): Promise<void> {
    const transferId = assertSafePathSegment(request.transferId)
    const localTransfer = this.activeLocalTransfers.get(transferId)
    if (localTransfer) {
      localTransfer.cancelled = true
      localTransfer.abortController.abort()
      await localTransfer.settled
      return
    }
    const transfer = this.activeTransfers.get(transferId)
    if (transfer?.writing) {
      transfer.cancelled = true
      return
    }
    this.activeTransfers.delete(transferId)
    if (transfer) await rm(transfer.stagingPath, { force: true })
  }

  // Streams an existing desktop file into managed staging without routing its bytes through the
  // renderer or a single IPC message. The temporary file is committed only after all bytes arrive.
  async stageLocalFile(
    request: StageLocalUploadRequest,
    onProgress?: (progress: UploadTransferProgress) => void
  ): Promise<UploadedAttachment> {
    const transferId = assertSafePathSegment(request.transferId)
    const originalName = request.name.trim() || 'upload'
    const maxFileBytes = this.options.maxFileBytes ?? MAX_UPLOAD_FILE_BYTES
    if (this.activeLocalTransfers.has(transferId) || this.activeTransfers.has(transferId)) {
      throw new Error(`Upload transfer already exists: ${transferId}`)
    }

    const stagingDir = this.getSessionUploadDir(STAGING_UPLOAD_SESSION_ID)
    const pendingDir = this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID)
    const stagingPath = join(stagingDir, `${transferId}.part`)
    let resolveSettled = (): void => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const localTransfer: ActiveLocalTransfer = {
      stagingPath,
      cancelled: false,
      abortController: new AbortController(),
      settled,
      resolveSettled
    }
    let receivedBytes = 0
    let output: Awaited<ReturnType<typeof open>> | undefined

    // Register before the first await so renderer teardown can cancel validation/directory setup too.
    this.activeLocalTransfers.set(transferId, localTransfer)

    try {
      const sourceInfo = await stat(request.sourcePath)

      if (!sourceInfo.isFile()) {
        throw new Error(`Upload source is not a file: ${originalName}`)
      }
      if (sourceInfo.size > maxFileBytes || request.size > maxFileBytes) {
        throw new Error(
          `Upload exceeds the ${formatUploadSizeLimit(maxFileBytes)} per-file limit: ${originalName}`
        )
      }
      if (sourceInfo.size !== request.size) {
        throw new Error(`Upload source changed before it could be staged: ${originalName}`)
      }
      if (localTransfer.cancelled) throw new Error(`Upload cancelled: ${originalName}`)

      await this.ensureStagingDirectory()
      await mkdir(pendingDir, { recursive: true })
      if (localTransfer.cancelled) throw new Error(`Upload cancelled: ${originalName}`)
      output = await open(stagingPath, 'wx')

      const sourceStream = (this.options.createLocalReadStream ?? createReadStream)(
        request.sourcePath,
        {
          highWaterMark: MAX_UPLOAD_CHUNK_BYTES,
          signal: localTransfer.abortController.signal
        }
      )
      for await (const chunk of sourceStream) {
        if (localTransfer.cancelled) throw new Error(`Upload cancelled: ${originalName}`)
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const nextReceivedBytes = receivedBytes + bytes.byteLength

        if (nextReceivedBytes > maxFileBytes) {
          throw new Error(
            `Upload exceeds the ${formatUploadSizeLimit(maxFileBytes)} per-file limit: ${originalName}`
          )
        }

        let written = 0
        while (written < bytes.byteLength) {
          const result = await output.write(
            bytes,
            written,
            bytes.byteLength - written,
            receivedBytes + written
          )
          written += result.bytesWritten
        }
        receivedBytes = nextReceivedBytes
        onProgress?.({
          transferId,
          name: originalName,
          receivedBytes,
          totalBytes: request.size
        })
      }

      await output.close()
      output = undefined

      if (receivedBytes !== request.size) {
        throw new Error(`Upload source changed while it was being staged: ${originalName}`)
      }

      const { filename, filePath } = await this.moveToUniqueFile(
        stagingPath,
        pendingDir,
        toSafeUploadFilename(originalName)
      )

      return this.createAttachment({
        id: randomUUID(),
        sessionId: PENDING_UPLOAD_SESSION_ID,
        filename,
        originalName,
        filePath,
        mimeType: request.mimeType
      })
    } catch (error) {
      await output?.close().catch(() => undefined)
      await rm(stagingPath, { force: true })
      throw error
    } finally {
      if (this.activeLocalTransfers.get(transferId) === localTransfer) {
        this.activeLocalTransfers.delete(transferId)
      }
      localTransfer.resolveSettled()
    }
  }

  // Moves pending attachments into their durable session directory once the runtime id is known.
  async finalizePendingSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId = DEFAULT_UPLOAD_PROJECT_NAME
  ): Promise<UploadedAttachment[]> {
    return this.finalizeSessionUploads(sessionId, attachments, projectId)
  }

  private async finalizeSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId: string,
    options: { preserveLegacySource?: boolean; requireExistingAuthority?: boolean } = {}
  ): Promise<UploadedAttachment[]> {
    const safeSessionId = assertSafePathSegment(sessionId)
    const safeProjectId = assertSafePathSegment(projectId.trim() || DEFAULT_UPLOAD_PROJECT_NAME)
    if (options.requireExistingAuthority && !this.options.getClient) {
      throw new Error('Legacy Upload authority is unavailable for orphan recovery.')
    }

    const finalized = await Promise.all(
      attachments.map(async (attachment) => {
        if (this.options.getClient) {
          return this.publishAttachment(safeProjectId, safeSessionId, attachment, options)
        }
        const finalized = await this.finalizeAttachment(safeSessionId, attachment)
        return finalized
      })
    )
    return finalized.filter(
      (attachment): attachment is UploadedAttachment => attachment !== undefined
    )
  }

  // Converts path-only Session records from pre-Version releases before the Session repository is
  // allowed to write its path-free JSON projection, and reconciles historical copies left behind by
  // older Version-aware releases. Repeated references share one publication or reconciliation.
  async upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: LegacyUploadUpgradeOptions = {}
  ): Promise<PersistedChatSession> {
    this.assertConsistentSessionUploadReferences(session)
    const isLiveSave = options.mode === 'live-save' || options.mode === 'orphan-recovery'
    const requireExistingAuthority = options.mode === 'orphan-recovery'
    const isTerminalDelete = options.mode === 'terminal-delete'
    const upgrades = new Map<string, Promise<PersistedUploadedAttachment | undefined>>()
    const reconciliations = new Map<string, Promise<LegacyCleanupResult>>()
    const upgrade = async (
      upload: PersistedUploadedAttachment
    ): Promise<PersistedUploadedAttachment | undefined> => {
      if (upload.versionId) {
        const persisted = toPersistedUploadedAttachment(
          toRuntimeUploadedAttachment(upload, session.projectId)
        )
        if (isLiveSave) return Promise.resolve(persisted)
        const reconciliationKey = `${upload.id}:${upload.versionId}`
        let reconciliation = reconciliations.get(reconciliationKey)
        if (!reconciliation) {
          reconciliation = this.removeVerifiedLegacyCopy({
            projectId: session.projectId,
            sessionId: upload.sessionId,
            uploadFileId: upload.id,
            versionId: upload.versionId,
            filename: upload.name
          })
          reconciliations.set(reconciliationKey, reconciliation)
        }
        return reconciliation.then(async (cleanup) => {
          if (isTerminalDelete) {
            await this.assertLegacySourceAbsent(upload.sessionId, upload.name, cleanup)
          }
          return persisted
        })
      }

      const existing = upgrades.get(upload.id)
      if (existing) return existing
      const operation = (async () => {
        if (!upload.path) {
          throw new Error(`Legacy upload has no recoverable path: ${upload.id}`)
        }
        const [finalized] = await this.finalizeSessionUploads(
          session.id,
          [toRuntimeUploadedAttachment(upload, session.projectId)],
          session.projectId,
          { preserveLegacySource: isLiveSave, requireExistingAuthority }
        )
        if (!finalized) return undefined
        if (isTerminalDelete) {
          await this.assertLegacySourceAbsent(upload.sessionId, upload.name, { status: 'absent' })
        }
        return toPersistedUploadedAttachment(finalized)
      })()
      upgrades.set(upload.id, operation)
      return operation
    }
    const upgradeMessage = async <Message extends PersistedChatMessage>(
      message: Message
    ): Promise<Message> => {
      if (!message.uploads?.length) return message
      const uploads = (await settleSiblingOperations(message.uploads.map(upgrade))).filter(
        (upload): upload is PersistedUploadedAttachment => upload !== undefined
      )
      return { ...message, uploads } as Message
    }
    const messagesOperation = settleSiblingOperations(session.messages.map(upgradeMessage))
    const graphMessagesOperation = session.conversationGraph
      ? settleSiblingOperations(session.conversationGraph.messages.map(upgradeMessage))
      : undefined
    await settleSiblingOperations<unknown>([
      messagesOperation,
      ...(graphMessagesOperation ? [graphMessagesOperation] : [])
    ])
    const messages = await messagesOperation
    const graphMessages = await graphMessagesOperation

    return {
      ...session,
      messages,
      ...(session.conversationGraph
        ? {
            conversationGraph: {
              ...session.conversationGraph,
              messages: graphMessages!
            }
          }
        : {})
    }
  }

  // Operation sharing is safe only after every occurrence across the flat transcript and graph has
  // proven the same immutable identity. This synchronous, lexical preflight runs before any DB or
  // filesystem work starts, so a conflicting historical locator cannot be overwritten or orphaned.
  private assertConsistentSessionUploadReferences(session: PersistedChatSession): void {
    const identities = new Map<string, string>()
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    for (const upload of messages.flatMap((message) => message.uploads ?? [])) {
      if (upload.sha256 && upload.checksum && upload.sha256 !== upload.checksum) {
        throw new Error(`Session Upload reference has conflicting checksums: ${upload.id}`)
      }
      const identity = JSON.stringify([
        upload.sessionId,
        upload.name,
        upload.originalName,
        upload.path === undefined ? null : resolve(upload.path),
        upload.versionId ?? null,
        upload.versionNumber ?? null,
        upload.sha256 ?? upload.checksum ?? null,
        upload.size,
        upload.mimeType ?? null,
        upload.createdAt ?? null
      ])
      const existing = identities.get(upload.id)
      if (existing !== undefined && existing !== identity) {
        throw new Error(
          `Session Upload references have conflicting immutable identity: ${upload.id}`
        )
      }
      identities.set(upload.id, identity)
    }
  }

  // Completes crash-interrupted staging rows at startup. Both native pending uploads and legacy
  // session-owned files have deterministic source candidates; a post-rename crash is recovered from
  // the already-valid final content. Every row is attempted so one corrupt upload cannot hide others.
  async recoverStagingUploads(): Promise<void> {
    if (!this.options.getClient) return
    const client = await this.options.getClient()
    const versions = await client.uploadVersion.findMany({
      where: { state: 'staging' },
      include: { uploadFile: true }
    })
    const results = await Promise.allSettled(
      versions.map(async (version) => {
        const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
        const sourceCandidates = [
          finalPath,
          join(this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID), version.filename),
          join(this.getSessionUploadDir(version.uploadFile.sessionId), version.filename)
        ]
        let sourcePath = sourceCandidates[0]
        for (const candidate of sourceCandidates) {
          try {
            if ((await stat(candidate)).isFile()) {
              sourcePath = candidate
              break
            }
          } catch (error) {
            if (!isMissingFileError(error)) throw error
          }
        }
        await this.completeStagingUpload(
          version.uploadFile.projectId,
          version.uploadFile.sessionId,
          {
            id: version.uploadFileId,
            sessionId: version.uploadFile.sessionId,
            name: version.filename,
            originalName: version.originalFilename,
            path: sourcePath,
            mimeType: version.contentType ?? undefined,
            size: Number(version.sizeBytes),
            versionId: version.id,
            versionNumber: version.versionNumber,
            checksum: version.checksum,
            createdAt: version.createdAt?.toISOString()
          },
          version
        )
      })
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Could not recover ${failures.length} staging Upload Version(s).`
      )
    }
  }

  // Deletes an app-managed upload after resolving the caller path through the trust boundary.
  async deleteUpload(request: DeleteUploadRequest): Promise<void> {
    try {
      const filePath = await this.resolveManagedUploadPath(request)
      const pendingRoot = await realpath(this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID))

      // The renderer API is intentionally staged-only. Finalized uploads are session-owned bytes and
      // must survive logical session/project deletion, so their paths are rejected at this boundary.
      assertPathInsideRoot(pendingRoot, filePath, 'Upload file is outside pending upload storage.')
      await rm(filePath, { force: true })
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
  }

  // Resolves a renderer-provided upload path only after root and symlink checks pass.
  async resolveManagedUploadPath(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid upload file path.')
    }

    const uploadVersion = parseUploadVersionReference(request.path)
    if (uploadVersion) {
      if (
        scope.sessionId &&
        uploadVersion.sessionId &&
        uploadVersion.sessionId !== scope.sessionId
      ) {
        throw new Error('Upload Version reference belongs to a different session.')
      }
      if (
        scope.projectId &&
        uploadVersion.projectId &&
        uploadVersion.projectId !== scope.projectId
      ) {
        throw new Error('Upload Version reference belongs to a different project.')
      }
      return this.resolveUploadVersionPath(
        uploadVersion.versionId,
        scope.projectId ?? uploadVersion.projectId,
        scope.sessionId ?? uploadVersion.sessionId
      )
    }

    const uploadRoot = this.getUploadRoot()
    const requestedPath = resolve(request.path)

    assertPathInsideRoot(uploadRoot, requestedPath)

    // Canonical paths catch symlinks that start inside storage but point outside it.
    const resolvedUploadRoot = await realpath(uploadRoot)
    const resolvedFilePath = await realpath(requestedPath)

    assertPathInsideRoot(resolvedUploadRoot, resolvedFilePath)

    if (!(await stat(resolvedFilePath)).isFile()) {
      throw new Error('Upload path is not a file.')
    }

    const safeProjectId = scope.projectId ? assertSafePathSegment(scope.projectId) : undefined
    const safeSessionId = scope.sessionId ? assertSafePathSegment(scope.sessionId) : undefined
    if (safeProjectId || safeSessionId) {
      const relativeUploadPath = relative(resolvedUploadRoot, resolvedFilePath).split(sep).join('/')
      const contentStorageKey = [UPLOADS_DIR, relativeUploadPath].join('/')
      if ((safeProjectId || safeSessionId) && this.options.getClient) {
        const client = await this.options.getClient()
        const version = await client.uploadVersion.findFirst({
          where: {
            state: 'ready',
            contentStorageKey,
            uploadFile: {
              is: {
                ...(safeProjectId ? { projectId: safeProjectId } : {}),
                ...(safeSessionId ? { sessionId: safeSessionId } : {})
              }
            }
          },
          select: { id: true }
        })
        if (version) return resolvedFilePath

        // Files is a project-scoped, main-maintained read model. A legacy path selected from that
        // surface may be referenced by any Session in the same Project, so its indexed membership is
        // sufficient for preview access even when the renderer's active Session is not the owner.
        const indexedFile = safeProjectId
          ? await client.managedFile.findFirst({
              where: {
                projectId: safeProjectId,
                source: 'upload',
                storageKey: contentStorageKey,
                deletedAt: null
              },
              select: { seq: true }
            })
          : undefined
        if (indexedFile) return resolvedFilePath
      }

      // Canonical raw paths retain the project/session layout. This compatibility branch never
      // infers ownership from a filename: it requires the requested file to remain under the exact
      // trusted scope. Cross-session references deliberately pass project-only scope.
      const scopedRoot = safeProjectId
        ? safeSessionId
          ? join(resolvedUploadRoot, safeProjectId, safeSessionId)
          : join(resolvedUploadRoot, safeProjectId)
        : safeSessionId
          ? this.getSessionUploadDir(safeSessionId)
          : undefined
      if (scopedRoot) {
        const resolvedScopedRoot = await realpath(scopedRoot).catch(() => undefined)
        if (resolvedScopedRoot) {
          try {
            assertPathInsideRoot(
              resolvedScopedRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the single ownership error below.
          }
        }
      }

      // Pre-Version uploads were stored under default-project even when the owning Session was
      // later associated with another Project. Resolve that compatibility layout only when SQLite
      // proves the source Session belongs to the requested Project. A project-only `@` selection
      // derives the source Session from the canonical legacy path; it never trusts the filename.
      const legacyPathSegments = relativeUploadPath.split('/')
      const legacySourceSessionId =
        legacyPathSegments[0] === DEFAULT_UPLOAD_PROJECT_NAME && legacyPathSegments.length > 2
          ? legacyPathSegments[1]
          : undefined
      const requestedLegacySessionId = safeSessionId ?? legacySourceSessionId
      if (
        safeProjectId &&
        requestedLegacySessionId &&
        safeProjectId !== DEFAULT_UPLOAD_PROJECT_NAME &&
        this.options.getClient
      ) {
        const safeLegacySessionId = assertSafePathSegment(requestedLegacySessionId)
        const client = await this.options.getClient()
        const originBindings = await client.fileOriginSession.findMany({
          where: { sessionId: safeLegacySessionId },
          select: { projectId: true },
          take: 2
        })
        const hasUnambiguousBinding =
          originBindings.length === 1 && originBindings[0].projectId === safeProjectId
        const legacySessionRoot = hasUnambiguousBinding
          ? await realpath(this.getSessionUploadDir(safeLegacySessionId)).catch(() => undefined)
          : undefined
        if (legacySessionRoot) {
          try {
            assertPathInsideRoot(
              legacySessionRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the pending capability check and the ownership error below.
          }
        }
      }

      // A newly staged upload is a short-lived main-issued capability and has not acquired durable
      // project/session identity yet. It is accepted only while it remains in the canonical pending
      // root; finalization publishes a scoped Version before Session persistence.
      if (safeProjectId && safeSessionId) {
        const pendingRoot = await realpath(
          join(resolvedUploadRoot, DEFAULT_UPLOAD_PROJECT_NAME, PENDING_UPLOAD_SESSION_ID)
        ).catch(() => undefined)
        if (pendingRoot) {
          try {
            assertPathInsideRoot(
              pendingRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the single ownership error below.
          }
        }
      }

      throw new Error('Upload file belongs to a different project or session.')
    }

    return resolvedFilePath
  }

  // Resolves an upload only when it belongs to the named durable session. Agent-facing tools use
  // this stricter seam so a model cannot point a capability at another conversation's attachment.
  async resolveSessionUploadPath(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<string> {
    return (await this.resolveSessionUpload(sessionId, request, projectId)).path
  }

  // Resolves both immutable bytes and their frozen user-facing name. Native Upload Versions store
  // bytes in a file named `content`, so consumers must not infer the original extension from the
  // physical path.
  async resolveSessionUpload(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<ResolvedManagedUpload> {
    const safeSessionId = assertSafePathSegment(sessionId)
    const safeProjectId = projectId ? assertSafePathSegment(projectId) : undefined
    return this.resolveManagedUpload(request, {
      sessionId: safeSessionId,
      projectId: safeProjectId
    })
  }

  async resolveManagedUpload(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<ResolvedManagedUpload> {
    const path = await this.resolveManagedUploadPath(request, scope)
    if (!this.options.getClient) return { path, name: basename(path) }

    const resolvedUploadRoot = await realpath(this.getUploadRoot())
    const relativeUploadPath = relative(resolvedUploadRoot, path).split(sep).join('/')
    const contentStorageKey = [UPLOADS_DIR, relativeUploadPath].join('/')
    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        state: 'ready',
        contentStorageKey,
        uploadFile: {
          is: {
            ...(scope.projectId ? { projectId: scope.projectId } : {}),
            ...(scope.sessionId ? { sessionId: scope.sessionId } : {})
          }
        }
      },
      select: { filename: true, originalFilename: true }
    })

    return { path, name: version?.originalFilename || version?.filename || basename(path) }
  }

  private async resolveUploadVersionPath(
    versionId: string,
    projectId: string | undefined,
    sessionId?: string
  ): Promise<string> {
    if (!this.options.getClient) throw new Error('Upload Version storage is not configured.')
    if (!projectId) throw new Error('Upload Version resolution requires a Project scope.')
    const safeVersionId = assertSafePathSegment(versionId)
    const safeProjectId = assertSafePathSegment(projectId)
    const safeSessionId = sessionId ? assertSafePathSegment(sessionId) : undefined
    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        id: safeVersionId,
        state: 'ready',
        uploadFile: {
          is: {
            projectId: safeProjectId,
            ...(safeSessionId ? { sessionId: safeSessionId } : {})
          }
        }
      }
    })
    if (!version) throw new Error(`Upload Version is unavailable: ${safeVersionId}`)
    const filePath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(resolve(this.storageRoot), filePath, 'Upload storage key escapes storage.')
    const fileInfo = await stat(filePath)
    if (
      !fileInfo.isFile() ||
      fileInfo.size !== Number(version.sizeBytes) ||
      (await sha256File(filePath)) !== version.checksum
    ) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${safeVersionId}`)
    }
    return filePath
  }

  // Reads upload previews through the shared bounded reader after upload-specific path validation.
  async readManagedUploadPreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedUploadPath(request, {
      projectId: request.projectId,
      sessionId: request.sessionId
    })
    return readBoundedManagedFilePreview(filePath, request, 'Invalid upload preview encoding.')
  }

  // Converts one pending attachment record into a durable session-owned upload record.
  private async finalizeAttachment(
    sessionId: string,
    attachment: UploadedAttachment
  ): Promise<UploadedAttachment> {
    if (attachment.sessionId === sessionId) {
      // Finalization is idempotent when the attachment already belongs to the target session.
      const targetDir = this.getSessionUploadDir(sessionId)
      const resolvedFilePath = await this.resolveManagedUploadPath({ path: attachment.path })

      assertPathInsideRoot(await realpath(targetDir), resolvedFilePath)

      return { ...attachment, size: (await stat(resolvedFilePath)).size }
    }

    if (attachment.sessionId !== PENDING_UPLOAD_SESSION_ID) {
      throw new Error('Upload attachment belongs to a different session.')
    }

    const pendingDir = this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID)
    const targetDir = this.getSessionUploadDir(sessionId)
    const sourcePath = await this.resolveManagedUploadPath({ path: attachment.path })

    assertPathInsideRoot(await realpath(pendingDir), sourcePath)
    await mkdir(targetDir, { recursive: true })

    // Commit without overwriting; same-volume storage reuses the inode and other filesystems fall back.
    const { filename, filePath } = await this.moveToUniqueFile(
      sourcePath,
      targetDir,
      attachment.name
    )

    return this.createAttachment({
      ...attachment,
      sessionId,
      filename,
      filePath
    })
  }

  // Publishes one independent upload through SQLite staging authority before moving its immutable
  // bytes. A retry recovers the same v1 row by uploadFileId even when the original pending path was
  // already consumed by the first rename.
  private async publishAttachment(
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    options: { preserveLegacySource?: boolean; requireExistingAuthority?: boolean } = {}
  ): Promise<UploadedAttachment | undefined> {
    const uploadFileId = assertSafePathSegment(attachment.id)
    const client = await this.options.getClient!()
    const existingFile = await client.uploadFile.findUnique({
      where: { id: uploadFileId },
      include: { versions: { where: { versionNumber: 1 }, take: 1 } }
    })
    if (existingFile) {
      if (existingFile.projectId !== projectId || existingFile.sessionId !== sessionId) {
        throw new Error('Upload file identity belongs to a different project or session.')
      }
      const existingVersion = existingFile.versions[0]
      if (!existingVersion) throw new Error('Upload file has no immutable v1 metadata.')
      if (attachment.versionId && attachment.versionId !== existingVersion.id) {
        throw new Error('Upload Version identity conflicts with the existing immutable Version.')
      }
      const published = await this.completeStagingUpload(
        projectId,
        sessionId,
        attachment,
        existingVersion,
        { preserveSource: options.preserveLegacySource === true }
      )
      if (
        !options.preserveLegacySource &&
        attachment.sessionId === sessionId &&
        !attachment.versionId
      ) {
        await this.removeVerifiedLegacyCopy({
          projectId,
          sessionId,
          uploadFileId,
          versionId: existingVersion.id,
          filename: attachment.name,
          legacyPath: attachment.path
        })
      }
      return published
    }

    if (options.requireExistingAuthority) {
      if (!(await this.hasOrphanLegacyCandidate(projectId, sessionId, uploadFileId, attachment))) {
        return undefined
      }
      throw new OrphanLegacyUploadAuthorityMissingError(
        `Legacy Upload authority is unavailable: ${uploadFileId}`
      )
    }

    const sourcePath = await this.resolveManagedUploadPath({ path: attachment.path })
    if (attachment.sessionId === PENDING_UPLOAD_SESSION_ID) {
      const pendingRoot = await realpath(this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID))
      assertPathInsideRoot(
        pendingRoot,
        sourcePath,
        'Upload file is outside pending upload storage.'
      )
    } else if (attachment.sessionId === sessionId) {
      const legacySessionRoot = await realpath(this.getSessionUploadDir(sessionId))
      assertPathInsideRoot(
        legacySessionRoot,
        sourcePath,
        'Legacy upload file belongs to a different session.'
      )
    } else {
      throw new Error('Unregistered upload attachment belongs to a different session.')
    }
    const fileInfo = await stat(sourcePath)
    const checksum = await sha256File(sourcePath)
    const versionId = assertSafePathSegment(attachment.versionId ?? randomUUID())
    const contentStorageKey = [
      UPLOADS_DIR,
      projectId,
      sessionId,
      uploadFileId,
      'versions',
      versionId,
      'content'
    ].join('/')
    const requestedCreatedAt = attachment.createdAt ? new Date(attachment.createdAt) : undefined
    if (requestedCreatedAt && Number.isNaN(requestedCreatedAt.getTime())) {
      throw new Error(`Invalid upload creation time: ${attachment.createdAt}`)
    }
    // A native pending upload is a new save event, so finalization owns its timestamp. A path-only
    // legacy record has no trustworthy save time; keep the immutable field null instead of recording
    // the migration time as historical fact.
    const createdAt =
      attachment.sessionId === PENDING_UPLOAD_SESSION_ID
        ? (requestedCreatedAt ?? new Date())
        : undefined

    const registered = await client.$transaction(async (tx) => {
      await tx.fileOriginSession.upsert({
        where: { projectId_sessionId: { projectId, sessionId } },
        create: { projectId, sessionId },
        update: {}
      })
      await tx.uploadFile.create({
        data: {
          id: uploadFileId,
          projectId,
          sessionId,
          filename: attachment.name,
          originalFilename: attachment.originalName
        }
      })
      return tx.uploadVersion.create({
        data: {
          id: versionId,
          uploadFileId,
          versionNumber: 1,
          state: 'staging',
          contentStorageKey,
          filename: attachment.name,
          originalFilename: attachment.originalName,
          contentType: attachment.mimeType,
          sizeBytes: BigInt(fileInfo.size),
          checksum,
          createdAt
        }
      })
    })

    return this.completeStagingUpload(projectId, sessionId, attachment, registered, {
      preserveSource: options.preserveLegacySource === true
    })
  }

  // Missing legacy and private candidates are positive evidence that the old deletion tail already
  // consumed the bytes. A mismatched recorded locator remains unknown and is retained fail-closed.
  private async hasOrphanLegacyCandidate(
    projectId: string,
    sessionId: string,
    uploadFileId: string,
    attachment: UploadedAttachment
  ): Promise<boolean> {
    assertSafePathSegment(projectId)
    assertSafePathSegment(sessionId)
    assertSafePathSegment(uploadFileId)
    const legacyRoot = this.getSessionUploadDir(sessionId)
    const expectedLegacyPath = resolve(legacyRoot, attachment.name)
    const privateClaimDir = `${expectedLegacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    assertPathInsideRoot(legacyRoot, privateClaimDir)
    if (resolve(attachment.path) !== expectedLegacyPath) return true

    for (const candidate of [expectedLegacyPath, privateClaimDir]) {
      try {
        await lstat(candidate)
        return true
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
    }

    // A live-save can crash after copying bytes into an authority-derived Version directory. The
    // Version id is unavailable once SQLite authority is gone, so scan only this Upload's bounded
    // versions root. Empty directories left by provenance cleanup are harmless; any surviving entry
    // (including content.live-copy.tmp) is retained for manual/retry recovery.
    const versionsRoot = resolve(
      this.storageRoot,
      UPLOADS_DIR,
      projectId,
      sessionId,
      uploadFileId,
      'versions'
    )
    assertPathInsideRoot(this.storageRoot, versionsRoot)
    let versionsRootInfo
    try {
      versionsRootInfo = await lstat(versionsRoot)
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
    if (!versionsRootInfo.isDirectory() || versionsRootInfo.isSymbolicLink()) return true
    const versionEntries = await readdir(versionsRoot, { withFileTypes: true })
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) return true
      const entries = await readdir(join(versionsRoot, versionEntry.name), {
        withFileTypes: true
      })
      if (entries.length > 0) return true
    }
    return false
  }

  private async completeStagingUpload(
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    version: {
      id: string
      uploadFileId: string
      versionNumber: number
      state: string
      contentStorageKey: string
      filename: string
      originalFilename: string
      contentType: string | null
      sizeBytes: bigint
      checksum: string
      createdAt: Date | null
    },
    options: { preserveSource?: boolean } = {}
  ): Promise<UploadedAttachment> {
    const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(
      resolve(this.storageRoot),
      finalPath,
      'Upload storage key escapes storage.'
    )
    const validateContent = async (path: string): Promise<boolean> => {
      try {
        const info = await stat(path)
        return (
          info.isFile() &&
          info.size === Number(version.sizeBytes) &&
          (await sha256File(path)) === version.checksum
        )
      } catch (error) {
        if (isMissingFileError(error)) return false
        throw error
      }
    }

    let finalValid = await validateContent(finalPath)
    if (version.state === 'ready' && !finalValid) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${version.id}`)
    }
    if (version.state !== 'staging' && version.state !== 'ready') {
      throw new Error(`Unsupported Upload Version state: ${version.state}`)
    }

    if (!finalValid) {
      try {
        await stat(finalPath)
        throw new Error(`Upload Version final content is corrupt: ${version.id}`)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
      await mkdir(dirname(finalPath), { recursive: true })
      const temporaryPath = `${finalPath}${LIVE_COPY_TEMP_SUFFIX}`
      if (await validateContent(temporaryPath)) {
        // A prior live save completed its copy but exited before the atomic final rename. The
        // deterministic path is derived from staging authority, so recovery can safely finish it.
        await rename(temporaryPath, finalPath)
        finalValid = await validateContent(finalPath)
        if (!finalValid) {
          throw new Error(`Recovered Upload Version content is corrupt: ${version.id}`)
        }
      } else {
        // Remove a partial/corrupt crash residue before retrying from the still-authoritative source.
        await rm(temporaryPath, { force: true })
      }
    }

    if (!finalValid) {
      let sourcePath: string | undefined
      try {
        sourcePath = await this.resolveManagedUploadPath({ path: attachment.path })
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
      if (!sourcePath || !(await validateContent(sourcePath))) {
        const client = await this.options.getClient!()
        await client.$transaction(async (tx) => {
          await tx.uploadVersion.deleteMany({ where: { id: version.id, state: 'staging' } })
          await tx.uploadFile.deleteMany({
            where: { id: version.uploadFileId, versions: { none: {} } }
          })
        })
        throw new Error(`Upload Version staging content is unavailable: ${version.id}`)
      }
      if (options.preserveSource) {
        // A live Session may still be rendering the path-only projection. Publish through an atomic
        // temporary copy, but retain that sole readable path until a later startup/deletion pass can
        // prove the path-free projection is authoritative without relying on renderer delivery.
        const temporaryPath = `${finalPath}${LIVE_COPY_TEMP_SUFFIX}`
        try {
          await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
          if (!(await validateContent(temporaryPath))) {
            throw new Error(`Copied Upload Version content is corrupt: ${version.id}`)
          }
          await rename(temporaryPath, finalPath)
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
        }
      } else {
        // The staging row is durable before this atomic move. If the process exits before the row is
        // marked ready, startup recovery validates the final path and completes publication. If the
        // Session JSON still contains the legacy path, a retry resolves the same row by uploadFileId.
        await rename(sourcePath, finalPath)
      }
      finalValid = await validateContent(finalPath)
      if (!finalValid) {
        throw new Error(`Published Upload Version content is corrupt: ${version.id}`)
      }
    }

    // A valid final path supersedes any deterministic crash residue from an earlier staging retry.
    await rm(`${finalPath}${LIVE_COPY_TEMP_SUFFIX}`, { force: true })

    const client = await this.options.getClient!()
    const ready = await client.$transaction(async (tx) => {
      const updated =
        version.state === 'ready'
          ? version
          : await tx.uploadVersion.update({
              where: { id: version.id },
              data: { state: 'ready' }
            })
      const timestamp = updated.createdAt ?? new Date()
      await tx.managedFile.upsert({
        where: {
          projectId_source_sourceFileId: {
            projectId,
            source: 'upload',
            sourceFileId: version.uploadFileId
          }
        },
        create: {
          source: 'upload',
          sourceFileId: version.uploadFileId,
          sourceVersionId: version.id,
          checksum: version.checksum,
          projectId,
          sessionId,
          displayName: version.originalFilename || version.filename,
          storageKey: version.contentStorageKey,
          mimeType: version.contentType,
          sizeBytes: version.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime())
        },
        update: {
          sourceVersionId: version.id,
          checksum: version.checksum,
          sessionId,
          displayName: version.originalFilename || version.filename,
          storageKey: version.contentStorageKey,
          mimeType: version.contentType,
          sizeBytes: version.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime()),
          deletedAt: null,
          deleteOperationId: null
        }
      })
      return updated
    })

    return {
      id: version.uploadFileId,
      sessionId,
      name: version.filename,
      originalName: version.originalFilename,
      path: finalPath,
      mimeType: version.contentType ?? undefined,
      size: Number(version.sizeBytes),
      versionId: ready.id,
      versionNumber: ready.versionNumber,
      checksum: ready.checksum,
      createdAt: ready.createdAt?.toISOString()
    }
  }

  // Reconciles copies left by releases that published a ready Version without consuming the legacy
  // source. Cleanup is fail-closed: SQLite authority, both byte copies, the deterministic legacy path,
  // and the source file identity must all remain valid through the final pre-delete check.
  private async removeVerifiedLegacyCopy(input: {
    projectId: string
    sessionId: string
    uploadFileId: string
    versionId: string
    filename: string
    legacyPath?: string
  }): Promise<LegacyCleanupResult> {
    const projectId = assertSafePathSegment(input.projectId)
    const sessionId = assertSafePathSegment(input.sessionId)
    const uploadFileId = assertSafePathSegment(input.uploadFileId)
    const versionId = assertSafePathSegment(input.versionId)
    const legacyRoot = this.getSessionUploadDir(sessionId)
    const expectedLegacyPath = resolve(legacyRoot, input.filename)
    const cleanupPrivateDir = `${expectedLegacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    const cleanupPrivatePath = join(cleanupPrivateDir, LEGACY_CLEANUP_CANDIDATE)
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    assertPathInsideRoot(legacyRoot, cleanupPrivatePath)

    let initialLegacyInfo: FileIdentity | undefined
    let privateDirInfo: FileIdentity | undefined
    let privateInfo: FileIdentity | undefined
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      privateDirInfo = await lstat(cleanupPrivateDir)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (privateDirInfo) {
      if (!privateDirInfo.isDirectory() || privateDirInfo.isSymbolicLink()) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup found an unsafe private claim: ${input.filename}`
        )
      }
      try {
        privateInfo = await lstat(cleanupPrivatePath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        try {
          await rmdir(cleanupPrivateDir)
          privateDirInfo = undefined
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup found an incomplete private claim: ${input.filename}`
          )
        }
      }
    }
    if (!initialLegacyInfo && !privateInfo) return { status: 'absent' }

    if (input.legacyPath && resolve(input.legacyPath) !== expectedLegacyPath) {
      return {
        status: 'unsafe-residual',
        reason: 'the recorded legacy path does not match its deterministic Session path'
      }
    }

    if (!this.options.getClient) {
      throw new Error(`Upload Version authority is unavailable for legacy cleanup: ${versionId}`)
    }

    // The common path-free case has neither candidate, so the lstat checks above avoid a database read
    // and full immutable-file hash on every subsequent Session save. Database failures after a
    // candidate is found propagate so reconciliation remains incomplete and retries later.
    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        id: versionId,
        uploadFileId,
        state: 'ready',
        uploadFile: { is: { projectId, sessionId } }
      },
      select: {
        contentStorageKey: true,
        filename: true,
        sizeBytes: true,
        checksum: true
      }
    })
    if (!version) {
      throw new Error(`Ready Upload Version authority is unavailable: ${versionId}`)
    }
    if (version.filename !== input.filename) {
      throw new Error(`Ready Upload Version filename does not match: ${versionId}`)
    }

    const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(this.storageRoot, finalPath, 'Upload storage key escapes storage.')
    const finalInfo = await stat(finalPath)
    if (
      !finalInfo.isFile() ||
      finalInfo.size !== Number(version.sizeBytes) ||
      (await sha256File(finalPath)) !== version.checksum
    ) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${versionId}`)
    }

    // A pre-existing claim has lost the pre-rename inode witness held by its original process. Never
    // delete that candidate from checksum alone: restore it without overwrite, release the claim, and
    // make this invocation prove the legacy path again before acquiring a fresh claim.
    if (privateInfo) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        privateInfo
      )
    }

    let verifiedLegacyInfo: FileIdentity
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
      if (!initialLegacyInfo.isFile() || initialLegacyInfo.isSymbolicLink()) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path is not a regular owned file'
        }
      }
      const sourcePath = await this.resolveManagedUploadPath(
        { path: expectedLegacyPath },
        { projectId, sessionId }
      )
      const resolvedLegacyPath = await realpath(expectedLegacyPath)
      const resolvedFinalPath = await realpath(finalPath)
      if (
        sourcePath !== resolvedLegacyPath ||
        sourcePath === resolvedFinalPath ||
        initialLegacyInfo.size !== Number(version.sizeBytes)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path does not match the Version-owned source'
        }
      }

      const legacyChecksum = await (this.options.getLegacyFileChecksum ?? sha256File)(
        expectedLegacyPath
      )
      if (legacyChecksum !== version.checksum) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path contains different content'
        }
      }

      verifiedLegacyInfo = await lstat(expectedLegacyPath)
      const verifiedLegacyPath = await realpath(expectedLegacyPath)
      if (
        !verifiedLegacyInfo.isFile() ||
        verifiedLegacyInfo.isSymbolicLink() ||
        verifiedLegacyPath !== sourcePath ||
        !hasSameFileSnapshot(verifiedLegacyInfo, initialLegacyInfo)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path changed during ownership verification'
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) return { status: 'absent' }
      throw error
    }

    try {
      // mkdir is the no-replace claim Node exposes portably. Once this empty directory is ours, the
      // rename target inside it cannot collide with another cooperating cleanup process.
      await mkdir(cleanupPrivateDir)
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup private claim is already occupied: ${input.filename}`
        )
      }
      throw error
    }

    try {
      await (this.options.renameLegacyForCleanup ?? rename)(expectedLegacyPath, cleanupPrivatePath)
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          await rmdir(cleanupPrivateDir)
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup could not release its private claim: ${input.filename}`
          )
        }
        return { status: 'absent' }
      }
      throw error
    }

    const movedInfo = await lstat(cleanupPrivatePath)
    const movedChecksum = await sha256File(cleanupPrivatePath)
    const reverifiedMovedInfo = await lstat(cleanupPrivatePath)
    if (
      !hasSameFileIdentity(movedInfo, verifiedLegacyInfo) ||
      movedChecksum !== version.checksum ||
      !hasSameFileSnapshot(reverifiedMovedInfo, movedInfo)
    ) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        reverifiedMovedInfo
      )
      return {
        status: 'unsafe-residual',
        reason: 'the claimed legacy source changed before removal'
      }
    }

    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
    return { status: 'removed' }
  }

  private async restoreLegacyCleanupPrivate(
    cleanupPrivateDir: string,
    cleanupPrivatePath: string,
    expectedLegacyPath: string,
    privateInfo: FileIdentity
  ): Promise<void> {
    if (!privateInfo.isFile() || privateInfo.isSymbolicLink()) {
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup left an unverifiable private candidate: ${basename(expectedLegacyPath)}`
      )
    }

    try {
      await link(cleanupPrivatePath, expectedLegacyPath)
    } catch (error) {
      if (isFileExistsError(error)) {
        // If a previous restore linked the same inode before crashing, finish removal of the extra
        // private name. Any different replacement wins EEXIST and remains untouched alongside it.
        const currentLegacyInfo = await lstat(expectedLegacyPath).catch(() => undefined)
        if (currentLegacyInfo && hasSameFileIdentity(currentLegacyInfo, privateInfo)) {
          await rm(cleanupPrivatePath, { force: true })
          await rmdir(cleanupPrivateDir)
          return
        }
      }
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup could not safely restore a private candidate: ${basename(expectedLegacyPath)}`
      )
    }

    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
  }

  // Session/project deletion removes the final JSON authority needed to discover a legacy duplicate.
  // Refuse that terminal commit while any deterministic candidate remains, including a replacement
  // file that fail-closed checksum or inode validation deliberately would not delete.
  private async assertLegacySourceAbsent(
    sessionId: string,
    filename: string,
    cleanup: LegacyCleanupResult
  ): Promise<void> {
    const legacyRoot = this.getSessionUploadDir(assertSafePathSegment(sessionId))
    const legacyPath = resolve(legacyRoot, filename)
    const cleanupPrivateDir = `${legacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    assertPathInsideRoot(legacyRoot, legacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    try {
      await lstat(cleanupPrivateDir)
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup found an incomplete private claim: ${filename}`
      )
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      await lstat(legacyPath)
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
    if (cleanup.status === 'unsafe-residual') {
      throw new UnsafeLegacyUploadResidualError(
        `Legacy upload source is not owned by its ready Version: ${filename}; ${cleanup.reason}.`
      )
    }
    throw new Error(`Legacy upload cleanup is incomplete: ${filename}`)
  }

  // Returns the top-level upload directory under the app persistence root.
  private getUploadRoot(): string {
    return resolve(this.storageRoot, UPLOADS_DIR)
  }

  // Returns the per-project upload directory for the current workspace project.
  private getProjectUploadDir(): string {
    return join(this.getUploadRoot(), DEFAULT_UPLOAD_PROJECT_NAME)
  }

  // Returns the staging or durable directory for one upload session.
  private getSessionUploadDir(sessionId: string): string {
    const safeSessionId =
      sessionId === STAGING_UPLOAD_SESSION_ID ? sessionId : assertSafeSessionId(sessionId)
    return join(this.getProjectUploadDir(), safeSessionId)
  }

  // Transfers cannot survive a main-process restart. Clear crash-orphaned partial files before the
  // first transfer in this repository instance; concurrent first calls share the cleanup promise.
  private ensureStagingDirectory(): Promise<void> {
    if (!this.stagingReady) {
      const stagingDir = this.getSessionUploadDir(STAGING_UPLOAD_SESSION_ID)
      this.stagingReady = (async () => {
        await rm(stagingDir, { recursive: true, force: true })
        await mkdir(stagingDir, { recursive: true })
      })()
    }

    return this.stagingReady
  }

  private getActiveTransfer(transferId: string): ActiveUploadTransfer {
    const safeTransferId = assertSafePathSegment(transferId)
    const transfer = this.activeTransfers.get(safeTransferId)
    if (!transfer) throw new Error(`Unknown upload transfer: ${safeTransferId}`)
    return transfer
  }

  private toTransferStatus(transfer: ActiveUploadTransfer): UploadTransferStatus {
    return {
      transferId: transfer.transferId,
      name: transfer.name,
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes
    }
  }

  // Moves an already-staged file into a target directory while preserving unique filenames.
  private async moveToUniqueFile(
    sourcePath: string,
    targetDir: string,
    filename: string
  ): Promise<{ filename: string; filePath: string }> {
    const safeFilename = toSafeUploadFilename(filename)

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate =
        attempt === 0 ? safeFilename : appendFilenameSuffix(safeFilename, attempt + 1)
      const filePath = join(targetDir, candidate)

      try {
        // A same-volume hard link commits the staged inode without a multi-GB second copy. Cross-
        // device or unsupported filesystems fall back to exclusive copy, preserving old behavior.
        try {
          await link(sourcePath, filePath)
        } catch (linkError) {
          if (isFileExistsError(linkError)) throw linkError
          await copyFile(sourcePath, filePath, constants.COPYFILE_EXCL)
        }
        await rm(sourcePath, { force: true })
        return { filename: candidate, filePath }
      } catch (error) {
        if (isFileExistsError(error)) continue
        throw error
      }
    }

    throw new Error(`Could not allocate upload filename: ${safeFilename}`)
  }

  // Builds the renderer-safe attachment metadata from the trusted file on disk.
  private async createAttachment(input: CreateAttachmentInput): Promise<UploadedAttachment> {
    return {
      id: input.id,
      sessionId: input.sessionId,
      name: input.filename,
      originalName: input.originalName,
      path: input.filePath,
      mimeType: input.mimeType,
      size: (await stat(input.filePath)).size
    }
  }
}

export {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
}
