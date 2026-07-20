import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app, ipcMain } from 'electron'

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
import { installAgentShutdownGuard } from './shutdown-guard'
import { AgentMcpHttpHost } from './mcp-http-host'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { SettingsService } from '../settings/service'
import type { UploadRepository } from '../uploads/repository'
import { broadcastToRenderers } from '../renderer-broadcast'

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
  broadcastToRenderers(channel, payload)
}

// Gives every new conversation an isolated working directory under the relocatable data root.
// Persisted sessions keep this returned path as their cwd, so resumes return to the same workspace.
const createManagedSessionWorkspace = async (): Promise<string> => {
  const workspace = join(resolveDataRoot(), 'workspaces', randomUUID())

  await mkdir(workspace, { recursive: true })
  return workspace
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
    // Resolve the active framework + provider credentials/model on every connect so framework and
    // provider switches apply on reconnect.
    resolveBackend: () => settingsService.resolveActiveAgentBackend(),
    // Serves the artifact/notebook MCP over local http for frameworks that reject stdio MCP (opencode);
    // Claude ignores it and keeps launching them over stdio.
    mcpHttpHost: new AgentMcpHttpHost(),
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
  ipcMain.handle('acp:create-session', async (_event, request: AcpCreateSessionRequest) => {
    const explicitCwd = request.cwd?.trim()
    if (explicitCwd) {
      return runtime.createSession({ ...request, cwd: explicitCwd })
    }

    const managedCwd = await createManagedSessionWorkspace()
    try {
      return await runtime.createSession({ ...request, cwd: managedCwd })
    } catch (error) {
      await rm(managedCwd, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })
  ipcMain.handle('acp:resume-session', async (_event, request: AcpResumeSessionRequest) =>
    runtime.resumeSession(request)
  )
  ipcMain.handle('acp:reset-session-context', async (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
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

  // Kill the agent child on quit so it never outlives the app as an orphaned process.
  installAgentShutdownGuard(app, runtime)

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
    callbacks: {
      onNotebookAvailable: (event) => broadcast('notebook:available', event),
      onNotebookChanged: (event) => broadcast('notebook:changed', event)
    }
  })
}

export { createDefaultNotebookRuntimeService, registerAcpIpcHandlers }
