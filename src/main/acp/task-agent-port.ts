import { taskRunTracing, requireTracingFramework } from './task-run-tracing'
import type {
  AcpCreateSessionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import type { TaskNotificationService } from '../notifications/task-notifications'
import type { TaskAgentPort, TaskAgentPromptRequest } from '../tasks/task-runner'
import { notebookExecutionIntent, withNotebookUserOperation } from '../notebook/execution-intent'
import { markTaskNotebookRuntime } from '../notebook/runtime-binding-admission'
import { withTaskPromptOwner } from '../../shared/task-continuation'
import type { AcpCreateSessionWorkflow } from './create-session-workflow'
import {
  toSessionAgentConfiguration,
  type DefaultSessionAgentTargetResolver,
  type SessionAgentTargetResolver
} from './session-agent-target'

type AcpTaskAgentRuntime = {
  listTaskQuestions?: NonNullable<TaskAgentPort['questions']>['list']
  respondToTaskQuestion?: NonNullable<TaskAgentPort['questions']>['respond']
  setContinuationTracker?: TaskAgentPort['setContinuationTracker']
  captureNotebookTaskIntent?(request: AcpPromptRequest): AcpPromptRequest
  assertAttachedTracingReady?(sessionId: string): Promise<void>
  getSnapshot(): { sessionIds: string[] }
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<unknown>
  setMemoryEnabled(sessionId: string, enabled: boolean): void
  sendPrompt(request: AcpPromptRequest): Promise<unknown>
  sendPromptObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>,
    runtimeReviewOwner?: 'task' | 'renderer'
  ): Promise<unknown>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
  respondSessionPlan?: NonNullable<TaskAgentPort['respondDelegatedPlan']>
  getTaskPermissions?: TaskAgentPort['getTaskPermissions']
  respondTaskPermission?: TaskAgentPort['respondTaskPermission']
  restoreTaskPermission?: TaskAgentPort['restoreTaskPermission']
  delegateInteractions?: TaskAgentPort['delegateInteractions']
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
  ...(request.otelTraces ? { [taskRunTracing]: true } : {}),
  text: request.text,
  ...(request.permissionPrompts ? { permissionPrompts: request.permissionPrompts } : {}),
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
  ...(runtime.listTaskQuestions && runtime.respondToTaskQuestion
    ? {
        questions: {
          list: runtime.listTaskQuestions.bind(runtime),
          respond: runtime.respondToTaskQuestion.bind(runtime)
        }
      }
    : {}),
  ...(runtime.setContinuationTracker
    ? { setContinuationTracker: (tracker) => runtime.setContinuationTracker!(tracker) }
    : {}),
  withSessionAvailable: (projectId, sessionId, operation) =>
    archiveAvailability
      ? archiveAvailability.withSessionAvailable(projectId, sessionId, operation)
      : operation(),
  assertAttachedTracingReady: runtime.assertAttachedTracingReady?.bind(runtime),
  listAttachedSessionIds: async () => [...runtime.getSnapshot().sessionIds],
  createSession: async (request) => {
    const agentTarget = request.agentConfiguration
      ? await resolveSessionAgentTarget?.({ agentConfiguration: request.agentConfiguration })
      : await resolveDefaultSessionAgentTarget?.()
    if (request.otelTraces && agentTarget) requireTracingFramework(agentTarget.frameworkId)
    const response = await createSessionWorkflow.create({
      ...(request.otelTraces ? { [taskRunTracing]: true } : {}),
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
      ...(request.otelTraces ? { [taskRunTracing]: true } : {}),
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
    const prompt = markTaskNotebookRuntime(
      withTaskPromptOwner(toAcpPromptRequest(request), request.taskRunId),
      request.notebookRuntime
    )
    // TaskRunner owns this boundary after reserving the Session and accepting its exact root
    // prompt. Freeze authority before notifications, admission or Provider preparation can yield.
    const acpRequest = request.notebookContinuation
      ? withNotebookUserOperation(prompt, request.notebookContinuation)
      : (runtime.captureNotebookTaskIntent?.(prompt) ?? prompt)
    let tracked: ReturnType<TaskPromptNotifications['trackPrompt']> | undefined
    try {
      tracked = notifications?.trackPrompt(acpRequest)
      if (request.otelTraces || observer?.onProviderPromptAccepted || observer?.onPromptAdmitted) {
        await runtime.sendPromptObserved(
          acpRequest,
          observer?.onProviderPromptAccepted ?? (() => undefined),
          observer?.onPromptAdmitted,
          'task'
        )
      } else {
        await runtime.sendPrompt(acpRequest)
      }
    } catch (error) {
      notebookExecutionIntent(acpRequest)?.abandonUserExecution()
      if (tracked) notifications?.untrackPrompt(acpRequest.sessionId, tracked)
      throw error
    }
  },
  cancelPrompt: (sessionId) => runtime.cancelPrompt({ sessionId }).then(() => undefined),
  ...(runtime.delegateInteractions ? { delegateInteractions: runtime.delegateInteractions } : {}),
  ...(runtime.respondSessionPlan
    ? { respondDelegatedPlan: runtime.respondSessionPlan.bind(runtime) }
    : {}),
  ...(runtime.getTaskPermissions
    ? { getTaskPermissions: runtime.getTaskPermissions.bind(runtime) }
    : {}),
  ...(runtime.respondTaskPermission
    ? { respondTaskPermission: runtime.respondTaskPermission.bind(runtime) }
    : {}),
  ...(runtime.restoreTaskPermission
    ? { restoreTaskPermission: runtime.restoreTaskPermission.bind(runtime) }
    : {})
})

export { createAcpTaskAgentPort }
