import { createFileSaveCommands } from '../file-save'
import { hasDesktopInteraction } from '../desktop-interaction'
import { createDesktopUtilitiesElectronSurface } from '../desktop-surface-declarations'
import { createCliCommandOwner } from '../cli-install/ipc'
import { createGithubCommandOwner } from '../github-ipc'

import { createLogsCommandOwner } from '../logs-ipc'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { netFetchStandard } from '../skills/net-fetch'
import type { composeManagedFiles } from './managed-files'
import type { composeSessionAuthority } from './session-authority'

export async function composeDesktopUtilities({
  surfaceAdapters,
  managedFileVersionService,
  managedFiles,
  sessionAuthority,
  translate
}: {
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  managedFileVersionService: ManagedFileVersionService
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  translate: import('../locale/main-process-messages').NativeTranslator
}): Promise<{
  fileSaveCommands: ReturnType<typeof createFileSaveCommands>
  cliCommandOwner: ReturnType<typeof createCliCommandOwner>
  githubCommandOwner: ReturnType<typeof createGithubCommandOwner>
  logsCommandOwner: ReturnType<typeof createLogsCommandOwner>
}> {
  const cliCommandOwner = createCliCommandOwner()
  // Reconcile an existing legacy AppImage shim before startup completes. The owner scopes the
  // operation to Linux AppImage and records any filesystem failure without aborting the app.
  if (hasDesktopInteraction()) await cliCommandOwner.ensureCurrent()
  const githubCommandOwner = createGithubCommandOwner({ fetch: netFetchStandard })
  const logsCommandOwner = createLogsCommandOwner()
  const fileSaveCommands = createFileSaveCommands({
    resolveManagedFilePath: managedFiles.resolveManagedFilePath,
    openLatestManagedFile: (source, request) =>
      managedFileVersionService.openLatest({ source, ...request }),
    openManagedFileVersion: (source, request) =>
      managedFileVersionService.openVersion(
        { source, projectId: request.projectId, fileId: request.fileId },
        request.versionId
      ),
    openNotebookInput: (request) =>
      sessionAuthority.notebookInputRegistry.openPreviewKey(request.path),
    translate
  })
  surfaceAdapters.push(
    createDesktopUtilitiesElectronSurface({
      fileSaveCommands,
      resolveManagedFilePath: managedFiles.resolveManagedFilePath,
      managedFileVersions: managedFileVersionService,
      notebookInputs: sessionAuthority.notebookInputRegistry,
      translate,
      logs: logsCommandOwner,
      github: githubCommandOwner,
      cli: cliCommandOwner
    })
  )
  return { fileSaveCommands, cliCommandOwner, githubCommandOwner, logsCommandOwner }
}
