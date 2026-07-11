import { createDefaultNotebookRuntimeService, registerAcpIpcHandlers } from './acp/ipc'
import { createDefaultArtifactRepository, registerArtifactIpcHandlers } from './artifacts/ipc'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { registerFileSaveHandlers } from './file-save'
import { registerLogsIpcHandlers } from './logs-ipc'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { registerProjectIpcHandlers } from './projects/ipc'
import { registerSessionPersistenceIpcHandlers } from './session-persistence/ipc'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { createDefaultSettingsService } from './settings/service'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'

type IpcRegistrationOptions = {
  mainEntryPath: string
}

// Registers every main-process IPC surface used by the renderer.
const registerIpcHandlers = ({ mainEntryPath }: IpcRegistrationOptions): void => {
  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const artifactRunRegistry = new ArtifactRunRegistry()
  // Share one upload repository so composer staging, prompt finalization, and previews agree.
  const uploadRepository = createDefaultUploadRepository()
  const notebookService = createDefaultNotebookRuntimeService()
  const notebookRpcServer = new NotebookLocalRpcServer(notebookService)
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsService = createDefaultSettingsService()

  registerFileSaveHandlers()
  registerLogsIpcHandlers()
  const runtime = registerAcpIpcHandlers({
    mcpEntryPath: mainEntryPath,
    repository: artifactRepository,
    runRegistry: artifactRunRegistry,
    uploadRepository,
    notebookRpcServer,
    settingsService
  })
  // Switching the active provider takes effect on the next reconnect. Defer that reconnect until any
  // in-flight prompt finishes so switching never interrupts a running turn; the shared config dir keeps
  // the conversation's context across the switch.
  registerSettingsIpcHandlers({
    service: settingsService,
    onActiveProviderChanged: () => void runtime.requestProviderReconnect()
  })
  registerNotebookIpcHandlers(notebookService)
  registerArtifactIpcHandlers(artifactRepository, artifactRunRegistry)
  registerUploadIpcHandlers(uploadRepository)
  registerSessionPersistenceIpcHandlers()
  registerProjectIpcHandlers()
}

export { registerIpcHandlers }
