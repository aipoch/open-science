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
  AcpSteerFollowUpRequest,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpHandlerWorkflows } from './handler-workflows'
import {
  resolveElicitationResponseSessionId,
  resolvePermissionResponseSessionId
} from './response-session-admission'
import { installAgentShutdownGuard } from './shutdown-guard'

type AcpIpcSessionAdmission = {
  withSessionAvailableById<Result>(
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
}

type AcpSessionMemoryPreferenceResolver = (request: {
  sessionId: string
  projectId?: string
}) => Promise<boolean | undefined>

const withDurableMemoryPreference = async (
  request: AcpResumeSessionRequest,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): Promise<AcpResumeSessionRequest> => {
  if (!resolveMemoryEnabled) return request
  const memoryEnabled = await resolveMemoryEnabled({
    sessionId: request.sessionId,
    ...(request.projectId ? { projectId: request.projectId } : {})
  })
  return memoryEnabled === undefined ? request : { ...request, memoryEnabled }
}

const withResponseAdmission = <Result>(
  sessionAdmission: AcpIpcSessionAdmission,
  sessionId: string | undefined,
  operation: () => Promise<Result>
): Promise<Result> =>
  sessionId ? sessionAdmission.withSessionAvailableById(sessionId, operation) : operation()

const registerAcpIpcHandlerSet = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows,
  sessionAdmission: AcpIpcSessionAdmission,
  respondDelegatedQuestion?: (
    input: NonNullable<ElicitationResponse['delegatedQuestion']> & { requestId: string }
  ) => Promise<void>,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): void => {
  ipcMainHandle('acp:get-state', () => runtime.getSnapshot())
  ipcMainHandle('acp:connect', (_event, request: AcpConnectRequest) => runtime.connect(request))
  ipcMainHandle('acp:disconnect', () => runtime.disconnect())
  ipcMainHandle('acp:create-session', (_event, request: AcpCreateSessionRequest) =>
    workflows.createSession(request)
  )
  ipcMainHandle('acp:resume-session', async (_event, request: AcpResumeSessionRequest) =>
    workflows.resumeSession(await withDurableMemoryPreference(request, resolveMemoryEnabled))
  )
  ipcMainHandle(
    'acp:continue-interrupted-turn',
    (_event, request: AcpContinueInterruptedTurnRequest) =>
      workflows.continueInterruptedTurn(request)
  )
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    sessionAdmission.withSessionAvailableById(request.sessionId, async () =>
      runtime.resetSessionContext(await withDurableMemoryPreference(request, resolveMemoryEnabled))
    )
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    sessionAdmission.withSessionAvailableById(request.sessionId, () =>
      runtime.compactSession(request)
    )
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', (_event, request: AcpPromptRequest) => {
    // Continuation controls are main-process-owned. Renderer input must never suppress a visible
    // user message or impersonate the handoff path.
    const { attribution: _untrustedAttribution, ...untrustedRequest } =
      request as AcpPromptRequest & {
        attribution?: unknown
      }
    void _untrustedAttribution
    const rendererRequest: AcpPromptRequest = {
      ...untrustedRequest,
      memoryEnabled: request.memoryEnabled !== false,
      turnIntent: request.turnIntent === 'plan-first' ? 'plan-first' : undefined,
      continuation: undefined,
      suppressUserMessage: undefined
    }
    return workflows.sendPrompt(rendererRequest)
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
    workflows.saveAsSkill(request)
  )
  ipcMainHandle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    runtime.cancelPrompt(request)
  )
  ipcMainHandle('acp:delete-session', async (_event, request: AcpDeleteSessionRequest) => {
    // The coordinator owns session disappearance notifications for delete, connection loss, and
    // retirement. Keeping that signal in one layer prevents a successful delete from firing twice.
    return runtime.deleteSession(request)
  })
  ipcMainHandle('acp:respond-permission', (_event, response: AcpPermissionResponse) =>
    withResponseAdmission(
      sessionAdmission,
      resolvePermissionResponseSessionId(runtime.getSnapshot(), response),
      () => runtime.respondToPermission(response)
    )
  )
  ipcMainHandle('acp:get-plan-projection', (_event, projectId: string, sessionId: string) =>
    runtime.getSessionPlanProjection(projectId, sessionId)
  )
  ipcMainHandle(
    'acp:respond-plan',
    (_event, request: Parameters<AcpRuntimeCoordinator['respondSessionPlan']>[0]) =>
      sessionAdmission.withSessionAvailableById(request.sessionId, () =>
        runtime.respondSessionPlan(request)
      )
  )
  ipcMainHandle('acp:respond-elicitation', (_event, response: ElicitationResponse) => {
    return withResponseAdmission(
      sessionAdmission,
      resolveElicitationResponseSessionId(runtime.getSnapshot(), response),
      () => {
        if (response.delegatedQuestion) {
          if (!respondDelegatedQuestion) {
            throw new Error('Delegated question response owner is unavailable.')
          }
          return respondDelegatedQuestion({
            ...response.delegatedQuestion,
            requestId: response.requestId
          }).then(() => runtime.getSnapshot())
        }
        return runtime.respondToElicitation(response)
      }
    )
  })
  ipcMainHandle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    sessionAdmission.withSessionAvailableById(request.sessionId, () =>
      runtime.setPermissionProfile(request)
    )
  )
  ipcMainHandle('acp:revoke-permission-grant', (_event, request: AcpRevokePermissionGrantRequest) =>
    sessionAdmission.withSessionAvailableById(request.sessionId, () =>
      runtime.revokePermissionGrant(request)
    )
  )
}

// Installs the renderer-callable Electron adapter over an already-constructed ACP coordinator.
const installAcpIpcHandlers = (
  runtime: AcpRuntimeCoordinator,
  workflows: AcpHandlerWorkflows,
  respondDelegatedQuestion:
    | ((
        input: NonNullable<ElicitationResponse['delegatedQuestion']> & { requestId: string }
      ) => Promise<void>)
    | undefined,
  sessionAdmission: AcpIpcSessionAdmission,
  resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerAcpIpcHandlerSet(
      runtime,
      workflows,
      sessionAdmission,
      respondDelegatedQuestion,
      resolveMemoryEnabled
    )
    // Kill the agent child on quit so it never outlives the app as an orphaned process.
    return scope.complete(installAgentShutdownGuard(app, runtime))
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { installAcpIpcHandlers }
export type { AcpIpcSessionAdmission, AcpSessionMemoryPreferenceResolver }
