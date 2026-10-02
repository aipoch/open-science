import type {
  AcpCancelPromptRequest,
  AcpAgentRuntimeUpdate,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpContinueInterruptedTurnRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ElicitationResponse,
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateCommandResponse,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../acp'

import type {
  ActivePlanProjection,
  PlanResponseCommand,
  PlanResponseIdentity
} from '../session-plan/contract'

import {
  callable,
  WEB,
  DEFAULT_EMPTY,
  DEFAULT_EMPTY_ABSENT_ONLY,
  type AcpListener,
  type RemoveListener,
  EVENT,
  RUNTIME_VALIDATED
} from './definition'

export const contracts = {
  'acp.cancel': callable<(request: AcpCancelPromptRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:cancel']
  ),
  'acp.compactSession': callable<
    (request: AcpCompactSessionRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:compact-session']),
  'acp.connect': callable<(request?: AcpConnectRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:connect', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY]
  ),
  'acp.continueInterruptedTurn': callable<
    (request: AcpContinueInterruptedTurnRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:continue-interrupted-turn']),
  'acp.createSession': callable<
    (request?: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:create-session', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY]),
  'acp.deleteSession': callable<
    (request: AcpDeleteSessionRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:delete-session']),
  'acp.disconnect': callable<() => Promise<AcpStateCommandResponse>>()('acp', ['acp:disconnect']),
  'acp.getPlanProjection': callable<
    (projectId: string, sessionId: string) => Promise<ActivePlanProjection | null>
  >()('acp', ['acp:get-plan-projection']),
  'acp.getState': callable<() => Promise<AcpStateSnapshot>>()('acp', ['acp:get-state']),
  'acp.onAgentRuntimeUpdate': callable<
    (listener: AcpListener<AcpAgentRuntimeUpdate>) => RemoveListener
  >()('acp', ['acp:agent-runtime-update', EVENT]),
  'acp.onEvent': callable<(listener: AcpListener<readonly AcpRuntimeEvent[]>) => RemoveListener>()(
    'acp',
    ['acp:event', EVENT]
  ),
  'acp.onPermissionRequest': callable<
    (listener: AcpListener<AcpPermissionRequest>) => RemoveListener
  >()('acp', ['acp:permission-request', EVENT]),
  'acp.onState': callable<(listener: AcpListener<AcpStateUpdate>) => RemoveListener>()('acp', [
    'acp:state',
    EVENT
  ]),
  'acp.resetSessionContext': callable<
    (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:reset-session-context']),
  'acp.discardUnavailablePlan': callable<
    (request: PlanResponseIdentity) => Promise<{ revision: number }>
  >()('acp', ['acp:discard-unavailable-plan', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'acp.respondPlan': callable<(request: PlanResponseCommand) => Promise<unknown>>()('acp', [
    'acp:respond-plan',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'acp.respondToElicitation': callable<
    (response: ElicitationResponse) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:respond-elicitation', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'acp.respondToPermission': callable<
    (response: AcpPermissionResponse) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:respond-permission', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'acp.resumeSession': callable<
    (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:resume-session']),
  'acp.revokePermissionGrant': callable<
    (request: AcpRevokePermissionGrantRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:revoke-permission-grant']),
  'acp.saveAsSkill': callable<
    (request: AcpSaveAsSkillRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:save-as-skill']),
  'acp.sendPrompt': callable<(request: AcpPromptRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:send-prompt']
  ),
  'acp.setPermissionProfile': callable<
    (request: AcpSetPermissionProfileRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:set-permission-profile']),
  'acp.steerFollowUp': callable<
    (request: AcpSteerFollowUpRequest) => Promise<AcpSteerFollowUpResult>
  >()('acp', ['acp:steer-follow-up'])
} as const
