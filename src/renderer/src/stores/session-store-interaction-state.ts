import type { ChatSession, SessionStatus } from './session-store-persistence-owner'
import type { SessionWaitReason } from '../../../shared/session-persistence'

export type SessionInteractionState = Readonly<{
  permission: boolean
  elicitation: boolean
  plan: boolean
}>

export type { SessionWaitReason } from '../../../shared/session-persistence'

export type SessionBlockingInteraction = 'permission' | 'elicitation' | 'plan'

export type SessionActionDisabledReason =
  | 'session-running'
  | 'session-pending'
  | 'permission-pending'
  | 'elicitation-pending'
  | 'plan-approval-pending'

export type SessionActionAvailability = Readonly<{
  allowed: boolean
  disabledReason?: SessionActionDisabledReason
}>

export type SessionActionabilityFacts = Readonly<{
  presentedWaitReason?: SessionWaitReason
  hasRunningWork?: boolean
  rootPermissionPending?: boolean
  elicitationPending?: boolean
  planPending?: boolean
  allowPendingSessionRetry?: boolean
}>

export type SessionActionabilityProjection = Readonly<{
  presentedStatus: SessionStatus
  activity: 'inactive' | 'running' | 'waiting'
  attentionOwner: 'none' | 'agent' | 'user'
  waitReason?: SessionWaitReason
  blockingInteraction?: SessionBlockingInteraction
  actions: Readonly<{
    startTurn: SessionActionAvailability
    revise: SessionActionAvailability
    branchFromMessage: SessionActionAvailability
    startSideChat: SessionActionAvailability
    changeAgentControls: SessionActionAvailability
    changeAutoReview: SessionActionAvailability
    changeSpecialist: SessionActionAvailability
    changeMemory: SessionActionAvailability
    archive: SessionActionAvailability
  }>
}>

type SessionInteractionSource = Readonly<{
  status: SessionStatus
  interactionState?: SessionInteractionState
  runtimeContext?: ChatSession['runtimeContext']
  activities?: readonly {
    elicitation?: {
      state: string
      durable?: { kind: string }
    }
  }[]
  activeRun?: unknown
  agentPromptInFlight?: boolean
  isPending?: boolean
  pendingHistoryReplay?: unknown
}>

type SessionPermissionRequest = Readonly<{
  sessionId: string
  delegated?: unknown
}>

export const resolveRootPermissionPending = (
  pendingPermissions: readonly SessionPermissionRequest[],
  sessionId: string | undefined
): boolean | undefined => {
  if (!sessionId) return undefined
  const sessionRequests = pendingPermissions.filter((request) => request.sessionId === sessionId)
  if (sessionRequests.length === 0) return undefined
  return sessionRequests.some((request) => request.delegated === undefined)
}

export const isSessionWaitReason = (status: string): status is SessionWaitReason =>
  status === 'waiting-permission' ||
  status === 'waiting-for-user' ||
  status === 'waiting-plan-approval'

export const sessionAwaitsHistoryReplay = (
  session: Pick<SessionInteractionSource, 'isPending' | 'pendingHistoryReplay'> | undefined
): boolean => Boolean(session?.isPending || session?.pendingHistoryReplay)

const hasPendingDurableElicitation = (session: SessionInteractionSource): boolean =>
  (session.status === 'waiting-for-user' || session.status === 'waiting-permission') &&
  session.activities?.some(
    (activity) =>
      activity.elicitation?.state === 'pending' &&
      activity.elicitation.durable?.kind === 'agent-user-choice'
  ) === true

export const inferSessionInteractionState = (
  session: SessionInteractionSource
): SessionInteractionState =>
  session.interactionState && isSessionWaitReason(session.status)
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
  session: SessionInteractionSource,
  interactionState: SessionInteractionState = inferSessionInteractionState(session)
): SessionStatus => {
  if (interactionState.permission) return 'waiting-permission'
  if (interactionState.elicitation) return 'waiting-for-user'
  if (interactionState.plan) return 'waiting-plan-approval'
  if (!isSessionWaitReason(session.status)) return session.status
  return session.activeRun || session.agentPromptInFlight ? 'running' : 'idle'
}

