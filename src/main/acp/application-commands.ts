import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpContinueInterruptedTurnRequest,
  AcpDeleteSessionRequest,
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
} from '../../shared/acp'
import { toAcpStateCommandResponse } from '../../shared/acp'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { canAccessSessionPlan, canSatisfyHumanApproval } from '../caller-context'
import type { AcpHandlerWorkflows } from './handler-workflows'
import {
  resolveElicitationResponseSessionId,
  resolvePermissionResponseSessionId
} from './response-session-admission'
import { bindResumeRequestToProject } from './session-project-binding'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'

const acpCommands = Object.freeze({
  getState: defineApplicationCommand<'acp:get-state', readonly [], AcpStateSnapshot>(
    'acp:get-state'
  ),
  connect: defineApplicationCommand<
    'acp:connect',
    readonly [request: AcpConnectRequest],
    AcpStateCommandResponse
  >('acp:connect'),
  disconnect: defineApplicationCommand<'acp:disconnect', readonly [], AcpStateCommandResponse>(
    'acp:disconnect'
  ),
  createSession: defineApplicationCommand<
    'acp:create-session',
    readonly [request: AcpCreateSessionRequest],
    AcpCreateSessionResponse
  >('acp:create-session'),
  resumeSession: defineApplicationCommand<
    'acp:resume-session',
    readonly [request: AcpResumeSessionRequest],
    AcpCreateSessionResponse
  >('acp:resume-session'),
  continueInterruptedTurn: defineApplicationCommand<
    'acp:continue-interrupted-turn',
    readonly [request: AcpContinueInterruptedTurnRequest],
    AcpStateCommandResponse
  >('acp:continue-interrupted-turn'),
  resetSessionContext: defineApplicationCommand<
    'acp:reset-session-context',
    readonly [request: AcpResumeSessionRequest],
    AcpCreateSessionResponse
  >('acp:reset-session-context'),
  compactSession: defineApplicationCommand<
    'acp:compact-session',
    readonly [request: AcpCompactSessionRequest],
    AcpStateCommandResponse
  >('acp:compact-session'),
  sendPrompt: defineApplicationCommand<
    'acp:send-prompt',
    readonly [request: AcpPromptRequest],
    AcpStateCommandResponse
  >('acp:send-prompt'),
  steerFollowUp: defineApplicationCommand<
    'acp:steer-follow-up',
    readonly [request: AcpSteerFollowUpRequest],
    AcpSteerFollowUpResult
  >('acp:steer-follow-up'),
  saveAsSkill: defineApplicationCommand<
    'acp:save-as-skill',
    readonly [request: AcpSaveAsSkillRequest],
    AcpStateCommandResponse
  >('acp:save-as-skill'),
  cancel: defineApplicationCommand<
    'acp:cancel',
    readonly [request: AcpCancelPromptRequest],
    AcpStateCommandResponse
  >('acp:cancel'),
  deleteSession: defineApplicationCommand<
    'acp:delete-session',
    readonly [request: AcpDeleteSessionRequest],
    AcpStateCommandResponse
  >('acp:delete-session'),
  respondPermission: defineApplicationCommand<
    'acp:respond-permission',
    readonly [response: AcpPermissionResponse],
    AcpStateCommandResponse
  >('acp:respond-permission'),
  respondElicitation: defineApplicationCommand<
    'acp:respond-elicitation',
    readonly [response: ElicitationResponse],
    AcpStateCommandResponse
  >('acp:respond-elicitation'),
  setPermissionProfile: defineApplicationCommand<
    'acp:set-permission-profile',
    readonly [request: AcpSetPermissionProfileRequest],
    AcpStateCommandResponse
  >('acp:set-permission-profile'),
  revokePermissionGrant: defineApplicationCommand<
    'acp:revoke-permission-grant',
    readonly [request: AcpRevokePermissionGrantRequest],
    AcpStateCommandResponse
  >('acp:revoke-permission-grant'),
  getPlanProjection: defineApplicationCommand<
    'acp:get-plan-projection',
    readonly [projectId: string, sessionId: string],
    ActivePlanProjection | null
  >('acp:get-plan-projection'),
  respondPlan: defineApplicationCommand<
    'acp:respond-plan',
    readonly [request: Parameters<AcpRuntimeCoordinator['respondSessionPlan']>[0]],
    Awaited<ReturnType<AcpRuntimeCoordinator['respondSessionPlan']>>
  >('acp:respond-plan')
})

