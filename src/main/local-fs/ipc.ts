import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type { LocalDirListing, LocalRoots } from '../../shared/local-fs'
import { ipcMainHandle } from '../ipc-handler-registry'
import { LocalFsService } from './service'

// Channel names for the local ("This computer") file browser. Grouped under the local-fs: prefix.
export const LOCAL_FS_LIST_DIR_CHANNEL = 'local-fs:list-dir'
export const LOCAL_FS_READ_PREVIEW_CHANNEL = 'local-fs:read-preview'
export const LOCAL_FS_GET_ROOTS_CHANNEL = 'local-fs:get-roots'
export const LOCAL_FS_REVEAL_CHANNEL = 'local-fs:reveal'
export const LOCAL_FS_OPEN_PATH_CHANNEL = 'local-fs:open-path'

// Registers the local-fs IPC handlers against a service instance (injectable for tests).
export const registerLocalFsIpcHandlers = (
  service: LocalFsService = new LocalFsService()
): void => {
  ipcMainHandle(LOCAL_FS_LIST_DIR_CHANNEL, (_event, path: string): Promise<LocalDirListing> =>
    service.listDir(path)
  )
  ipcMainHandle(
    LOCAL_FS_READ_PREVIEW_CHANNEL,
    (_event, request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult> =>
      service.readPreview(request)
  )
  ipcMainHandle(LOCAL_FS_GET_ROOTS_CHANNEL, (): LocalRoots => service.getRoots())
  ipcMainHandle(LOCAL_FS_REVEAL_CHANNEL, (_event, path: string): void => {
    service.revealInFolder(path)
  })
  ipcMainHandle(LOCAL_FS_OPEN_PATH_CHANNEL, (_event, path: string): Promise<string> =>
    service.openPath(path)
  )
}
