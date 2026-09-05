import type {
  AcpCreateSessionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import type { TaskNotificationService } from '../notifications/task-notifications'
import type { TaskAgentPort, TaskAgentPromptRequest } from '../tasks/task-runner'
import type { AcpCreateSessionWorkflow } from './create-session-workflow'
import {
  toSessionAgentConfiguration,
  type DefaultSessionAgentTargetResolver,
  type SessionAgentTargetResolver
} from './session-agent-target'

type AcpTaskAgentRuntime = {
  getSnapshot(): { sessionIds: string[] }
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<unknown>
  setMemoryEnabled(sessionId: string, enabled: boolean): void
  sendPrompt(request: AcpPromptRequest): Promise<unknown>
  sendPromptObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<unknown>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
}

type TaskPromptNotifications = Pick<TaskNotificationService, 'trackPrompt' | 'untrackPrompt'>

type SessionArchiveAvailability = {
  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
}

const toAcpPromptRequest = (request: TaskAgentPromptRequest): AcpPromptRequest => ({
  sessionId: request.sessionId,
  text: request.text,
  provenanceContext: request.provenanceContext,
  ...(request.turnIntent ? { turnIntent: request.turnIntent } : {}),
  ...(request.skillIds?.length ? { forcedSkillIds: request.skillIds } : {}),
  ...(request.historyPreamble ? { historyPreamble: request.historyPreamble } : {}),
  ...(request.contextReset ? { contextReset: true } : {}),
  ...(request.resumeFallback ? { resumeFallback: request.resumeFallback } : {})
})

// Adapts the provider-neutral Task seam to the existing ACP owner without exposing the coordinator,
// renderer commands, Specialist controls, or Compute management to Task automation.
const createAcpTaskAgentPort = (
  runtime: AcpTaskAgentRuntime,
  createSessionWorkflow: AcpCreateSessionWorkflow,
  notifications?: TaskPromptNotifications,
  archiveAvailability?: SessionArchiveAvailability,
  resolveSessionAgentTarget?: SessionAgentTargetResolver,
  resolveDefaultSessionAgentTarget?: DefaultSessionAgentTargetResolver
): TaskAgentPort => ({
  withSessionAvailable: (projectId, sessionId, operation) =>
    archiveAvailability
      ? archiveAvailability.withSessionAvailable(projectId, sessionId, operation)
      : operation(),
  listAttachedSessionIds: async () => [...runtime.getSnapshot().sessionIds],
  createSession: async (request) => {
    const agentTarget = request.agentConfiguration
      ? await resolveSessionAgentTarget?.({ agentConfiguration: request.agentConfiguration })
      : await resolveDefaultSessionAgentTarget?.()
    const response = await createSessionWorkflow.create({
      projectId: request.projectId,
      permissionProfile: request.permissionProfile,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.specialistId ? { specialistId: request.specialistId } : {}),
      ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
      ...(agentTarget ? { agentTarget } : {})
    })
    return {
      ...response,
      ...(agentTarget ? { agentConfiguration: toSessionAgentConfiguration(agentTarget) } : {})
    }
  },
  resumeSession: async (request) => {
    const agentTarget = await resolveSessionAgentTarget?.({
      agentBackendId: request.previousBackendId,
      agentModel: request.previousModel,
      agentConfiguration: request.agentConfiguration
    })
    const response = await runtime.resumeSession({
      sessionId: request.sessionId,
      cwd: request.cwd,
      projectId: request.projectId,
      permissionProfile: request.permissionProfile,
      memoryEnabled: request.memoryEnabled !== false,
      previousFrameworkId: request.previousFrameworkId,
      previousBackendId: request.previousBackendId,
      providerSessionId: request.providerSessionId,
      providerContinuityToken: request.providerContinuityToken,
      ...(request.specialistId ? { specialistId: request.specialistId } : {}),
      ...(request.specialistBindingPending === true ? { specialistBindingPending: true } : {}),
      ...(agentTarget ? { agentTarget } : {})
    })
    return {
      ...response,
      ...(agentTarget ? { agentConfiguration: toSessionAgentConfiguration(agentTarget) } : {})
    }
  },
  setPermissionProfile: (sessionId, profile) =>
    runtime.setPermissionProfile({ sessionId, profile }).then(() => undefined),
  setMemoryEnabled: async (sessionId, enabled) => runtime.setMemoryEnabled(sessionId, enabled),
  prompt: async (request, observer) => {
    const acpRequest = toAcpPromptRequest(request)
    const tracked = notifications?.trackPrompt(acpRequest)
    try {
      if (observer?.onProviderPromptAccepted || observer?.onPromptAdmitted) {
        await runtime.sendPromptObserved(
          acpRequest,
          observer.onProviderPromptAccepted ?? (() => undefined),
          observer.onPromptAdmitted
        )
      } else {
        await runtime.sendPrompt(acpRequest)
      }
    } catch (error) {
      if (tracked) notifications?.untrackPrompt(acpRequest.sessionId, tracked)
      throw error
    }
  },
  cancelPrompt: (sessionId) => runtime.cancelPrompt({ sessionId }).then(() => undefined)
})

export { createAcpTaskAgentPort }
