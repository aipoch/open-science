import { createReadStream } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  PENDING_UPLOAD_SESSION_ID,
  formatUploadSizeLimit,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type StageLocalUploadRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment
} from '../../shared/uploads'
import {
  STAGING_UPLOAD_SESSION_ID,
  assertSafePathSegment,
  createUploadedAttachment,
  getSessionUploadDir,
  moveToUniqueUploadFile,
  toSafeUploadFilename
} from './storage-helpers'

type ActiveTransferOwnerOptions = {
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

// Sole owner of live remote/local transfer state and its staging cleanup decisions.
class ActiveTransferOwner {
  private readonly activeTransfers = new Map<string, ActiveUploadTransfer>()
  private readonly activeLocalTransfers = new Map<string, ActiveLocalTransfer>()
  private stagingReady: Promise<void> | undefined

  constructor(
    private readonly storageRoot: string,
    private readonly options: ActiveTransferOwnerOptions = {}
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

    const stagingPath = join(
      getSessionUploadDir(this.storageRoot, STAGING_UPLOAD_SESSION_ID),
      `${transferId}.part`
    )
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

    const pendingDir = getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
    await mkdir(pendingDir, { recursive: true })
    const { filename, filePath } = await moveToUniqueUploadFile(
      transfer.stagingPath,
      pendingDir,
      toSafeUploadFilename(transfer.name)
    )
    this.activeTransfers.delete(transfer.transferId)

    return createUploadedAttachment({
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

    const stagingPath = join(
      getSessionUploadDir(this.storageRoot, STAGING_UPLOAD_SESSION_ID),
      `${transferId}.part`
    )
    const pendingDir = getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
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

      const { filename, filePath } = await moveToUniqueUploadFile(
        stagingPath,
        pendingDir,
        toSafeUploadFilename(originalName)
      )

      return createUploadedAttachment({
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

  // Upload drafts are intentionally process-local. Startup recovery first promotes every indexed
  // staging Version, then calls this owner to remove bytes that have no surviving runtime owner.
  async reconcileCrashOrphanedTransfers(): Promise<void> {
    await this.ensureStagingDirectory()
  }

  // Transfers and unfinalized drafts cannot survive a main-process restart. Clear crash-orphaned
  // bytes before the first transfer in this owner instance; concurrent first calls share the promise.
  private ensureStagingDirectory(): Promise<void> {
    if (!this.stagingReady) {
      const stagingDir = getSessionUploadDir(this.storageRoot, STAGING_UPLOAD_SESSION_ID)
      const pendingDir = getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
      this.stagingReady = (async () => {
        await rm(stagingDir, { recursive: true, force: true })
        await rm(pendingDir, { recursive: true, force: true })
        await mkdir(stagingDir, { recursive: true })
      })().catch((error) => {
        this.stagingReady = undefined
        throw error
      })
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
}

export { ActiveTransferOwner }
