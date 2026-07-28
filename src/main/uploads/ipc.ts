import { ipcMain, type Event as ElectronEvent, type IpcMainInvokeEvent } from 'electron'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalUploadRequest,
  UploadTransferRequest,
  UploadTransferStatus,
  UploadedAttachment
} from '../../shared/uploads'
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

  // Uploads write/mutate under the data root, so block them during the data-root copy→commit window.
  ipcMain.handle('uploads:stage-local-file', async (event, request: StageLocalUploadRequest) => {
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
      return attachment
    } catch (error) {
      if (writer.cancelled) await writer.cleanup
      else releaseLocalWriter(request.transferId, writer)
      throw error
    }
  })
  ipcMain.handle('uploads:claim-local-file', (event, request: UploadTransferRequest) => {
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
  ipcMain.handle('uploads:begin-transfer', async (event, request: BeginUploadTransferRequest) => {
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
  ipcMain.handle('uploads:append-transfer', async (event, request: AppendUploadTransferRequest) => {
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
  ipcMain.handle('uploads:transfer-status', (event, request: UploadTransferRequest) => {
    getOwnedChunkWriter(event, request.transferId)
    return repository.getTransferStatus(request)
  })
  ipcMain.handle('uploads:finish-transfer', async (event, request: UploadTransferRequest) => {
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
  ipcMain.handle('uploads:abort-transfer', async (event, request: UploadTransferRequest) => {
    const localWriter = getOwnedLocalWriter(event, request.transferId)
    if (localWriter) return abortLocalWriter(request.transferId, localWriter)

    const writer = getOwnedChunkWriter(event, request.transferId)
    if (!writer) return withDataRootWrite(() => repository.abortTransfer(request))

    await abortChunkWriter(request.transferId, writer)
  })
  ipcMain.handle('uploads:delete', (_event, request: DeleteUploadRequest) =>
    withDataRootWrite(() => repository.deleteUpload(request))
  )
  ipcMain.handle('uploads:finalize-session', (_event, request: FinalizeUploadSessionRequest) =>
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
  ipcMain.handle('uploads:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    repository.readManagedUploadPreview(request)
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
