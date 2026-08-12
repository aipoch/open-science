import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from '../../shared/local-fs'
import { ipcMainHandle } from '../ipc-handler-registry'
import { LocalFsService } from './service'

// Channel names for the local ("This computer") file browser. Grouped under the local-fs: prefix.
export const LOCAL_FS_LIST_DIR_CHANNEL = 'local-fs:list-dir'
export const LOCAL_FS_LIST_DRIVES_CHANNEL = 'local-fs:list-drives'
export const LOCAL_FS_READ_PREVIEW_CHANNEL = 'local-fs:read-preview'
export const LOCAL_FS_GET_ROOTS_CHANNEL = 'local-fs:get-roots'
export const LOCAL_FS_REVEAL_CHANNEL = 'local-fs:reveal'
export const LOCAL_FS_OPEN_PATH_CHANNEL = 'local-fs:open-path'
// Granted-roots channels: the renderer manages the list, main validates and persists.
export const LOCAL_FS_GRANTED_ROOTS_LIST_CHANNEL = 'local-fs:granted-roots:list'
export const LOCAL_FS_GRANT_ROOT_CHANNEL = 'local-fs:grant-root'
export const LOCAL_FS_GRANTED_ROOTS_SET_ACCESS_CHANNEL = 'local-fs:granted-roots:set-access'
export const LOCAL_FS_GRANTED_ROOTS_REMOVE_CHANNEL = 'local-fs:granted-roots:remove'

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
  ipcMainHandle(LOCAL_FS_LIST_DRIVES_CHANNEL, (): Promise<LocalDrive[]> => service.listDrives())
  ipcMainHandle(LOCAL_FS_REVEAL_CHANNEL, (_event, path: string): void => {
    service.revealInFolder(path)
  })
  ipcMainHandle(LOCAL_FS_OPEN_PATH_CHANNEL, (_event, path: string): Promise<string> =>
    service.openPath(path)
  )
  ipcMainHandle(LOCAL_FS_GRANTED_ROOTS_LIST_CHANNEL, (): Promise<GrantedLocalRoot[]> =>
    service.listGrantedRoots()
  )
  ipcMainHandle(
    LOCAL_FS_GRANT_ROOT_CHANNEL,
    (_event, request: GrantLocalRootRequest): Promise<GrantedLocalRoot[]> =>
      service.grantRoot(request)
  )
  ipcMainHandle(
    LOCAL_FS_GRANTED_ROOTS_SET_ACCESS_CHANNEL,
    (_event, request: SetGrantedLocalRootAccessRequest): Promise<GrantedLocalRoot[]> =>
      service.setGrantedRootAccess(request)
  )
  ipcMainHandle(
    LOCAL_FS_GRANTED_ROOTS_REMOVE_CHANNEL,
    (_event, request: RemoveGrantedLocalRootRequest): Promise<GrantedLocalRoot[]> =>
      service.removeGrantedRoot(request)
  )
}
