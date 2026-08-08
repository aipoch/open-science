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
  AcpContinueInterruptedTurnRequest,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  ElicitationResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpHandlerWorkflows } from './handler-workflows'
import { installAgentShutdownGuard } from './shutdown-guard'

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
  ipcMainHandle(
    'acp:continue-interrupted-turn',
    (_event, request: AcpContinueInterruptedTurnRequest) =>
      workflows.continueInterruptedTurn(request)
  )
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    runtime.compactSession(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', (_event, request: AcpPromptRequest) => {
    // Continuation controls are main-process-owned. Renderer input must never suppress a visible
    // user message or impersonate the handoff path.
    const rendererRequest: AcpPromptRequest = {
      ...request,
      turnIntent: request.turnIntent === 'plan-first' ? 'plan-first' : undefined,
      continuation: undefined,
      suppressUserMessage: undefined
    }
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
  ipcMainHandle('acp:get-plan-projection', (_event, projectId: string, sessionId: string) =>
    runtime.getSessionPlanProjection(projectId, sessionId)
  )
  ipcMainHandle(
    'acp:respond-plan',
    (_event, request: Parameters<AcpRuntimeCoordinator['respondSessionPlan']>[0]) =>
      runtime.respondSessionPlan(request)
  )
  ipcMainHandle('acp:respond-elicitation', (_event, response: ElicitationResponse) =>
    runtime.respondToElicitation(response)
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

export { installAcpIpcHandlers }
