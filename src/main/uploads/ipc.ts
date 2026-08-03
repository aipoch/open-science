import { type Event as ElectronEvent, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'

import { ipcMainHandle } from '../ipc-handler-registry'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import { validateLocalPath } from '../../shared/local-fs'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalPathUploadRequest,
  StageLocalUploadRequest,
  UploadTransferRequest,
  UploadTransferStatus,
  UploadedAttachment
} from '../../shared/uploads'
import { DEFAULT_UPLOAD_PROJECT_NAME, STANDALONE_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { acquireDataRootWriter, withDataRootWrite } from '../storage/migration-state'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot(), {
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })

// Registers the small upload IPC surface used by the renderer composer and preview panel.
const registerUploadIpcHandlers = (
  repository = createDefaultUploadRepository(),
  options: {
    withSessionMutation?: <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ) => Promise<Result>
    // Called after a standalone "Save as artifact" upload has been persisted to SQLite so
    // the caller can broadcast a project-files:changed event to the renderer.
    onStandaloneUploadSaved?: (projectId: string, sessionId: string) => void
  } = {}
): void => {
  // A chunk transfer spans several IPC calls but is one logical write. Holding the writer lease from
  // begin through finish/abort makes data-root migration wait across the gaps between chunks.
  type UploadOwner = {
    senderId: number
    transferIds: Set<string>
  }
  type ChunkWriter = {
    owner: UploadOwner
    release: () => void
    ready: Promise<UploadTransferStatus>
    cancelled: boolean
    settling: boolean
    inFlight: Set<Promise<unknown>>
    cleanup?: Promise<void>
  }
  type LocalWriter = {
    owner: UploadOwner
    release: () => void
    cancelled: boolean
    ready?: Promise<UploadedAttachment>
    attachment?: UploadedAttachment
    cleanup?: Promise<void>
  }
  const uploadOwners = new Map<number, UploadOwner>()
  const chunkWriters = new Map<string, ChunkWriter>()
  const localWriters = new Map<string, LocalWriter>()
  const releaseChunkWriter = (transferId: string, writer: ChunkWriter): void => {
    if (chunkWriters.get(transferId) !== writer) return
    chunkWriters.delete(transferId)
    writer.owner.transferIds.delete(transferId)
    writer.release()
  }
  const abortChunkWriter = (transferId: string, writer: ChunkWriter): Promise<void> => {
    if (writer.cleanup) return writer.cleanup

    writer.cancelled = true
    writer.cleanup = (async () => {
      try {
        await writer.ready.catch(() => undefined)
        await Promise.allSettled([...writer.inFlight])
        await repository.abortTransfer({ transferId }).catch(() => undefined)
      } finally {
        releaseChunkWriter(transferId, writer)
      }
    })()
    return writer.cleanup
  }
  const releaseLocalWriter = (transferId: string, writer: LocalWriter): void => {
    if (localWriters.get(transferId) !== writer) return
    localWriters.delete(transferId)
    writer.owner.transferIds.delete(transferId)
    writer.release()
  }
  const abortLocalWriter = (transferId: string, writer: LocalWriter): Promise<void> => {
    if (writer.cleanup) return writer.cleanup

    writer.cancelled = true
    writer.cleanup = (async () => {
      try {
        await repository.abortTransfer({ transferId }).catch(() => undefined)
        const attachment = writer.attachment ?? (await writer.ready?.catch(() => undefined))
        if (attachment) {
          await repository.deleteUpload({ path: attachment.path }).catch(() => undefined)
        }
      } finally {
        releaseLocalWriter(transferId, writer)
      }
    })()
    return writer.cleanup
  }
  const registerUploadOwner = (event: IpcMainInvokeEvent): UploadOwner => {
    const existing = uploadOwners.get(event.sender.id)
    if (existing) return existing

    const owner: UploadOwner = { senderId: event.sender.id, transferIds: new Set() }
    uploadOwners.set(owner.senderId, owner)
    const releaseOwner = (): void => {
      if (uploadOwners.get(owner.senderId) !== owner) return
      uploadOwners.delete(owner.senderId)
      event.sender.removeListener('destroyed', releaseOwner)
      event.sender.removeListener('render-process-gone', releaseOwner)
      event.sender.removeListener('did-start-navigation', releaseOnMainFrameNavigation)
      for (const transferId of [...owner.transferIds]) {
        const chunkWriter = chunkWriters.get(transferId)
        if (chunkWriter?.owner === owner && !chunkWriter.settling) {
          void abortChunkWriter(transferId, chunkWriter)
        }
        const localWriter = localWriters.get(transferId)
        if (localWriter?.owner === owner) void abortLocalWriter(transferId, localWriter)
      }
    }
    const releaseOnMainFrameNavigation = (
      _navigationEvent: ElectronEvent,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame) releaseOwner()
    }
    event.sender.once('destroyed', releaseOwner)
    event.sender.once('render-process-gone', releaseOwner)
    event.sender.on('did-start-navigation', releaseOnMainFrameNavigation)
    return owner
  }
  const getOwnedChunkWriter = (
    event: IpcMainInvokeEvent,
    transferId: string
  ): ChunkWriter | undefined => {
    const owner = registerUploadOwner(event)
    const writer = chunkWriters.get(transferId)
    if (writer && writer.owner !== owner) {
      throw new Error(`Upload transfer belongs to another renderer: ${transferId}`)
    }
    return writer
  }
  const getOwnedLocalWriter = (
    event: IpcMainInvokeEvent,
    transferId: string
  ): LocalWriter | undefined => {
    const owner = registerUploadOwner(event)
    const writer = localWriters.get(transferId)
    if (writer && writer.owner !== owner) {
      throw new Error(`Upload transfer belongs to another renderer: ${transferId}`)
    }
    return writer
  }

  // Shared skeleton for native-path staging: one owner/writer lifecycle, with the renderer-facing
  // handlers keeping only their differences (request validation, size source, claim vs. release).
  const runLocalStaging = async (
    event: IpcMainInvokeEvent,
    request: StageLocalUploadRequest,
    options: { releaseOnCommit: boolean }
  ): Promise<UploadedAttachment> => {
    const owner = registerUploadOwner(event)
    const existing = localWriters.get(request.transferId) ?? chunkWriters.get(request.transferId)
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
      }
      throw new Error(`Upload transfer already exists: ${request.transferId}`)
    }

    const writer: LocalWriter = {
      owner,
      release: acquireDataRootWriter(),
      cancelled: false
    }
    localWriters.set(request.transferId, writer)
    owner.transferIds.add(request.transferId)
    try {
      writer.ready = repository.stageLocalFile(request, (progress) => {
        if (!writer.cancelled) event.sender.send('uploads:transfer-progress', progress)
      })
      const attachment = await writer.ready
      writer.attachment = attachment
      if (writer.cancelled) {
        await writer.cleanup
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      if (options.releaseOnCommit) releaseLocalWriter(request.transferId, writer)
      return attachment
    } catch (error) {
      if (writer.cancelled) await writer.cleanup
      else releaseLocalWriter(request.transferId, writer)
      throw error
    }
  }

  // Uploads write/mutate under the data root, so block them during the data-root copy→commit window.
  ipcMainHandle('uploads:stage-local-file', async (event, request: StageLocalUploadRequest) =>
    // The composer claims the committed transfer later, so the writer lease stays held.
    runLocalStaging(event, request, { releaseOnCommit: false })
  )
  ipcMainHandle('uploads:claim-local-file', (event, request: UploadTransferRequest) => {
    const writer = getOwnedLocalWriter(event, request.transferId)
    // Chunk/Web transfers have no local ownership record, so claiming them is an idempotent no-op.
    if (!writer) return
    if (!writer.attachment) {
      throw new Error(`Upload transfer is not ready to claim: ${request.transferId}`)
    }
    if (writer.cancelled) {
      throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
    }
    releaseLocalWriter(request.transferId, writer)
  })
  // Save-as-artifact from the local-file preview follows the composer upload pipeline, but the
  // renderer supplies a path instead of a File and no composer will claim the transfer, so the
  // writer lease is released as soon as the staged upload commits.
  ipcMainHandle('uploads:stage-local-path', async (event, request: StageLocalPathUploadRequest) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.transferId !== 'string' ||
      typeof request.name !== 'string' ||
      typeof request.sourcePath !== 'string' ||
      // The renderer hands over a raw host path, so it gets the same shape checks the local-fs
      // browser applies — absolute, no control characters — before stat() or any copy sees it.
      validateLocalPath(request.sourcePath, process.platform) !== undefined
    ) {
      throw new Error('Invalid local path upload request.')
    }
    // Stat before registering the writer so a stale renderer-side size can never reach staging.
    const sourceInfo = await stat(request.sourcePath)
    const attachment = await runLocalStaging(
      event,
      { ...request, size: sourceInfo.size },
      { releaseOnCommit: true }
    )
    // Publish to SQLite (uploadFile + uploadVersion + ManagedFile) so the file shows up in
    // "Your uploads" without an active conversation session. completeStagingUpload (called from
    // publishAttachment inside finalizePendingSessionUploads) writes ManagedFile with
    // source='upload', which is what listFiles({ collection: 'uploads' }) queries.
    const projectId = request.projectId ?? DEFAULT_UPLOAD_PROJECT_NAME
    try {
      await withDataRootWrite(() =>
        repository.finalizePendingSessionUploads(
          STANDALONE_UPLOAD_SESSION_ID,
          [attachment],
          projectId
        )
      )
    } catch (error) {
      // Staging already committed its bytes into .pending/ and the writer lease is gone, so a failed
      // publish would leave a file with no Version row and nothing to sweep it. Drop the copy and
      // surface the original failure.
      await repository.deleteUpload({ path: attachment.path }).catch(() => undefined)
      throw error
    }
    options.onStandaloneUploadSaved?.(projectId, STANDALONE_UPLOAD_SESSION_ID)
    return attachment
  })
  ipcMainHandle('uploads:begin-transfer', async (event, request: BeginUploadTransferRequest) => {
    const owner = registerUploadOwner(event)
    const localWriter = localWriters.get(request.transferId)
    if (localWriter) {
      if (localWriter.owner !== owner) {
        throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
      }
      throw new Error(`Upload transfer already exists: ${request.transferId}`)
    }
    const existing = chunkWriters.get(request.transferId)
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
      }
      await existing.ready
      return repository.beginTransfer(request)
    }

    const writer: ChunkWriter = {
      owner,
      release: acquireDataRootWriter(),
      ready: repository.beginTransfer(request),
      cancelled: false,
      settling: false,
      inFlight: new Set()
    }
    chunkWriters.set(request.transferId, writer)
    owner.transferIds.add(request.transferId)
    try {
      const status = await writer.ready
      if (writer.cancelled) {
        await writer.cleanup
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      return status
    } catch (error) {
      releaseChunkWriter(request.transferId, writer)
      throw error
    }
  })
  ipcMainHandle('uploads:append-transfer', async (event, request: AppendUploadTransferRequest) => {
    const writer = getOwnedChunkWriter(event, request.transferId)
    if (!writer) return withDataRootWrite(() => repository.appendTransfer(request))

    await writer.ready
    if (writer.cancelled) {
      throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
    }
    const operation = repository.appendTransfer(request)
    writer.inFlight.add(operation)
    try {
      return await operation
    } finally {
      writer.inFlight.delete(operation)
    }
  })
  ipcMainHandle('uploads:transfer-status', (event, request: UploadTransferRequest) => {
    getOwnedChunkWriter(event, request.transferId)
    return repository.getTransferStatus(request)
  })
  ipcMainHandle('uploads:finish-transfer', async (event, request: UploadTransferRequest) => {
    const writer = getOwnedChunkWriter(event, request.transferId)
    if (!writer) return withDataRootWrite(() => repository.finishTransfer(request))

    try {
      await writer.ready
      if (writer.cancelled) {
        await writer.cleanup
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      writer.settling = true
      await Promise.allSettled([...writer.inFlight])
      return await repository.finishTransfer(request)
    } catch (error) {
      await repository.abortTransfer(request).catch(() => undefined)
      throw error
    } finally {
      releaseChunkWriter(request.transferId, writer)
    }
  })
  ipcMainHandle('uploads:abort-transfer', async (event, request: UploadTransferRequest) => {
    const localWriter = getOwnedLocalWriter(event, request.transferId)
    if (localWriter) return abortLocalWriter(request.transferId, localWriter)

    const writer = getOwnedChunkWriter(event, request.transferId)
    if (!writer) return withDataRootWrite(() => repository.abortTransfer(request))

    await abortChunkWriter(request.transferId, writer)
  })
  ipcMainHandle('uploads:delete', (_event, request: DeleteUploadRequest) =>
    withDataRootWrite(() => repository.deleteUpload(request))
  )
  ipcMainHandle('uploads:finalize-session', (_event, request: FinalizeUploadSessionRequest) =>
    withDataRootWrite(() => {
      const finalize = (): Promise<UploadedAttachment[]> =>
        repository.finalizePendingSessionUploads(
          request.sessionId,
          request.attachments,
          request.projectId
        )
      return options.withSessionMutation && request.projectId
        ? options.withSessionMutation(request.projectId, request.sessionId, finalize)
        : finalize()
    })
  )
  ipcMainHandle('uploads:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    repository.readManagedUploadPreview(request)
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
