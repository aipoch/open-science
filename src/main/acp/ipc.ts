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
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { installAgentShutdownGuard } from './shutdown-guard'
import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import type { TaskNotificationService } from '../notifications/task-notifications'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { SettingsService } from '../settings/service'
import type { UploadRepository } from '../uploads/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import { withDataRootWrite } from '../storage/migration-state'
import { createLogger, errorLogFields } from '../logger'

const log = createLogger('acp')

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
  initializationBarrier?: Promise<unknown>
  // Observes prompt starts and terminal turn events for desktop notifications. Optional so tests
  // and headless setups can run without a notification surface.
  taskNotifications?: TaskNotificationService
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

// Creates the runtime coordinator used by all ACP IPC handlers and artifact claims. Each child runtime
// captures one framework generation so sessions on different frameworks can remain live concurrently.
const createRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  uploadRepository,
  notebookRpcServer,
  settingsService,
  initializationBarrier,
  taskNotifications
}: AcpIpcOptions): AcpRuntimeCoordinator => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const defaultCwd = homedir()
  const callbacks: AcpRuntimeCallbacks = {
    onStateChanged: (state: AcpStateSnapshot) => broadcast('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      broadcast('acp:event', event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      void taskNotifications?.handleRuntimeEvent(event)
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcast('acp:permission-request', request)
      // A pending approval parks the turn; an unfocused user gets a desktop nudge.
      void taskNotifications?.handlePermissionRequest(request)
    }
  }

  return new AcpRuntimeCoordinator(
    (runtimeCallbacks) => {
      // Capture only the non-secret selection per generation. Credentials are resolved fresh at spawn
      // and released by AcpRuntime after authentication instead of living in this coordinator closure.
      const selection = settingsService.captureActiveAgentBackendSelection()
      return new AcpRuntime({
        appVersion: app.getVersion(),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        resolveBackend: async (context) =>
          settingsService.resolveAgentBackend(await selection, context),
        // HTTP MCP registrations are runtime-owned. Sharing one host would let an old runtime teardown
        // clear routes belonging to sessions on the newly selected framework.
        mcpHttpHost: new AgentMcpHttpHost(),
        skills: {
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids)
        },
        artifacts: {
          configRoot,
          dataRoot,
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          repository,
          runRegistry
        },
        uploads: { repository: uploadRepository },
        notebook: {
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          getRpcConnection: () => notebookRpcServer.ensureStarted(),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId)
        },
        activityGroups: { mcpEntryPath },
        callbacks: runtimeCallbacks
      })
    },
    callbacks,
    defaultCwd,
    initializationBarrier
  )
}

// Registers renderer-callable runtime commands on Electron IPC and returns the coordinator used by
// settings, storage, reviewer, and shutdown integrations.
const registerAcpIpcHandlers = (options: AcpIpcOptions): AcpRuntimeCoordinator => {
  const runtime = createRuntime(options)

  ipcMain.handle('acp:get-state', () => runtime.getSnapshot())
  ipcMain.handle('acp:connect', (_event, request: AcpConnectRequest) => runtime.connect(request))
  ipcMain.handle('acp:disconnect', () => runtime.disconnect())
  ipcMain.handle('acp:create-session', async (_event, request: AcpCreateSessionRequest) => {
    try {
      const explicitCwd = request.cwd?.trim()
      if (explicitCwd) {
        return await runtime.createSession({ ...request, cwd: explicitCwd })
      }

      return await withDataRootWrite(async () => {
        const managedCwd = await createManagedSessionWorkspace()
        try {
          return await runtime.createSession({ ...request, cwd: managedCwd })
        } catch (error) {
          await rm(managedCwd, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      })
    } catch (error) {
      // Route through the file logger (rotating main.log) so the failure survives in a packaged build,
      // not just the dev console. errorLogFields keeps the message + stack out of a `{}`. Guarded so a
      // throwing logger can never mask the original error the renderer must still receive.
      try {
        log.error('acp:create-session failed', errorLogFields(error))
      } catch {
        /* logging must never mask the real error */
      }
      throw error
    }
  })
  ipcMain.handle('acp:resume-session', (_event, request: AcpResumeSessionRequest) =>
    runtime.resumeSession(request)
  )
  ipcMain.handle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMain.handle('acp:send-prompt', async (_event, request: AcpPromptRequest) => {
    // Remember the prompt's first line so a completion/failure notification can name the task.
    // If the runtime rejects before the turn starts (unknown session, another prompt in flight),
    // revert so a still-running turn keeps its own prompt's name.
    const tracked = options.taskNotifications?.trackPrompt(request)

    try {
      await runtime.sendPrompt(request)
    } catch (error) {
      if (tracked) options.taskNotifications?.untrackPrompt(request.sessionId, tracked)
      throw error
    }

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
  const artifactRepository = new ArtifactRepository(dataRoot)

  return new NotebookRuntimeService({
    configRoot: resolveConfigRoot(),
    dataRoot,
    projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    repository: new NotebookRunRepository(dataRoot),
    // Region default for manage_packages when no mirror is configured; the configured override is
    // wired in main/ipc.ts via setPackageMirrorResolver once the settings service is constructed.
    locale: app.getLocale(),
    appVersion: app.getVersion(),
    resolveArtifactPath: (request) =>
      artifactRepository.resolveSessionArtifactFilePath(
        request.projectName,
        request.sessionId,
        request.path
      ),
    callbacks: {
      onNotebookAvailable: (event) => broadcast('notebook:available', event),
      onNotebookChanged: (event) => broadcast('notebook:changed', event)
    }
  })
}

export { createDefaultNotebookRuntimeService, registerAcpIpcHandlers }
