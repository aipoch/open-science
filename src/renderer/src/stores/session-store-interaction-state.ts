import type { ChatSession, SessionStatus } from './session-store-persistence-owner'
import {
  deriveSessionAttention,
  projectSessionAttention,
  type PersistedChatSession,
  type SessionAttention,
  type SessionWaitReason
} from '../../../shared/session-persistence'

export type SessionInteractionState = Readonly<{
  permission: boolean
  elicitation: boolean
  plan: boolean
}>

export type { SessionWaitReason } from '../../../shared/session-persistence'

export type SessionBlockingInteraction = 'permission' | 'credential' | 'elicitation' | 'plan'

export type SessionActionDisabledReason =
  | 'session-running'
  | 'session-pending'
  | 'permission-pending'
  | 'credential-pending'
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
  credentialPending?: boolean
  elicitationPending?: boolean
  planPending?: boolean
  allowPendingSessionRetry?: boolean
}>

export type SessionActionabilityProjection = Readonly<{
  presentedStatus: SessionStatus
  attention?: SessionAttention
  activity: 'inactive' | 'running' | 'waiting'
  attentionOwner: 'none' | 'agent' | 'user'
  waitReason?: SessionWaitReason
  blockingInteraction?: SessionBlockingInteraction
  actions: Readonly<{
    startTurn: SessionActionAvailability
    revise: SessionActionAvailability
    branchFromMessage: SessionActionAvailability
    changeAgentControls: SessionActionAvailability
    changeAutoReview: SessionActionAvailability
    changeSpecialist: SessionActionAvailability
    changeMemory: SessionActionAvailability
    archive: SessionActionAvailability
  }>
}>

type SessionInteractionSource = Readonly<{
  packageOrigin?: ChatSession['packageOrigin']
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
  attention?: SessionAttention
  messages?: PersistedChatSession['messages']
  conversationGraph?: PersistedChatSession['conversationGraph']
  recordProblems?: PersistedChatSession['recordProblems']
  contentLoaded?: boolean
  conversationGraphSyncBlocked?: boolean
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
  if (interaction === 'credential') return 'credential-pending'
  if (interaction === 'elicitation') return 'elicitation-pending'
  if (interaction === 'plan') return 'plan-approval-pending'
  return undefined
}

export const projectSessionActionability = (
  session: SessionInteractionSource,
  facts: SessionActionabilityFacts = {}
): SessionActionabilityProjection => {
  const isImported = Boolean(session.packageOrigin)
  const interactionState = inferSessionInteractionState(session)
  const status = resolveSessionInteractionStatus(session, interactionState)
  const waitReason = isSessionWaitReason(status) ? status : facts.presentedWaitReason
  // Durable transcript updates can lag Main's live prompt ownership. Keep foreground actions
  // locked until that ownership settles, while preserving actionable user waits above it.
  const running =
    !waitReason &&
    (status === 'running' ||
      Boolean(session.activeRun) ||
      session.agentPromptInFlight === true ||
      facts.hasRunningWork === true)
  const durableRootPermissionPending = session.runtimeContext?.permission?.state === 'pending'
  const permissionPending =
    durableRootPermissionPending || (facts.rootPermissionPending ?? interactionState.permission)
  const credentialPending = facts.credentialPending === true
  const elicitationPending = facts.elicitationPending ?? interactionState.elicitation
  const planPending = facts.planPending ?? interactionState.plan
  const blockingInteraction: SessionBlockingInteraction | undefined = permissionPending
    ? 'permission'
    : credentialPending
      ? 'credential'
      : elicitationPending
        ? 'elicitation'
        : planPending
          ? 'plan'
          : undefined
  const interactionDisabledReason = disabledReasonForInteraction(blockingInteraction)
  const historyReplayPending = Boolean(session.pendingHistoryReplay)
  // A failed creation keeps isPending until retry binds the provider. It no longer owns
  // initialization: allow the user to repair its configuration and submit that retry.
  const creationPending = Boolean(session.isPending) && session.status !== 'error'
  const sessionPending = creationPending || historyReplayPending
  const turnDisabledReason =
    creationPending && !facts.allowPendingSessionRetry
      ? 'session-pending'
      : running
        ? 'session-running'
        : interactionDisabledReason
  const revisionDisabledReason = running ? 'session-running' : interactionDisabledReason
  const attentionDisabledReason =
    interactionDisabledReason ??
    (waitReason
      ? waitReason === 'waiting-permission'
        ? 'permission-pending'
        : waitReason === 'waiting-for-user'
          ? 'elicitation-pending'
          : 'plan-approval-pending'
      : undefined)
  const replayOrPendingReason = sessionPending ? 'session-pending' : undefined
  // These settings can persist or reset runtime context; keep transient Session IDs
  // out of those paths even after creation fails.
  const replayIndependentChangeDisabledReason = session.isPending
    ? 'session-pending'
    : running
      ? 'session-running'
      : (attentionDisabledReason ?? interactionDisabledReason)
  const activity = waitReason ? 'waiting' : running ? 'running' : 'inactive'
  const durableAttention =
    session.contentLoaded === false || !session.messages
      ? session.attention
      : deriveSessionAttention(session as PersistedChatSession)
  const attention =
    projectSessionAttention({
      latestVisibleTurn: durableAttention?.turn,
      recordProblems: [
        ...(session.recordProblems ?? durableAttention?.recordProblems ?? []),
        ...(session.conversationGraphSyncBlocked ? (['conversation-graph-sync'] as const) : [])
      ]
    }) ?? (session.contentLoaded === false ? durableAttention : undefined)
  const executionAvailability = (
    reason: SessionActionDisabledReason | undefined
  ): SessionActionAvailability =>
    session.packageOrigin ? { allowed: false } : actionAvailability(reason)

  return {
    presentedStatus: isImported
      ? attention
        ? 'error'
        : 'idle'
      : (waitReason ??
        (running ? 'running' : attention ? 'error' : !session.messages ? status : 'idle')),
    attention,
    // Package runtime fields describe recorded work and never own current UI interaction.
    activity: isImported ? 'inactive' : activity,
    attentionOwner: isImported ? 'none' : waitReason ? 'user' : running ? 'agent' : 'none',
    waitReason: isImported ? undefined : waitReason,
    blockingInteraction: isImported ? undefined : blockingInteraction,
    actions: {
      startTurn: executionAvailability(turnDisabledReason),
      revise: executionAvailability(revisionDisabledReason),
      branchFromMessage: executionAvailability(
        session.isPending
          ? 'session-pending'
          : running
            ? 'session-running'
            : attentionDisabledReason
      ),
      changeAgentControls: executionAvailability(
        replayOrPendingReason ??
          (running ? 'session-running' : (attentionDisabledReason ?? interactionDisabledReason))
      ),
      // Replay-independent settings may change while the provider still awaits transcript replay.
      changeAutoReview: executionAvailability(replayIndependentChangeDisabledReason),
      changeSpecialist: executionAvailability(replayIndependentChangeDisabledReason),
      changeMemory: executionAvailability(replayIndependentChangeDisabledReason),
      archive: actionAvailability(
        isImported ? undefined : running ? 'session-running' : attentionDisabledReason
      )
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
