import { useCallback } from 'react'

import type {
  AcpResumeSessionRequest,
  ElicitationResponse,
  PendingElicitationRequest
} from '../../../../shared/acp'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import { resolveSessionHistoryReplayDescriptor } from './history-preamble'
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
    projectName?: string,
    permissionProfile?: PermissionProfileId,
    previousFrameworkId?: AcpResumeSessionRequest['previousFrameworkId'],
    previousBackendId?: AcpResumeSessionRequest['previousBackendId'],
    specialistId?: AcpResumeSessionRequest['specialistId'],
    providerSessionId?: AcpResumeSessionRequest['providerSessionId'],
    providerContinuityToken?: AcpResumeSessionRequest['providerContinuityToken']
  ) =>
    window.api.acp.resumeSession({
      sessionId,
      cwd,
      projectName,
      permissionProfile,
      previousFrameworkId,
      previousBackendId,
      specialistId,
      providerSessionId,
      providerContinuityToken
    }),
  resetSessionContext: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectName?: string,
    permissionProfile?: PermissionProfileId
  ) => window.api.acp.resetSessionContext({ sessionId, cwd, projectName, permissionProfile }),
  respondToElicitation: (response) => window.api.acp.respondToElicitation(response)
})

const useWorkspaceElicitation = (): {
  respondToElicitation: (response: ElicitationResponse) => Promise<void>
} => {
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)

  const respondToElicitation = useCallback(
    async (response: ElicitationResponse): Promise<void> => {
      const sessionId = response.request?.sessionId
      const session = sessionId
        ? useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
        : undefined
      const provider = session
        ? providers.find(
            (candidate) => session.agentBackendId === `${session.agentFrameworkId}:${candidate.id}`
          )
        : undefined

      await respondToWorkspaceElicitation(await createWorkspaceElicitationRuntime(), response, {
        supportsImageInput: provider?.supportsImageInput,
        historyReplayDescriptor: session
          ? resolveSessionHistoryReplayDescriptor(session, providers, agentFrameworks)
          : undefined
      })
    },
    [agentFrameworks, providers]
  )

  return { respondToElicitation }
}

export { pendingWorkspaceElicitations, useWorkspaceElicitation }
