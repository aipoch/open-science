import { ipcMain } from 'electron'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalUploadRequest,
  UploadTransferRequest
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
  type ChunkWriter = {
    release: () => void
    ready: Promise<unknown>
  }
  const chunkWriters = new Map<string, ChunkWriter>()
  const releaseChunkWriter = (transferId: string, writer: ChunkWriter): void => {
    if (chunkWriters.get(transferId) !== writer) return
    chunkWriters.delete(transferId)
    writer.release()
  }

  // Uploads write/mutate under the data root, so block them during the data-root copy→commit window.
  ipcMain.handle('uploads:stage-local-file', (event, request: StageLocalUploadRequest) =>
    withDataRootWrite(() =>
      repository.stageLocalFile(request, (progress) => {
        event.sender.send('uploads:transfer-progress', progress)
      })
    )
  )
  ipcMain.handle('uploads:begin-transfer', async (_event, request: BeginUploadTransferRequest) => {
    const existing = chunkWriters.get(request.transferId)
    if (existing) {
      await existing.ready
      return repository.beginTransfer(request)
    }

    const writer: ChunkWriter = {
      release: acquireDataRootWriter(),
      ready: repository.beginTransfer(request)
    }
    chunkWriters.set(request.transferId, writer)
    try {
      return await writer.ready
    } catch (error) {
      releaseChunkWriter(request.transferId, writer)
      throw error
    }
  })
  ipcMain.handle('uploads:append-transfer', async (_event, request: AppendUploadTransferRequest) => {
    const writer = chunkWriters.get(request.transferId)
    if (!writer) return withDataRootWrite(() => repository.appendTransfer(request))

    await writer.ready
    return repository.appendTransfer(request)
  })
  ipcMain.handle('uploads:transfer-status', (_event, request: UploadTransferRequest) =>
    repository.getTransferStatus(request)
  )
  ipcMain.handle('uploads:finish-transfer', async (_event, request: UploadTransferRequest) => {
    const writer = chunkWriters.get(request.transferId)
    if (!writer) return withDataRootWrite(() => repository.finishTransfer(request))

    try {
      await writer.ready
      return await repository.finishTransfer(request)
    } catch (error) {
      await repository.abortTransfer(request).catch(() => undefined)
      throw error
    } finally {
      releaseChunkWriter(request.transferId, writer)
    }
  })
  ipcMain.handle('uploads:abort-transfer', async (_event, request: UploadTransferRequest) => {
    const writer = chunkWriters.get(request.transferId)
    if (!writer) return withDataRootWrite(() => repository.abortTransfer(request))

    try {
      await writer.ready.catch(() => undefined)
      await repository.abortTransfer(request)
    } finally {
      releaseChunkWriter(request.transferId, writer)
    }
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