const acpApplicationCommands = defineApplicationCommandGroup('acp', [
  acpCommands.getState,
  acpCommands.connect,
  acpCommands.disconnect,
  acpCommands.createSession,
  acpCommands.resumeSession,
  acpCommands.continueInterruptedTurn,
  acpCommands.resetSessionContext,
  acpCommands.compactSession,
  acpCommands.sendPrompt,
  acpCommands.steerFollowUp,
  acpCommands.saveAsSkill,
  acpCommands.cancel,
  acpCommands.deleteSession,
  acpCommands.respondPermission,
  acpCommands.respondElicitation,
  acpCommands.setPermissionProfile,
  acpCommands.revokePermissionGrant,
  acpCommands.getPlanProjection,
  acpCommands.respondPlan
] as const)

type AcpApplicationCommandRuntime = Pick<
  AcpRuntimeCoordinator,
  | 'getSnapshot'
  | 'getState'
  | 'connect'
  | 'disconnect'
  | 'resetSessionContext'
  | 'compactSession'
  | 'cancelPrompt'
  | 'steerFollowUp'
  | 'deleteSession'
  | 'respondToPermission'
  | 'respondToElicitation'
  | 'setPermissionProfile'
  | 'revokePermissionGrant'
  | 'getSessionPlanProjection'
  | 'respondSessionPlan'
>

