import { app } from 'electron'

import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpHandlerWorkflows } from './handler-workflows'
import { installAgentShutdownGuard } from './shutdown-guard'
import { ArtifactRepository } from '../artifacts/repository'
import { NotebookRunRepository } from '../notebook/repository'
import {
  NotebookRuntimeService,
  type NotebookRuntimeServiceOptions
} from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { broadcastToRenderers } from '../renderer-broadcast'

// Sends one runtime payload through the typed application-event compatibility facade.
const broadcast = broadcastToRenderers

const registerAcpIpcHandlerSet = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows
): void => {
  ipcMainHandle('acp:get-state', () => runtime.getSnapshot())
  ipcMainHandle('acp:connect', (_event, request: AcpConnectRequest) => runtime.connect(request))
  ipcMainHandle('acp:disconnect', () => runtime.disconnect())
  ipcMainHandle('acp:create-session', (_event, request: AcpCreateSessionRequest) =>
    workflows.createSession(request)
  )
  ipcMainHandle('acp:resume-session', (_event, request: AcpResumeSessionRequest) =>
    workflows.resumeSession(request)
  )
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    runtime.compactSession(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', (_event, request: AcpPromptRequest) => {
    // Continuations are main-process-owned. A renderer-supplied marker must never suppress a visible
    // user message or impersonate the handoff path.
    const rendererRequest = { ...request, continuation: undefined }
    return workflows.sendPrompt(rendererRequest)
  })
  ipcMainHandle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    runtime.cancelPrompt(request)
  )
  ipcMainHandle('acp:delete-session', async (_event, request: AcpDeleteSessionRequest) => {
    // The coordinator owns session disappearance notifications for delete, connection loss, and
    // retirement. Keeping that signal in one layer prevents a successful delete from firing twice.
    return runtime.deleteSession(request)
  })
  ipcMainHandle('acp:respond-permission', (_event, response: AcpPermissionResponse) =>
    runtime.respondToPermission(response)
  )
  ipcMainHandle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    runtime.setPermissionProfile(request)
  )
  ipcMainHandle('acp:revoke-permission-grant', (_event, request: AcpRevokePermissionGrantRequest) =>
    runtime.revokePermissionGrant(request)
  )
}

// Installs the renderer-callable Electron adapter over an already-constructed ACP coordinator.
const installAcpIpcHandlers = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerAcpIpcHandlerSet(runtime, workflows)
    // Kill the agent child on quit so it never outlives the app as an orphaned process.
    return scope.complete(installAgentShutdownGuard(app, runtime))
  } catch (error) {
    scope.rollback()
    throw error
  }
}

// Creates the shared notebook runtime used by both renderer IPC and agent MCP calls.
type DefaultNotebookRuntimeServiceDeps = Pick<
  NotebookRuntimeServiceOptions,
  'getPackageMirror' | 'notebookRuntimeSettings'
>

const createDefaultNotebookRuntimeService = (
  deps: DefaultNotebookRuntimeServiceDeps = {}
): NotebookRuntimeService => {
  const dataRoot = resolveDataRoot()
  const artifactRepository = new ArtifactRepository(dataRoot)

  return new NotebookRuntimeService({
    configRoot: resolveConfigRoot(),
    dataRoot,
    projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    repository: new NotebookRunRepository(dataRoot),
    ...deps,
    // Region default for manage_packages when no mirror is configured.
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

export { createDefaultNotebookRuntimeService, installAcpIpcHandlers }
