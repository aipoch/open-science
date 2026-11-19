import {
  AcpPermissionContinuationWorkflow,
  type PermissionContinuationDependencies
} from './permission-continuation-workflow'
import { AcpQuestionContinuationWorkflow } from './question-continuation-workflow'
import type { AcpRuntimeOptions } from './runtime-contract'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'

// Assemble recovery workflows once; the host retains prompt dispatch and scheduling.
export function composeAcpRuntimeContinuations(
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  host: {
    schedule: (sessionId: string) => void
    sendPermission: PermissionContinuationDependencies['send']
  }
): Readonly<{
  permissions: AcpPermissionContinuationWorkflow
  questions: AcpQuestionContinuationWorkflow
}> {
  const common = {
    hasActiveSession: (sessionId: string) =>
      Boolean(session.sessionRegistry.lookup(sessionId)?.attachment?.session),
    projectId: (sessionId: string) => session.sessionEnvironment.projectId(sessionId),
    context: session.durableContinuationContext,
    continuations: session.appContinuations,
    publication: session.publication,
    interactions: base.sessionInteractions,
    schedule: host.schedule
  }
  return Object.freeze({
    permissions: new AcpPermissionContinuationWorkflow({
      ...common,
      wait: session.permissionWaitOwner,
      permission: session.permissionContext,
      onPermissionSettled: options.callbacks?.onPermissionSettled,
      send: host.sendPermission
    }),
    questions: new AcpQuestionContinuationWorkflow({
      ...common,
      elicitation: session.elicitationOwner,
      runtimeSessions: options.runtimeSessions,
      persistedProjectId: options.permissionWait?.sessions.sessionProjectId?.bind(
        options.permissionWait.sessions
      ),
      permissionPrompts: (sessionId) => {
        const current = base.sessionInteractions.current(sessionId)
        return current?.kind === 'prompt' ? current.permissionPrompts : undefined
      },
      copyReferencedSessions: (sessionId) =>
        base.handoffContinuity.copyReferencedSessions(sessionId)
    })
  })
}
