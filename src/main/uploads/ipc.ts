import { ipcMain, type Event as ElectronEvent, type IpcMainInvokeEvent } from 'electron'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalUploadRequest,
  UploadTransferRequest,
  UploadTransferStatus
} from '../../shared/uploads'
import { resolveDataRoot } from '../storage-root'
import { acquireDataRootWriter, withDataRootWrite } from '../storage/migration-state'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot())

// Registers the small upload IPC surface used by the renderer composer and preview panel.
const registerUploadIpcHandlers = (repository = createDefaultUploadRepository()): void => {
  // A chunk transfer spans several IPC calls but is one logical write. Holding the writer lease from
  // begin through finish/abort makes data-root migration wait across the gaps between chunks.
  type ChunkOwner = {
    senderId: number
    transferIds: Set<string>
  }
  type ChunkWriter = {
    owner: ChunkOwner
    release: () => void
    ready: Promise<UploadTransferStatus>
    cancelled: boolean
    settling: boolean
    inFlight: Set<Promise<unknown>>
    cleanup?: Promise<void>
  }
  const chunkOwners = new Map<number, ChunkOwner>()
  const chunkWriters = new Map<string, ChunkWriter>()
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
  const registerChunkOwner = (event: IpcMainInvokeEvent): ChunkOwner => {
    const existing = chunkOwners.get(event.sender.id)
    if (existing) return existing

    const owner: ChunkOwner = { senderId: event.sender.id, transferIds: new Set() }
    chunkOwners.set(owner.senderId, owner)
    const releaseOwner = (): void => {
      if (chunkOwners.get(owner.senderId) !== owner) return
      chunkOwners.delete(owner.senderId)
      event.sender.removeListener('destroyed', releaseOwner)
      event.sender.removeListener('render-process-gone', releaseOwner)
      event.sender.removeListener('did-start-navigation', releaseOnMainFrameNavigation)
      for (const transferId of [...owner.transferIds]) {
        const writer = chunkWriters.get(transferId)
        if (writer?.owner === owner && !writer.settling) void abortChunkWriter(transferId, writer)
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
    const owner = registerChunkOwner(event)
    const writer = chunkWriters.get(transferId)
    if (writer && writer.owner !== owner) {
      throw new Error(`Upload transfer belongs to another renderer: ${transferId}`)
    }
    return writer
  }

  // Uploads write/mutate under the data root, so block them during the data-root copy→commit window.
  ipcMain.handle('uploads:stage-local-file', (event, request: StageLocalUploadRequest) =>
    withDataRootWrite(() =>
      repository.stageLocalFile(request, (progress) => {
        event.sender.send('uploads:transfer-progress', progress)
      })
    )
  )
  ipcMain.handle('uploads:begin-transfer', async (event, request: BeginUploadTransferRequest) => {
    const owner = registerChunkOwner(event)
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
    const writer = getOwnedChunkWriter(event, request.transferId)
    if (!writer) return withDataRootWrite(() => repository.abortTransfer(request))

    await abortChunkWriter(request.transferId, writer)
  })
  ipcMain.handle('uploads:delete', (_event, request: DeleteUploadRequest) =>
    withDataRootWrite(() => repository.deleteUpload(request))
  )
  ipcMain.handle('uploads:finalize-session', (_event, request: FinalizeUploadSessionRequest) =>
    withDataRootWrite(() =>
      repository.finalizePendingSessionUploads(request.sessionId, request.attachments)
    )
  )
  ipcMain.handle('uploads:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    repository.readManagedUploadPreview(request)
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
