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
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateCommandResponse,
  AcpStateUpdate
} from '../../shared/acp'
import { toAcpStateCommandResponse } from '../../shared/acp'
import { sanitizeSessionReferences } from '../../shared/session-persistence'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpHandlerWorkflows } from './handler-workflows'
import { bindResumeRequestToProject } from './session-project-binding'
import { installAgentShutdownGuard } from './shutdown-guard'

type AcpIpcSessionAdmission = {
  withSessionAvailableById<Result>(
    sessionId: string,
    operation: (projectId: string) => Promise<Result>
  ): Promise<Result>
}

type AcpSessionMemoryPreferenceResolver = (request: {
  sessionId: string
}) => Promise<boolean | undefined>

const withDurableMemoryPreference = async (
  request: AcpResumeSessionRequest,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): Promise<AcpResumeSessionRequest> => {
  if (!resolveMemoryEnabled) return request
  const memoryEnabled = await resolveMemoryEnabled({ sessionId: request.sessionId })
  return { ...request, memoryEnabled: memoryEnabled ?? false }
}

const stateCommand = async (operation: Promise<AcpStateUpdate>): Promise<AcpStateCommandResponse> =>
  toAcpStateCommandResponse(await operation)

const registerAcpIpcHandlerSet = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows,
  sessionAdmission: AcpIpcSessionAdmission,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): void => {
  ipcMainHandle('acp:get-state', () => runtime.getSnapshot())
  ipcMainHandle('acp:connect', (_event, request: AcpConnectRequest) =>
    stateCommand(runtime.connect(request))
  )
  ipcMainHandle('acp:disconnect', () => stateCommand(runtime.disconnect()))
  ipcMainHandle('acp:create-session', (_event, request: AcpCreateSessionRequest) =>
    workflows.createSession(request)
  )
  ipcMainHandle('acp:resume-session', async (_event, request: AcpResumeSessionRequest) =>
    workflows.resumeSession(await withDurableMemoryPreference(request, resolveMemoryEnabled))
  )
  ipcMainHandle(
    'acp:continue-interrupted-turn',
    (_event, request: AcpContinueInterruptedTurnRequest) =>
      stateCommand(workflows.continueInterruptedTurn(request))
  )
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    sessionAdmission.withSessionAvailableById(request.sessionId, async (projectId) =>
      runtime.resetSessionContext(
        await withDurableMemoryPreference(
          bindResumeRequestToProject(request, projectId),
          resolveMemoryEnabled
        )
      )
    )
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    stateCommand(
      sessionAdmission.withSessionAvailableById(request.sessionId, () =>
        runtime.compactSession(request)
      )
    )
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', (_event, request: AcpPromptRequest) => {
    // Continuation controls are main-process-owned. Renderer input must never suppress a visible
    // user message or impersonate the handoff path.
    const {
      attribution: _untrustedAttribution,
      referencedSessions: untrustedSessionReferences,
      ...untrustedRequest
    } = request as AcpPromptRequest & {
      attribution?: unknown
    }
    void _untrustedAttribution
    const referencedSessions = sanitizeSessionReferences(untrustedSessionReferences)
    const rendererRequest: AcpPromptRequest = {
      ...untrustedRequest,
      memoryEnabled: request.memoryEnabled !== false,
      turnIntent: request.turnIntent === 'plan-first' ? 'plan-first' : undefined,
      ...(referencedSessions.length > 0 ? { referencedSessions } : {}),
      continuation: undefined,
      suppressUserMessage: undefined
    }
    return stateCommand(workflows.sendPrompt(rendererRequest))
  })
  ipcMainHandle('acp:steer-follow-up', (_event, request: AcpSteerFollowUpRequest) =>
    runtime.steerFollowUp({
      sessionId: request.sessionId,
      text: typeof request.text === 'string' ? request.text : '',
      ...(Array.isArray(request.attachments) ? { attachments: request.attachments } : {}),
      ...(Array.isArray(request.referencedArtifacts)
        ? { referencedArtifacts: request.referencedArtifacts }
        : {}),
      ...(Array.isArray(request.forcedSkillIds) ? { forcedSkillIds: request.forcedSkillIds } : {}),
      ...(Array.isArray(request.parts) ? { parts: request.parts } : {})
    })
  )
  ipcMainHandle('acp:save-as-skill', (_event, request: AcpSaveAsSkillRequest) =>
    stateCommand(workflows.saveAsSkill(request))
  )
  ipcMainHandle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    stateCommand(runtime.cancelPrompt(request))
  )
  ipcMainHandle('acp:delete-session', async (_event, request: AcpDeleteSessionRequest) => {
    // The coordinator owns session disappearance notifications for delete, connection loss, and
    // retirement. Keeping that signal in one layer prevents a successful delete from firing twice.
    return stateCommand(runtime.deleteSession(request))
  })
  ipcMainHandle('acp:get-plan-projection', (_event, projectId: string, sessionId: string) =>
    runtime.getSessionPlanProjection(projectId, sessionId)
  )
  ipcMainHandle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    stateCommand(
      sessionAdmission.withSessionAvailableById(request.sessionId, () =>
        runtime.setPermissionProfile(request)
      )
    )
  )
  ipcMainHandle('acp:revoke-permission-grant', (_event, request: AcpRevokePermissionGrantRequest) =>
    stateCommand(
      sessionAdmission.withSessionAvailableById(request.sessionId, () =>
        runtime.revokePermissionGrant(request)
      )
    )
  )
}

// Installs the renderer-callable Electron adapter over an already-constructed ACP coordinator.
const installAcpIpcHandlers = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows,
  sessionAdmission: AcpIpcSessionAdmission,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerAcpIpcHandlerSet(runtime, workflows, sessionAdmission, resolveMemoryEnabled)
    // Kill the agent child on quit so it never outlives the app as an orphaned process.
    return scope.complete(installAgentShutdownGuard(app, runtime))
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { installAcpIpcHandlers }
export type { AcpIpcSessionAdmission, AcpSessionMemoryPreferenceResolver }
