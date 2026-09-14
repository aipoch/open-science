import { registerCliInstallIpcHandlers, type CliCommandOwner } from '../cli-install/ipc'
import { registerFileSaveHandlers, type RegisterFileSaveHandlersOptions } from '../file-save'
import { registerGithubIpcHandlers, type GithubCommandOwner } from '../github-ipc'
import type { NativeTranslator } from '../locale/main-process-messages'
import { registerLogsIpcHandlers, type LogsCommandOwner } from '../logs-ipc'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { NotebookInputRegistry } from '../notebook/input-registry'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { registerWindowFindIpcHandlers } from '../window-find-ipc'
import { registerWindowIpcHandlers } from '../window-ipc'
import { createElectronSurfaceAdapter } from './adapter'

type DesktopUtilitiesOwners = {
  resolveManagedFilePath: NonNullable<RegisterFileSaveHandlersOptions['resolveManagedFilePath']>
  managedFileVersions: Pick<ManagedFileVersionService, 'openLatest' | 'openVersion'>
  notebookInputs: Pick<NotebookInputRegistry, 'openPreviewKey'>
  translate: NativeTranslator
  logs: LogsCommandOwner
  github: GithubCommandOwner
  cli: CliCommandOwner
}

export const createDesktopUtilitiesElectronSurface = ({
  resolveManagedFilePath,
  managedFileVersions,
  notebookInputs,
  translate,
  logs,
  github,
  cli
}: DesktopUtilitiesOwners): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('desktop-utilities', () => {
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openLatestManagedFile: (source, request) =>
        managedFileVersions.openLatest({ source, ...request }),
      openManagedFileVersion: (source, request) =>
        managedFileVersions.openVersion(
          { source, projectId: request.projectId, fileId: request.fileId },
          request.versionId
        ),
      openNotebookInput: (request) => notebookInputs.openPreviewKey(request.path),
      translate
    })
    registerLogsIpcHandlers(logs)
    registerGithubIpcHandlers({}, github)
    registerCliInstallIpcHandlers(cli)
    registerWindowIpcHandlers()
    return registerWindowFindIpcHandlers()
  })
