import type { SessionPlanContinuation } from '../../shared/session-persistence'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'

type SessionPlanContinuationSessions = Pick<
  SessionPersistenceCoordinator,
  'readSessionRuntimeContext' | 'patchSessionRuntimeContext'
>

const isRevisionConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'revision-conflict'

class SessionPlanContinuationOwner {
  constructor(private readonly sessions: SessionPlanContinuationSessions) {}

  async begin(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const continuation = plan?.continuation
    if (!plan || continuation?.commandId !== commandId || continuation.state !== 'queued') {
      return false
    }

    return this.patch(projectId, sessionId, context.revision, plan, {
      ...continuation,
      state: 'continuing'
    })
  }

  async rearmUndispatched(
    projectId: string,
    sessionId: string,
    commandId: string
  ): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const continuation = plan?.continuation
    if (!plan || continuation?.commandId !== commandId || continuation.state !== 'continuing') {
      return false
    }

    return this.patch(projectId, sessionId, context.revision, plan, {
      ...continuation,
      state: 'queued'
    })
  }

  async clear(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const continuation = plan?.continuation
    if (!plan || continuation?.commandId !== commandId || continuation.state !== 'continuing') {
      return false
    }

    return this.patch(projectId, sessionId, context.revision, plan, undefined)
  }

  async interrupt(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const continuation = plan?.continuation
    if (!plan || continuation?.commandId !== commandId || continuation.state !== 'continuing') {
      return false
    }

    return this.patch(projectId, sessionId, context.revision, plan, {
      ...continuation,
      state: 'interrupted'
    })
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
    try {
      await this.sessions.patchSessionRuntimeContext({
        projectId,
        sessionId,
        expectedRevision,
        patch: { plan: { ...plan, continuation } }
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
