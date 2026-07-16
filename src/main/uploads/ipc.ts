import { ipcMain } from 'electron'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  ReadUploadBytesRequest,
  StageUploadFilesRequest
} from '../../shared/uploads'
import { resolveDataRoot } from '../storage-root'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot())

// Registers the small upload IPC surface used by the renderer composer and preview panel.
const registerUploadIpcHandlers = (repository = createDefaultUploadRepository()): void => {
  ipcMain.handle('uploads:stage-files', (_event, request: StageUploadFilesRequest) =>
    repository.stageFiles(request)
  )
  ipcMain.handle('uploads:delete', (_event, request: DeleteUploadRequest) =>
    repository.deleteUpload(request)
  )
  ipcMain.handle('uploads:finalize-session', (_event, request: FinalizeUploadSessionRequest) =>
    repository.finalizePendingSessionUploads(request.sessionId, request.attachments)
  )
  ipcMain.handle('uploads:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    repository.readManagedUploadPreview(request)
  )
  ipcMain.handle('uploads:read-bytes', (_event, request: ReadUploadBytesRequest) =>
    repository.readManagedUploadBytes(request)
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
