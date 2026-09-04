import type { SessionPlanContinuation } from '../../shared/session-persistence'
import type { SessionRuntimeContextCommands } from '../session-persistence/coordinator'

type SessionPlanContinuationSessions = SessionRuntimeContextCommands

const isRevisionConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'revision-conflict'

class SessionPlanContinuationOwner {
  constructor(private readonly sessions: SessionPlanContinuationSessions) {}

  async begin(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'queued', (continuation) => ({
      ...continuation,
      state: 'continuing'
    }))
  }

  async rearmUndispatched(
    projectId: string,
    sessionId: string,
    commandId: string
  ): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'continuing', (continuation) => ({
      ...continuation,
      state: 'queued'
    }))
  }

  async clear(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'continuing', () => undefined)
  }

  async interrupt(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'continuing', (continuation) => ({
      ...continuation,
      state: 'interrupted'
    }))
  }

  private async transitionTo(
    projectId: string,
    sessionId: string,
    commandId: string,
    expectedState: SessionPlanContinuation['state'],
    apply: (continuation: SessionPlanContinuation) => SessionPlanContinuation | undefined
  ): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const continuation = plan?.continuation
    if (
      !plan ||
      !continuation ||
      continuation.commandId !== commandId ||
      continuation.state !== expectedState
    ) {
      return false
    }

    return this.patch(projectId, sessionId, context.revision, plan, apply(continuation))
  }

  private async patch(
    projectId: string,
    sessionId: string,
    expectedRevision: number,
    plan: NonNullable<
      Awaited<ReturnType<SessionPlanContinuationSessions['readSessionRuntimeContext']>>['plan']
    >,
    continuation: SessionPlanContinuation | undefined
  ): Promise<boolean> {
    const nextPlan = { ...plan }
    if (continuation) nextPlan.continuation = continuation
    else Reflect.deleteProperty(nextPlan, 'continuation')
    try {
      await this.sessions.patchSessionRuntimeContext({
        projectId,
        sessionId,
        expectedRevision,
        patch: { plan: nextPlan }
      })
      return true
    } catch (error) {
      if (isRevisionConflict(error)) return false
      throw error
    }
  }
}

export { SessionPlanContinuationOwner }
export type { SessionPlanContinuationSessions }
