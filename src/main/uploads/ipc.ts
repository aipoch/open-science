import { ipcMain } from 'electron'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageUploadFilesRequest
} from '../../shared/uploads'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot())

// Registers the small upload IPC surface used by the renderer composer and preview panel.
const registerUploadIpcHandlers = (repository = createDefaultUploadRepository()): void => {
  // Uploads write/mutate under the data root, so block them during the data-root copy→commit window.
  ipcMain.handle('uploads:stage-files', (_event, request: StageUploadFilesRequest) =>
    withDataRootWrite(() => repository.stageFiles(request))
  )
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
