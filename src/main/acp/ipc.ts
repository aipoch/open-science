import { homedir } from 'node:os'

import { app, BrowserWindow, ipcMain } from 'electron'

import type {
  AcpCancelPromptRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { AcpRuntime } from './runtime'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { SettingsService } from '../settings/service'
import type { UploadRepository } from '../uploads/repository'

type AcpIpcArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
}

type AcpIpcOptions = AcpIpcArtifacts & {
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  // Drives the agent spawn env from the active provider so switching takes effect on reconnect.
  settingsService: SettingsService
}

// Sends one runtime payload to every currently open renderer window.
const broadcast = <Payload>(channel: string, payload: Payload): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

// Creates the shared runtime instance used by all ACP IPC handlers and artifact claims.
const createRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  uploadRepository,
  notebookRpcServer,
  settingsService
}: AcpIpcOptions): AcpRuntime => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()

  return new AcpRuntime({
    appVersion: app.getVersion(),
    // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
    defaultCwd: homedir(),
    // Read the active provider's credentials/model on every connect so provider switches apply.
    resolveSpawnConfig: () => settingsService.resolveActiveSpawnConfig(),
    // Turn-scoped skill force-load: the runtime uses these to respawn with a picked-but-disabled skill
    // for one prompt and to build the steering nudge naming the picked skills.
    skills: {
      needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
      setTurnForced: (ids) => settingsService.setTurnForcedSkillIds(ids),
      clearTurnForced: () => settingsService.clearTurnForcedSkillIds(),
      namesForIds: (ids) => settingsService.skillNamesForIds(ids)
    },
    artifacts: {
      // Reuse the session persistence root so chat state and generated files move together.
      configRoot,
      dataRoot,
      projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
      mcpEntryPath,
      repository,
      runRegistry
    },
    uploads: {
      // Reuse the renderer upload repository so prompt content only references managed files.
      repository: uploadRepository
    },
    notebook: {
      projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
      mcpEntryPath,
      getRpcConnection: () => notebookRpcServer.ensureStarted(),
      registerSessionAlias: (aliasSessionId, sessionId) =>
        notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId)
    },
    callbacks: {
      onStateChanged: (state: AcpStateSnapshot) => broadcast('acp:state', state),
      onEvent: (event: AcpRuntimeEvent) => broadcast('acp:event', event),
      onPermissionRequest: (request: AcpPermissionRequest) =>
        broadcast('acp:permission-request', request)
    }
  })
}

// Registers renderer-callable runtime commands on Electron IPC and returns the shared runtime so the
// settings layer can drop the connection when the active provider changes.
const registerAcpIpcHandlers = (options: AcpIpcOptions): AcpRuntime => {
  const runtime = createRuntime(options)

  ipcMain.handle('acp:get-state', () => runtime.getSnapshot())
  ipcMain.handle('acp:connect', async (_event, request: AcpConnectRequest) =>
    runtime.connect(request)
  )
  ipcMain.handle('acp:disconnect', () => runtime.disconnect())
  ipcMain.handle('acp:create-session', async (_event, request: AcpCreateSessionRequest) =>
    runtime.createSession(request)
  )
  ipcMain.handle('acp:resume-session', async (_event, request: AcpResumeSessionRequest) =>
    runtime.resumeSession(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMain.handle('acp:send-prompt', async (_event, request: AcpPromptRequest) => {
    await runtime.sendPrompt(request)
    return runtime.getSnapshot()
  })
  ipcMain.handle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    runtime.cancelPrompt(request)
  )
  ipcMain.handle('acp:delete-session', (_event, request: AcpDeleteSessionRequest) =>
    runtime.deleteSession(request)
  )
  ipcMain.handle('acp:respond-permission', (_event, response: AcpPermissionResponse) =>
    runtime.respondToPermission(response)
  )
  ipcMain.handle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    runtime.setPermissionProfile(request)
  )
  ipcMain.handle(
    'acp:revoke-permission-grant',
    (_event, request: AcpRevokePermissionGrantRequest) => runtime.revokePermissionGrant(request)
  )

  return runtime
}

// Creates the shared notebook runtime used by both renderer IPC and agent MCP calls.
const createDefaultNotebookRuntimeService = (): NotebookRuntimeService => {
  const dataRoot = resolveDataRoot()

  return new NotebookRuntimeService({
    configRoot: resolveConfigRoot(),
    dataRoot,
    projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    repository: new NotebookRunRepository(dataRoot),
    // Region default for manage_packages when no mirror is configured; the configured override is
    // wired in main/ipc.ts via setPackageMirrorResolver once the settings service is constructed.
    locale: app.getLocale(),
    callbacks: {
      onNotebookAvailable: (event) => broadcast('notebook:available', event),
      onNotebookChanged: (event) => broadcast('notebook:changed', event)
    }
  })
}

export { createDefaultNotebookRuntimeService, registerAcpIpcHandlers }
