import type { SessionPlanDelivery } from '../../shared/session-persistence'
import type { SessionRuntimeContextCommands } from '../session-persistence/coordinator'
import { matchPlanDelivery } from '../session-plan/plan-delivery'

type SessionPlanDeliverySessions = SessionRuntimeContextCommands

const isRevisionConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'revision-conflict'

class SessionPlanDeliveryOwner {
  constructor(private readonly sessions: SessionPlanDeliverySessions) {}

  async begin(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'queued', (delivery) => ({
      ...delivery,
      state: 'delivering'
    }))
  }

  async rearmUnaccepted(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'delivering', (delivery) => ({
      ...delivery,
      state: 'queued'
    }))
  }

  async accept(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    return this.transitionTo(projectId, sessionId, commandId, 'delivering', (delivery) => ({
      ...delivery,
      state: 'accepted'
    }))
  }

  async clear(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    if (await this.transitionTo(projectId, sessionId, commandId, 'accepted', () => undefined)) {
      return true
    }
    return this.transitionTo(projectId, sessionId, commandId, 'delivering', () => undefined)
  }

  async interrupt(projectId: string, sessionId: string, commandId: string): Promise<boolean> {
    if (
      await this.transitionTo(projectId, sessionId, commandId, 'accepted', (delivery) => ({
        ...delivery,
        state: 'interrupted'
      }))
    ) {
      return true
    }
    return this.transitionTo(projectId, sessionId, commandId, 'delivering', (delivery) => ({
      ...delivery,
      state: 'interrupted'
    }))
  }

  private async transitionTo(
    projectId: string,
    sessionId: string,
    commandId: string,
    expectedState: SessionPlanDelivery['state'],
    apply: (delivery: SessionPlanDelivery) => SessionPlanDelivery | undefined
  ): Promise<boolean> {
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const delivery = matchPlanDelivery(plan, { commandId, state: expectedState })
    if (!plan || !delivery) return false

    return this.patch(projectId, sessionId, context.revision, plan, apply(delivery))
  }

  private async patch(
    projectId: string,
    sessionId: string,
    expectedRevision: number,
    plan: NonNullable<
      Awaited<ReturnType<SessionPlanDeliverySessions['readSessionRuntimeContext']>>['plan']
    >,
    delivery: SessionPlanDelivery | undefined
  ): Promise<boolean> {
    const nextPlan = { ...plan }
    if (delivery) nextPlan.delivery = delivery
    else Reflect.deleteProperty(nextPlan, 'delivery')
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

export { SessionPlanDeliveryOwner }
export type { SessionPlanDeliverySessions }