const actionAvailability = (
  disabledReason: SessionActionDisabledReason | undefined
): SessionActionAvailability =>
  disabledReason ? { allowed: false, disabledReason } : { allowed: true }

const disabledReasonForInteraction = (
  interaction: SessionBlockingInteraction | undefined
): SessionActionDisabledReason | undefined => {
  if (interaction === 'permission') return 'permission-pending'
  if (interaction === 'elicitation') return 'elicitation-pending'
  if (interaction === 'plan') return 'plan-approval-pending'
  return undefined
}

export const projectSessionActionability = (
  session: SessionInteractionSource,
  facts: SessionActionabilityFacts = {}
): SessionActionabilityProjection => {
  const interactionState = inferSessionInteractionState(session)
  const status = resolveSessionInteractionStatus(session, interactionState)
  const waitReason = isSessionWaitReason(status) ? status : facts.presentedWaitReason
  const running = !waitReason && (status === 'running' || facts.hasRunningWork === true)
  const durableRootPermissionPending = session.runtimeContext?.permission?.state === 'pending'
  const permissionPending =
    durableRootPermissionPending || (facts.rootPermissionPending ?? interactionState.permission)
  const elicitationPending = facts.elicitationPending ?? interactionState.elicitation
  const planPending = facts.planPending ?? interactionState.plan
  const blockingInteraction: SessionBlockingInteraction | undefined = permissionPending
    ? 'permission'
    : elicitationPending
      ? 'elicitation'
      : planPending
        ? 'plan'
        : undefined
  const interactionDisabledReason = disabledReasonForInteraction(blockingInteraction)
  const historyReplayPending = Boolean(session.pendingHistoryReplay)
  const sessionPending = Boolean(session.isPending) || historyReplayPending
  const turnDisabledReason =
    session.isPending && !facts.allowPendingSessionRetry
      ? 'session-pending'
      : running
        ? 'session-running'
        : interactionDisabledReason
  const revisionDisabledReason = running ? 'session-running' : interactionDisabledReason
  const attentionDisabledReason = waitReason
    ? waitReason === 'waiting-permission'
      ? 'permission-pending'
      : waitReason === 'waiting-for-user'
        ? 'elicitation-pending'
        : 'plan-approval-pending'
    : undefined
  const replayOrPendingReason = sessionPending ? 'session-pending' : undefined
  const replayIndependentChangeDisabledReason = session.isPending
    ? 'session-pending'
    : running
      ? 'session-running'
      : (attentionDisabledReason ?? interactionDisabledReason)
  const activity = waitReason ? 'waiting' : running ? 'running' : 'inactive'

  return {
    presentedStatus: waitReason ?? (running ? 'running' : status),
    activity,
    attentionOwner: waitReason ? 'user' : running ? 'agent' : 'none',
    waitReason,
    blockingInteraction,
    actions: {
      startTurn: actionAvailability(turnDisabledReason),
      revise: actionAvailability(revisionDisabledReason),
      branchFromMessage: actionAvailability(
        session.isPending
          ? 'session-pending'
          : running
            ? 'session-running'
            : attentionDisabledReason
      ),
      startSideChat: actionAvailability(replayOrPendingReason ?? attentionDisabledReason),
      changeAgentControls: actionAvailability(
        replayOrPendingReason ??
          (running ? 'session-running' : (attentionDisabledReason ?? interactionDisabledReason))
      ),
      // Replay-independent settings may change while the provider still awaits transcript replay.
      changeAutoReview: actionAvailability(replayIndependentChangeDisabledReason),
      changeSpecialist: actionAvailability(replayIndependentChangeDisabledReason),
      changeMemory: actionAvailability(replayIndependentChangeDisabledReason),
      archive: actionAvailability(running ? 'session-running' : attentionDisabledReason)
    }
  }
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