type AcpApplicationCommandDependencies = Readonly<{
  runtime: AcpApplicationCommandRuntime
  workflows: AcpHandlerWorkflows
  archiveAvailability?: Readonly<{
    withSessionAvailable<Result>(
      projectId: string,
      sessionId: string,
      operation: () => Promise<Result>
    ): Promise<Result>
    withSessionAvailableById<Result>(
      sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result>
  }>
  respondDelegatedQuestion?: (
    input: NonNullable<ElicitationResponse['delegatedQuestion']> & Readonly<{ requestId: string }>
  ) => Promise<void>
}>

const withResponseAdmission = <Result>(
  archiveAvailability: AcpApplicationCommandDependencies['archiveAvailability'],
  sessionId: string | undefined,
  operation: () => Promise<Result>
): Promise<Result> =>
  archiveAvailability && sessionId
    ? archiveAvailability.withSessionAvailableById(sessionId, operation)
    : operation()

const stateCommand = async (operation: Promise<AcpStateUpdate>): Promise<AcpStateCommandResponse> =>
  toAcpStateCommandResponse(await operation)

const registerAcpCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: AcpApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(acpApplicationCommands, {
      'acp:get-state': () => dependencies.runtime.getSnapshot(),
      'acp:connect': (invocation) => stateCommand(dependencies.runtime.connect(invocation.args[0])),
      'acp:disconnect': () => stateCommand(dependencies.runtime.disconnect()),
      'acp:create-session': (invocation) =>
        dependencies.workflows.createSession(invocation.args[0]),
      'acp:resume-session': (invocation) =>
        dependencies.workflows.resumeSession(invocation.args[0]),
      'acp:continue-interrupted-turn': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can continue an interrupted turn.')
        }
        return stateCommand(dependencies.workflows.continueInterruptedTurn(invocation.args[0]))
      },
      'acp:reset-session-context': (invocation) =>
        dependencies.archiveAvailability
          ? dependencies.archiveAvailability.withSessionAvailableById(
              invocation.args[0].sessionId,
              (projectId) =>
                dependencies.runtime.resetSessionContext(
                  bindResumeRequestToProject(invocation.args[0], projectId)
                )
            )
          : dependencies.runtime.resetSessionContext(invocation.args[0]),
      'acp:compact-session': (invocation) =>
        stateCommand(
          dependencies.archiveAvailability
            ? dependencies.archiveAvailability.withSessionAvailableById(
                invocation.args[0].sessionId,
                () => dependencies.runtime.compactSession(invocation.args[0])
              )
            : dependencies.runtime.compactSession(invocation.args[0])
        ),
      'acp:send-prompt': (invocation) => {
        return stateCommand(
          dependencies.workflows.sendPrompt({
            ...invocation.args[0],
            turnIntent: invocation.args[0].turnIntent === 'plan-first' ? 'plan-first' : undefined,
            continuation: undefined,
            suppressUserMessage: undefined
          })
        )
      },
      'acp:steer-follow-up': (invocation) => dependencies.runtime.steerFollowUp(invocation.args[0]),
      'acp:save-as-skill': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can save a Session as a Skill.')
        }
        return stateCommand(dependencies.workflows.saveAsSkill(invocation.args[0]))
      },
      'acp:cancel': (invocation) =>
        stateCommand(dependencies.runtime.cancelPrompt(invocation.args[0])),
      'acp:delete-session': (invocation) =>
        stateCommand(dependencies.runtime.deleteSession(invocation.args[0])),
      'acp:respond-permission': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can respond to permission requests.')
        }
        const response = invocation.args[0]
        const sessionId = dependencies.archiveAvailability
          ? resolvePermissionResponseSessionId(dependencies.runtime.getSnapshot(), response)
          : undefined
        return stateCommand(
          withResponseAdmission(dependencies.archiveAvailability, sessionId, () =>
            dependencies.runtime.respondToPermission(response)
          )
        )
      },
      'acp:respond-elicitation': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can respond to structured questions.')
        }
        const response = invocation.args[0]
        const sessionId = dependencies.archiveAvailability
          ? resolveElicitationResponseSessionId(dependencies.runtime.getSnapshot(), response)
          : undefined
        return stateCommand(
          withResponseAdmission(dependencies.archiveAvailability, sessionId, () => {
            if (response.delegatedQuestion) {
              if (!dependencies.respondDelegatedQuestion) {
                throw new Error('Delegated question response owner is unavailable.')
              }
              return dependencies
                .respondDelegatedQuestion({
                  ...response.delegatedQuestion,
                  requestId: response.requestId
                })
                .then(() => dependencies.runtime.getState())
            }
            return dependencies.runtime.respondToElicitation(response)
          })
        )
      },
      'acp:set-permission-profile': (invocation) =>
        stateCommand(
          withResponseAdmission(
            dependencies.archiveAvailability,
            invocation.args[0].sessionId,
            () => dependencies.runtime.setPermissionProfile(invocation.args[0])
          )
        ),
      'acp:revoke-permission-grant': (invocation) =>
        stateCommand(
          withResponseAdmission(
            dependencies.archiveAvailability,
            invocation.args[0].sessionId,
            () => dependencies.runtime.revokePermissionGrant(invocation.args[0])
          )
        ),
      'acp:get-plan-projection': (invocation) => {
        if (!canAccessSessionPlan(invocation.callerContext)) {
          throw new Error(
            'Only a current human or Task automation caller can access a Session Plan.'
          )
        }
        return dependencies.runtime.getSessionPlanProjection(invocation.args[0], invocation.args[1])
      },
      'acp:respond-plan': (invocation) => {
        if (!canAccessSessionPlan(invocation.callerContext)) {
          throw new Error(
            'Only a current human or Task automation caller can respond to a Session Plan.'
          )
        }
        return dependencies.archiveAvailability
          ? dependencies.archiveAvailability.withSessionAvailable(
              invocation.args[0].projectId,
              invocation.args[0].sessionId,
              () => dependencies.runtime.respondSessionPlan(invocation.args[0])
            )
          : dependencies.runtime.respondSessionPlan(invocation.args[0])
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { acpApplicationCommands, acpCommands, registerAcpCommands }
export type { AcpApplicationCommandDependencies, AcpApplicationCommandRuntime }
