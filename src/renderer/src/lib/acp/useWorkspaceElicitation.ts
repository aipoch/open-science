import { useCallback } from 'react'

import type {
  AcpResumeSessionRequest,
  AcpSessionAgentTarget,
  AcpStateCommandResponse,
  AcpStateSnapshot,
  ElicitationResponse,
  PendingElicitationRequest
} from '../../../../shared/acp'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import { isSessionSizeLimitError } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import type { WorkspaceSessionRuntimeSelection } from './useWorkspaceAgentRuntime'
import {
  respondToWorkspaceElicitation,
  type WorkspaceElicitationRuntime
} from './workspace-elicitation-runtime'

const pendingWorkspaceElicitations = (
  session: ChatSession | undefined
): PendingElicitationRequest[] =>
  (session?.activities ?? []).flatMap((activity) => {
    const elicitation = activity.elicitation
    return elicitation?.state === 'pending' && elicitation.durable
      ? [
          {
            requestId: elicitation.durable.requestId,
            sessionId: session!.id,
            toolCallId: activity.id,
            message: elicitation.message,
            fields: elicitation.fields,
            durable: elicitation.durable
          }
        ]
      : []
  })

const createWorkspaceElicitationRuntime = async (): Promise<WorkspaceElicitationRuntime> => ({
  state: await window.api.acp.getState(),
  resumeSession: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectId?: string,
    permissionProfile?: PermissionProfileId,
    previousFrameworkId?: AcpResumeSessionRequest['previousFrameworkId'],
    previousBackendId?: AcpResumeSessionRequest['previousBackendId'],
    specialistId?: AcpResumeSessionRequest['specialistId'],
    providerSessionId?: AcpResumeSessionRequest['providerSessionId'],
    providerContinuityToken?: AcpResumeSessionRequest['providerContinuityToken'],
    specialistBindingPending?: AcpResumeSessionRequest['specialistBindingPending'],
    agentTarget?: AcpSessionAgentTarget,
    memoryEnabled = true
  ) =>
    window.api.acp.resumeSession({
      sessionId,
      cwd,
      projectId,
      permissionProfile,
      previousFrameworkId,
      previousBackendId,
      specialistId,
      providerSessionId,
      providerContinuityToken,
      specialistBindingPending,
      agentTarget,
      memoryEnabled
    }),
  resetSessionContext: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectId?: string,
    permissionProfile?: PermissionProfileId,
    memoryEnabled = true
  ) =>
    window.api.acp.resetSessionContext({
      sessionId,
      cwd,
      projectId,
      permissionProfile,
      memoryEnabled
    }),
  respondToElicitation: async (response) => {
    const commandResponse = (await window.api.acp.respondToElicitation(response)) as
      AcpStateCommandResponse | AcpStateSnapshot
    return 'result' in commandResponse ? commandResponse.result : commandResponse
  }
})

const useWorkspaceElicitation = (
  resolveSessionRuntimeSelection: (sessionId: string) => WorkspaceSessionRuntimeSelection,
  onSessionSizeLimit?: (sessionId: string) => void
): {
  respondToElicitation: (response: ElicitationResponse) => Promise<void>
} => {
  const respondToElicitation = useCallback(
    async (response: ElicitationResponse): Promise<void> => {
      const sessionId = response.request?.sessionId ?? response.delegatedQuestion?.sessionId
      const session = sessionId
        ? useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
        : undefined
      const selected = session ? resolveSessionRuntimeSelection(session.id) : undefined

      try {
        await respondToWorkspaceElicitation(await createWorkspaceElicitationRuntime(), response, {
          supportsImageInput: selected
            ? selected.supportsImageInput || selected.supportsImageRelay
            : undefined,
          agentFrameworkId: selected?.agentFrameworkId,
          agentBackendId: selected?.agentBackendId,
          agentModel: selected?.agentModel,
          agentTarget: selected?.agentTarget,
          historyReplayDescriptor: selected?.historyReplayDescriptor
        })
      } catch (error) {
        if (sessionId && isSessionSizeLimitError(error)) onSessionSizeLimit?.(sessionId)
        throw error
      }
    },
    [onSessionSizeLimit, resolveSessionRuntimeSelection]
  )

  return { respondToElicitation }
}

export { createWorkspaceElicitationRuntime, pendingWorkspaceElicitations, useWorkspaceElicitation }
