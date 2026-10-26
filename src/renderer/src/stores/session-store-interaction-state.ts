import { hasPendingSandboxNetworkApproval } from '../../../shared/sandbox-network-approval'
import type { ChatSession } from './session-store-contract'
import type { SessionInteractionState } from './session-interaction-contract'
import {
  inferSessionInteractionState,
  resolveSessionInteractionStatus,
  hasPendingDurableElicitation
} from './session-actionability'
export {
  resolveRootPermissionPending,
  isSessionWaitReason,
  sessionAwaitsHistoryReplay,
  inferSessionInteractionState,
  resolveSessionInteractionStatus,
  projectSessionActionability
} from './session-actionability'
export type {
  SessionInteractionState,
  SessionWaitReason,
  SessionBlockingInteraction,
  SessionActionDisabledReason,
  SessionActionAvailability,
  SessionActionabilityFacts,
  SessionActionabilityProjection
} from './session-actionability'

export const projectSessionInteractionState = (
  session: ChatSession,
  patch: Partial<SessionInteractionState>
): ChatSession => {
  const current = inferSessionInteractionState(session)
  const interactionState = { ...current, ...patch }
  const status = resolveSessionInteractionStatus(
    session,
    interactionState,
    session.liveInteractionState?.presentationOnly !== true
  )
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

export const projectLiveSessionInteractionState = (
  session: ChatSession,
  patch: Partial<
    Pick<NonNullable<ChatSession['liveInteractionState']>, 'permission' | 'elicitation'>
  >,
  presentationOnly = false
): ChatSession => {
  const liveInteractionState = {
    permission: patch.permission ?? session.liveInteractionState?.permission ?? false,
    elicitation: patch.elicitation ?? session.liveInteractionState?.elicitation ?? false,
    ...(presentationOnly ? { presentationOnly: true as const } : {})
  }
  const liveSession =
    session.liveInteractionState?.permission === liveInteractionState.permission &&
    session.liveInteractionState?.elicitation === liveInteractionState.elicitation &&
    session.liveInteractionState?.presentationOnly === liveInteractionState.presentationOnly
      ? session
      : { ...session, liveInteractionState }
  if (presentationOnly) return liveSession
  const aggregatePatch: Partial<SessionInteractionState> = {
    ...(patch.permission !== undefined
      ? {
          permission:
            liveInteractionState.permission ||
            session.runtimeContext?.permission?.state === 'pending' ||
            hasPendingSandboxNetworkApproval(session)
        }
      : {}),
    ...(patch.elicitation !== undefined
      ? {
          elicitation:
            liveInteractionState.elicitation ||
            (session.interactionState?.elicitation !== false &&
              hasPendingDurableElicitation(session))
        }
      : {})
  }
  return projectSessionInteractionState(liveSession, aggregatePatch)
}
