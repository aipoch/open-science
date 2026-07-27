import { constants, createReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  PENDING_UPLOAD_SESSION_ID,
  formatUploadSizeLimit,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type DeleteUploadRequest,
  type StageLocalUploadRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment
} from '../../shared/uploads'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

const UPLOADS_DIR = 'uploads'
const STAGING_UPLOAD_SESSION_ID = '.staging'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type UploadRepositoryOptions = {
  maxFileBytes?: number
  createLocalReadStream?: (
    sourcePath: string,
    options: { highWaterMark: number; signal: AbortSignal }
  ) => ReturnType<typeof createReadStream>
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
    attachments: UploadedAttachment[]
  ): Promise<UploadedAttachment[]> {
    const safeSessionId = assertSafePathSegment(sessionId)

    return Promise.all(
      attachments.map((attachment) => this.finalizeAttachment(safeSessionId, attachment))
    )
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
  async resolveManagedUploadPath(request: DeleteUploadRequest): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid upload file path.')
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

    return resolvedFilePath
  }

  // Resolves an upload only when it belongs to the named durable session. Agent-facing tools use
  // this stricter seam so a model cannot point a capability at another conversation's attachment.
  async resolveSessionUploadPath(sessionId: string, request: DeleteUploadRequest): Promise<string> {
    const safeSessionId = assertSafePathSegment(sessionId)
    const filePath = await this.resolveManagedUploadPath(request)
    const sessionRoot = await realpath(this.getSessionUploadDir(safeSessionId)).catch(() => {
      throw new Error('Upload file belongs to a different session.')
    })

    assertPathInsideRoot(sessionRoot, filePath, 'Upload file belongs to a different session.')
    return filePath
  }

  // Reads upload previews through the shared bounded reader after upload-specific path validation.
  async readManagedUploadPreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedUploadPath(request)
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

export { UploadRepository }
