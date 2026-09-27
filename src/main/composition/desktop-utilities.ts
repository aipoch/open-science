import { createCliCommandOwner } from '../cli-install/ipc'
import { createGithubCommandOwner } from '../github-ipc'
import { createDesktopUtilitiesElectronSurface } from '../ipc-surfaces/desktop-utilities'
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
  cliCommandOwner: ReturnType<typeof createCliCommandOwner>
  githubCommandOwner: ReturnType<typeof createGithubCommandOwner>
  logsCommandOwner: ReturnType<typeof createLogsCommandOwner>
}> {
  const cliCommandOwner = createCliCommandOwner()
  // Reconcile an existing legacy AppImage shim before startup completes. The owner scopes the
  // operation to Linux AppImage and records any filesystem failure without aborting the app.
  await cliCommandOwner.ensureCurrent()
  const githubCommandOwner = createGithubCommandOwner({ fetch: netFetchStandard })
  const logsCommandOwner = createLogsCommandOwner()
  surfaceAdapters.push(
    createDesktopUtilitiesElectronSurface({
      resolveManagedFilePath: managedFiles.resolveManagedFilePath,
      managedFileVersions: managedFileVersionService,
      notebookInputs: sessionAuthority.notebookInputRegistry,
      translate,
      logs: logsCommandOwner,
      github: githubCommandOwner,
      cli: cliCommandOwner
    })
  )
  return { cliCommandOwner, githubCommandOwner, logsCommandOwner }
}
