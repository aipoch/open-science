import type { ChatSession, SessionStatus } from './session-store-persistence-owner'

export type SessionInteractionState = Readonly<{
  permission: boolean
  elicitation: boolean
  plan: boolean
}>

const isWaitingStatus = (status: SessionStatus): boolean =>
  status === 'waiting-permission' ||
  status === 'waiting-for-user' ||
  status === 'waiting-plan-approval'

const hasPendingDurableElicitation = (session: ChatSession): boolean =>
  (session.status === 'waiting-for-user' || session.status === 'waiting-permission') &&
  session.activities?.some(
    (activity) =>
      activity.elicitation?.state === 'pending' &&
      activity.elicitation.durable?.kind === 'agent-user-choice'
  ) === true

export const inferSessionInteractionState = (session: ChatSession): SessionInteractionState =>
  session.interactionState && isWaitingStatus(session.status)
    ? session.interactionState
    : {
        permission:
          session.runtimeContext?.permission?.state === 'pending' ||
          session.status === 'waiting-permission',
        elicitation: session.status === 'waiting-for-user' || hasPendingDurableElicitation(session),
        plan:
          session.status === 'waiting-plan-approval' ||
          ((session.status === 'waiting-permission' || session.status === 'waiting-for-user') &&
            session.runtimeContext?.plan?.approval === 'pending')
      }

export const resolveSessionInteractionStatus = (
  session: ChatSession,
  interactionState: SessionInteractionState = inferSessionInteractionState(session)
): SessionStatus => {
  if (interactionState.permission) return 'waiting-permission'
  if (interactionState.elicitation) return 'waiting-for-user'
  if (interactionState.plan) return 'waiting-plan-approval'
  if (!isWaitingStatus(session.status)) return session.status
  return session.activeRun || session.agentPromptInFlight ? 'running' : 'idle'
}

export const projectSessionInteractionState = (
  session: ChatSession,
  patch: Partial<SessionInteractionState>
): ChatSession => {
  const current = inferSessionInteractionState(session)
  const interactionState = { ...current, ...patch }
  const status = resolveSessionInteractionStatus(session, interactionState)
  if (
    current.permission === interactionState.permission &&
    current.elicitation === interactionState.elicitation &&
    current.plan === interactionState.plan &&
    session.interactionState &&
    status === session.status
  ) {
    return session
  }
  return { ...session, interactionState, status, updatedAt: Date.now() }
}
