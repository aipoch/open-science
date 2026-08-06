import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { canSatisfyHumanApproval } from '../caller-context'
import type { AcpHandlerWorkflows } from './handler-workflows'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'

const acpCommands = Object.freeze({
  getState: defineApplicationCommand<'acp:get-state', readonly [], AcpStateSnapshot>(
    'acp:get-state'
  ),
  connect: defineApplicationCommand<
    'acp:connect',
    readonly [request: AcpConnectRequest],
    AcpStateSnapshot
  >('acp:connect'),
  disconnect: defineApplicationCommand<'acp:disconnect', readonly [], AcpStateSnapshot>(
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
  resetSessionContext: defineApplicationCommand<
    'acp:reset-session-context',
    readonly [request: AcpResumeSessionRequest],
    AcpCreateSessionResponse
  >('acp:reset-session-context'),
  compactSession: defineApplicationCommand<
    'acp:compact-session',
    readonly [request: AcpCompactSessionRequest],
    AcpStateSnapshot
  >('acp:compact-session'),
  sendPrompt: defineApplicationCommand<
    'acp:send-prompt',
    readonly [request: AcpPromptRequest],
    AcpStateSnapshot
  >('acp:send-prompt'),
  cancel: defineApplicationCommand<
    'acp:cancel',
    readonly [request: AcpCancelPromptRequest],
    AcpStateSnapshot
  >('acp:cancel'),
  deleteSession: defineApplicationCommand<
    'acp:delete-session',
    readonly [request: AcpDeleteSessionRequest],
    AcpStateSnapshot
  >('acp:delete-session'),
  respondPermission: defineApplicationCommand<
    'acp:respond-permission',
    readonly [response: AcpPermissionResponse],
    AcpStateSnapshot
  >('acp:respond-permission'),
  setPermissionProfile: defineApplicationCommand<
    'acp:set-permission-profile',
    readonly [request: AcpSetPermissionProfileRequest],
    AcpStateSnapshot
  >('acp:set-permission-profile'),
  revokePermissionGrant: defineApplicationCommand<
    'acp:revoke-permission-grant',
    readonly [request: AcpRevokePermissionGrantRequest],
    AcpStateSnapshot
  >('acp:revoke-permission-grant'),
  getPlanProjection: defineApplicationCommand<
    'acp:get-plan-projection',
    readonly [projectId: string, sessionId: string],
    ActivePlanProjection | null
  >('acp:get-plan-projection'),
  respondPlan: defineApplicationCommand<
    'acp:respond-plan',
    readonly [request: Parameters<AcpRuntimeCoordinator['respondSessionPlan']>[0]],
    unknown
  >('acp:respond-plan')
})

const acpApplicationCommands = defineApplicationCommandGroup('acp', [
  acpCommands.getState,
  acpCommands.connect,
  acpCommands.disconnect,
  acpCommands.createSession,
  acpCommands.resumeSession,
  acpCommands.resetSessionContext,
  acpCommands.compactSession,
  acpCommands.sendPrompt,
  acpCommands.cancel,
  acpCommands.deleteSession,
  acpCommands.respondPermission,
  acpCommands.setPermissionProfile,
  acpCommands.revokePermissionGrant,
  acpCommands.getPlanProjection,
  acpCommands.respondPlan
] as const)

type AcpApplicationCommandRuntime = Pick<
  AcpRuntimeCoordinator,
  | 'getSnapshot'
  | 'connect'
  | 'disconnect'
  | 'resetSessionContext'
  | 'compactSession'
  | 'cancelPrompt'
  | 'deleteSession'
  | 'respondToPermission'
  | 'setPermissionProfile'
  | 'revokePermissionGrant'
  | 'getSessionPlanProjection'
  | 'respondSessionPlan'
>

type AcpApplicationCommandDependencies = Readonly<{
  runtime: AcpApplicationCommandRuntime
  workflows: AcpHandlerWorkflows
}>

const registerAcpCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: AcpApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(acpApplicationCommands, {
      'acp:get-state': () => dependencies.runtime.getSnapshot(),
      'acp:connect': (invocation) => dependencies.runtime.connect(invocation.args[0]),
      'acp:disconnect': () => dependencies.runtime.disconnect(),
      'acp:create-session': (invocation) =>
        dependencies.workflows.createSession(invocation.args[0]),
      'acp:resume-session': (invocation) =>
        dependencies.workflows.resumeSession(invocation.args[0]),
      'acp:reset-session-context': (invocation) =>
        dependencies.runtime.resetSessionContext(invocation.args[0]),
      'acp:compact-session': (invocation) =>
        dependencies.runtime.compactSession(invocation.args[0]),
      'acp:send-prompt': (invocation) => {
        if (
          invocation.args[0].planContinuation &&
          !canSatisfyHumanApproval(invocation.callerContext)
        ) {
          throw new Error('Only a current human caller can continue a Session Plan.')
        }
        return dependencies.workflows.sendPrompt({
          ...invocation.args[0],
          turnIntent: invocation.args[0].turnIntent === 'plan-first' ? 'plan-first' : undefined,
          continuation: undefined,
          suppressUserMessage: undefined
        })
      },
      'acp:cancel': (invocation) => dependencies.runtime.cancelPrompt(invocation.args[0]),
      'acp:delete-session': (invocation) => dependencies.runtime.deleteSession(invocation.args[0]),
      'acp:respond-permission': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can respond to permission requests.')
        }
        return dependencies.runtime.respondToPermission(invocation.args[0])
      },
      'acp:set-permission-profile': (invocation) =>
        dependencies.runtime.setPermissionProfile(invocation.args[0]),
      'acp:revoke-permission-grant': (invocation) =>
        dependencies.runtime.revokePermissionGrant(invocation.args[0]),
      'acp:get-plan-projection': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can access a Session Plan.')
        }
        return dependencies.runtime.getSessionPlanProjection(invocation.args[0], invocation.args[1])
      },
      'acp:respond-plan': (invocation) => {
        if (!canSatisfyHumanApproval(invocation.callerContext)) {
          throw new Error('Only a current human caller can respond to a Session Plan.')
        }
        return dependencies.runtime.respondSessionPlan(invocation.args[0])
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
