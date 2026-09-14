import { registerPermissionGrantIpcAdapter } from '../permission-grants/ipc'
import { registerLocalFsIpcHandlers } from '../local-fs/ipc'
import { registerManagedFileVersionIpcHandlers } from '../managed-file-versions/ipc'
import { registerPreviewStateIpcHandlers } from '../projects/ipc'
import { registerProjectFilesIpcHandlers } from '../project-files/ipc'
import { registerLifecycleIpcHandlers } from '../lifecycle-broadcast'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { createElectronSurfaceAdapter } from './adapter'

export type CoreElectronSurfaceDependencies = Readonly<{
  permissionGrantProjection: Parameters<typeof registerPermissionGrantIpcAdapter>[0]
  projectFiles: Required<Parameters<typeof registerProjectFilesIpcHandlers>>
  managedFileVersionHandlers: Parameters<typeof registerManagedFileVersionIpcHandlers>[0]
  localFsService: NonNullable<Parameters<typeof registerLocalFsIpcHandlers>[0]>
  previewStateRepository: Parameters<typeof registerPreviewStateIpcHandlers>[0]
}>

// Own only transport installation. The composition root supplies the same constructed owners used
// by application commands; declaration does not install channels or construct another owner.
export const createCoreElectronSurfaces = (
  dependencies: CoreElectronSurfaceDependencies
): NamedElectronSurfaceAdapter[] => [
  createElectronSurfaceAdapter('permission-grants', () =>
    registerPermissionGrantIpcAdapter(dependencies.permissionGrantProjection)
  ),
  createElectronSurfaceAdapter('project-files', () =>
    registerProjectFilesIpcHandlers(...dependencies.projectFiles)
  ),
  createElectronSurfaceAdapter('managed-file-versions', () =>
    registerManagedFileVersionIpcHandlers(dependencies.managedFileVersionHandlers)
  ),
  createElectronSurfaceAdapter('local-fs', () =>
    registerLocalFsIpcHandlers(dependencies.localFsService)
  ),
  createElectronSurfaceAdapter('preview-state', () =>
    registerPreviewStateIpcHandlers(dependencies.previewStateRepository)
  ),
  createElectronSurfaceAdapter('lifecycle', registerLifecycleIpcHandlers)
]
