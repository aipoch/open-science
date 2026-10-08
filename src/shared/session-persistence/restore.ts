import { isPreparedSessionRun } from './prompt-preparation'
import type { PersistedChatSession } from './session'
import type { SessionPermissionRuntimeContext } from '../session-runtime-context'
import {
  resolveActiveConversationMessages,
  type PersistedBranchActivity,
  resolveActiveConversationActivities
} from '../conversation-graph'
import type { PersistedToolActivity, PersistedChatMessage, PersistedActivityGroup } from './message'
import { isPersistedNotebookRunActivity } from './tool-activity'
import { latestTurnAnchor } from './turn-anchor'

// Restored interrupted sessions carry this error verbatim; the resume banner itself is driven by the Turn Outcome cause.
export const INTERRUPTED_SESSION_ERROR = 'Session was interrupted before the app closed.'

export const INTERRUPTED_TURN_ERROR = 'This turn was interrupted. Resume to continue.'

const isPermissionAuthorityBoundToActivePrompt = (
  session: PersistedChatSession,
  permission: SessionPermissionRuntimeContext
): boolean => {
  const activeMessages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  return Boolean(
    permission.request.sessionId === session.id &&
    activeMessages.some(
      (message) => message.id === permission.originatingPromptMessageId && message.role === 'user'
    )
  )
}

type RestorablePermissionToolAuthority = Readonly<{
  permission: SessionPermissionRuntimeContext
  activity: PersistedBranchActivity
  flatActivity: PersistedToolActivity
}>

export const resolveRestorablePermissionToolAuthority = (
  session: PersistedChatSession
): RestorablePermissionToolAuthority | undefined => {
  const permission = session.runtimeContext?.permission
  if (
    !permission ||
    permission.request.isMcp !== true ||
    !session.conversationGraph ||
    !isPermissionAuthorityBoundToActivePrompt(session, permission)
  ) {
    return undefined
  }
  const activity = session.conversationGraph.activities.find(
    (candidate) => candidate.id === permission.request.toolCallId
  )
  const flatActivities =
    session.activities?.filter((candidate) => candidate.id === permission.request.toolCallId) ?? []
  const flatActivity = flatActivities.length === 1 ? flatActivities[0] : undefined
  const visibleActivity = resolveActiveConversationActivities(
    session.conversationGraph
  ).activities.find((candidate) => candidate.id === permission.request.toolCallId)
  if (
    !activity ||
    !flatActivity ||
    !visibleActivity ||
    activity.promptMessageId !== permission.originatingPromptMessageId ||
    (flatActivity.promptMessageId !== permission.originatingPromptMessageId &&
      !(session.runtimeTranscriptOwner === 'main' && flatActivity.promptMessageId === undefined)) ||
    (activity.status !== 'pending' && activity.status !== 'in_progress') ||
    (flatActivity.status !== 'pending' && flatActivity.status !== 'in_progress')
  ) {
    return undefined
  }
  return { permission, activity, flatActivity }
}

const hasRestorablePermissionWait = (session: PersistedChatSession): boolean =>
  Boolean(
    session.status === 'waiting-permission' &&
    session.runtimeContext?.permission?.state === 'pending' &&
    resolveRestorablePermissionToolAuthority(session)
  )

// Identifies UI states that cannot survive an app process shutdown. Permission waits are durable
// only when their main-owned authority and active-branch prompt binding survived with the Session.
const isSessionInterrupted = (session: PersistedChatSession): boolean =>
  session.status === 'running' ||
  (session.status === 'waiting-permission' && !hasRestorablePermissionWait(session))

// Converts partial streamed assistant messages into visible errors after restart.
export const normalizeMessageAfterRestore = (
  message: PersistedChatMessage
): PersistedChatMessage =>
  message.status === 'streaming'
    ? {
        ...message,
        status: 'error',
        failedAt: message.updatedAt
      }
    : message

const markInterruptedPrompt = (
  messages: PersistedChatMessage[],
  promptMessageId: string | undefined
): PersistedChatMessage[] => {
  if (!promptMessageId) return messages
  return messages.map((message) =>
    message.id === promptMessageId && message.role === 'user'
      ? { ...message, interrupted: true }
      : message
  )
}

// Recovery targets the turn's admitted prompt; routed replies never own a Resume.
const latestTurnAnchorId = (messages: PersistedChatMessage[]): string | undefined =>
  latestTurnAnchor(messages)?.id

// Deliberately NOT the turn anchor: a durable question revision continues under its routed reply
// Message, so rearm must target (and require) the literal latest user message.
const latestUserMessageId = (messages: PersistedChatMessage[]): string | undefined =>
  [...messages].reverse().find((message) => message.role === 'user')?.id

// An answered app-owned question is not delivered until the provider acknowledges the next
// prompt. Keep recovery manual (as for restored permission decisions): never replay work on startup.
export const rearmUnacceptedElicitationContinuations = (
  session: PersistedChatSession,
  promptMessageId?: string,
  question?: { requestId: string; toolCallId: string }
): PersistedChatSession => {
  if (session.runtimeTranscriptOwner !== 'main' || !session.conversationGraph) return session
  const graph = session.conversationGraph
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)
  const promptId = promptMessageId ?? latestUserMessageId(session.messages)
  if (!promptId || promptId !== latestUserMessageId(session.messages)) return session
  if (session.activeRun && session.activeRun.promptMessageId !== promptId) return session
  const recoverable = new Set(
    graph.activities
      .filter(
        (activity) =>
          activity.agentFrameId === frame?.id &&
          activity.messageBranchId === frame?.activeBranchId &&
          activity.promptMessageId === promptId &&
          activity.elicitation?.durable?.kind === 'agent-user-choice' &&
          activity.elicitation.continuationPending === true &&
          (!question ||
            (activity.id === question.toolCallId &&
              activity.elicitation.durable.requestId === question.requestId))
      )
      .map(({ id }) => id)
  )
  if (recoverable.size === 0) return session
  const rearm = <T extends PersistedToolActivity>(activity: T): T => {
    if (!recoverable.has(activity.id) || !activity.elicitation) return activity
    const {
      continuationPending: _pending,
      respondedAt: _respondedAt,
      ...elicitation
    } = activity.elicitation
    void _pending
    void _respondedAt
    return {
      ...activity,
      status: 'in_progress',
      elicitation: {
        ...elicitation,
        state: 'pending',
        ...(elicitation.answers?.length ? { draftAnswers: elicitation.answers } : {})
      }
    }
  }
  return {
    ...session,
    status: 'waiting-for-user',
    activeRun: undefined,
    error: undefined,
    errorReportable: undefined,
    resumeRecovery: undefined,
    messages: session.messages.map((message) =>
      message.id === promptId ? { ...message, interrupted: undefined } : message
    ),
    activities: session.activities?.map(rearm),
    conversationGraph: {
      ...graph,
      messages: graph.messages.map((message) =>
        message.id === promptId ? { ...message, interrupted: undefined } : message
      ),
      activities: graph.activities.map(rearm)
    }
  }
}

// Run only after graph and flat activities have passed the same persisted-field sanitizers.
// A durable question can outlive its provider before a stop event has classified the Session wait.
export const restorePendingElicitationWait = (
  session: PersistedChatSession
): PersistedChatSession => {
  const graph = session.conversationGraph
  if (
    !graph ||
    (session.error !== undefined && session.error !== INTERRUPTED_SESSION_ERROR) ||
    session.runtimeContext?.permission ||
    session.runtimeContext?.plan?.approval === 'pending'
  ) {
    return session
  }
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)
  const messages = resolveActiveConversationMessages(graph)
  const prompt = messages.findLast(({ role }) => role === 'user')
  if (
    !frame ||
    !prompt ||
    prompt.status !== 'complete' ||
    prompt.agentFrameId !== frame.id ||
    prompt.introducedOnBranchId !== frame.activeBranchId ||
    !prompt.runtimeSegmentId ||
    (session.resumeRecovery?.promptMessageId !== undefined &&
      session.resumeRecovery.promptMessageId !== prompt.id)
  )
    return session
  const pending = resolveActiveConversationActivities(graph).activities.filter(
    ({ elicitation }) =>
      elicitation?.state === 'pending' && elicitation.durable?.kind === 'agent-user-choice'
  )
  const restorable = pending.some((activity) => {
    const authority = graph.activities.find(({ id }) => id === activity.id)!
    const durable = activity.elicitation!.durable!
    const flat = (session.activities ?? []).filter(({ id }) => id === activity.id)
    return (
      authority.agentFrameId === frame.id &&
      authority.messageBranchId === frame.activeBranchId &&
      authority.promptMessageId === prompt.id &&
      (!durable.promptMessageId || durable.promptMessageId === prompt.id) &&
      pending.filter(({ elicitation }) => elicitation!.durable!.requestId === durable.requestId)
        .length === 1 &&
      flat.length === 1 &&
      (!flat[0].promptMessageId || flat[0].promptMessageId === prompt.id) &&
      flat[0].title === activity.title &&
      flat[0].status === activity.status &&
      flat[0].sortIndex === activity.sortIndex &&
      // Sanitization fixes property order, so JSON equality checks the complete durable payload.
      JSON.stringify(flat[0].elicitation) === JSON.stringify(activity.elicitation)
    )
  })
  if (!restorable) return session
  const clearInterrupted = <T extends PersistedChatMessage>(message: T): T =>
    message.id === prompt.id ? { ...message, interrupted: undefined } : message
  return {
    ...session,
    status: 'waiting-for-user',
    activeRun: undefined,
    resumeRecovery: undefined,
    error: undefined,
    errorReportable: undefined,
    messages: session.messages.map(clearInterrupted),
    conversationGraph: { ...graph, messages: graph.messages.map(clearInterrupted) }
  }
}

// Rehydrates durable waits and converts runtime-only work into recoverable states after restart.
const recoverInterruptedPermissionAfterRestore = (
  session: PersistedChatSession
): PersistedChatSession => {
  const persistedRuntimeContext = session.runtimeContext
  if (!persistedRuntimeContext) return session
  const runtimeContext = { ...persistedRuntimeContext }
  delete runtimeContext.permission
  const promptMessageId = latestTurnAnchorId(session.messages)
  return {
    ...session,
    status: 'error',
    activeRun: undefined,
    runtimeContext,
    resumeRecovery: {
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId
    },
    error: session.error ?? INTERRUPTED_SESSION_ERROR,
    messages: markInterruptedPrompt(
      session.messages.map(normalizeMessageAfterRestore),
      promptMessageId
    )
  }
}

export const normalizeSessionAfterRestore = (
  session: PersistedChatSession,
  options: {
    deferPermissionValidation?: boolean
    reconcileCompletedRecovery?: boolean
  } = {}
): PersistedChatSession => {
  // Main releases unadmitted preparations; ordinary reads must retain their exact run witness.
  if (isPreparedSessionRun(session)) return session
  const persistedRuntimeContext = session.runtimeContext
  const continuingPermission = persistedRuntimeContext?.permission
  if (options.deferPermissionValidation && continuingPermission) {
    return {
      ...session,
      messages: session.messages.map(normalizeMessageAfterRestore)
    }
  }
  const permissionAuthority = resolveRestorablePermissionToolAuthority(session)
  if (persistedRuntimeContext && continuingPermission?.state === 'continuing') {
    if (permissionAuthority && session.status === 'running') {
      // The provider continuation died with the process. Re-present its durable request instead
      // of automatically replaying privileged work that may already have partially completed.
      return {
        ...session,
        status: 'waiting-permission',
        activeRun: undefined,
        runtimeContext: {
          ...persistedRuntimeContext,
          permission: {
            ...continuingPermission,
            state: 'pending'
          }
        },
        resumeRecovery: undefined,
        error: undefined,
        errorReportable: undefined,
        messages: session.messages.map(normalizeMessageAfterRestore)
      }
    }
    return recoverInterruptedPermissionAfterRestore(session)
  }
  if (hasRestorablePermissionWait(session)) {
    return {
      ...session,
      status: 'waiting-permission',
      activeRun: undefined,
      resumeRecovery: undefined,
      error: undefined,
      errorReportable: undefined,
      messages: session.messages.map(normalizeMessageAfterRestore)
    }
  }
  if (continuingPermission) return recoverInterruptedPermissionAfterRestore(session)
  const recoveredPromptMessageId = session.resumeRecovery?.promptMessageId
  const latestRecoveredPromptResponse = recoveredPromptMessageId
    ? [...session.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'agent' && message.responseToMessageId === recoveredPromptMessageId
        )
    : undefined
  const hasCompletedResponse =
    session.status === 'idle' &&
    session.error === undefined &&
    session.resumeRecovery !== undefined &&
    latestRecoveredPromptResponse?.status === 'complete'
  if (options.reconcileCompletedRecovery && hasCompletedResponse) {
    return {
      ...session,
      resumeRecovery: undefined,
      messages: session.messages.map(normalizeMessageAfterRestore)
    }
  }
  if (
    session.status === 'waiting-plan-approval' &&
    session.runtimeContext?.plan?.approval === 'pending'
  ) {
    return {
      ...session,
      activeRun: undefined,
      messages: session.messages.map(normalizeMessageAfterRestore)
    }
  }
  if (!isSessionInterrupted(session)) {
    const legacyInterrupted =
      session.resumeRecovery === undefined && session.error === INTERRUPTED_SESSION_ERROR
    const promptMessageId =
      session.resumeRecovery?.promptMessageId ??
      (legacyInterrupted ? latestTurnAnchorId(session.messages) : undefined)
    const resumeRecovery =
      session.resumeRecovery ??
      (legacyInterrupted
        ? ({ kind: 'resume-required', cause: 'app-restart', promptMessageId } as const)
        : undefined)
    return resumeRecovery
      ? {
          ...session,
          resumeRecovery,
          messages: markInterruptedPrompt(session.messages, promptMessageId)
        }
      : session
  }

  // An approved Plan remains durable work context after its provider interaction ends. Restore the
  // Session as idle without presenting a generic runtime failure or implying that work restarted.
  if (session.runtimeContext?.plan?.approval === 'approved') {
    return {
      ...session,
      status: 'idle',
      activeRun: undefined,
      error: undefined,
      errorReportable: undefined,
      messages: session.messages.map(normalizeMessageAfterRestore)
    }
  }

  // Runtime state cannot survive process shutdown, so restore interrupted turns as retryable errors.
  return {
    ...session,
    status: 'error',
    activeRun: undefined,
    resumeRecovery: {
      kind: 'resume-required',
      cause: 'app-restart',
      ...(session.activeRun?.promptMessageId
        ? { promptMessageId: session.activeRun.promptMessageId }
        : {})
    },
    error: session.error ?? INTERRUPTED_SESSION_ERROR,
    messages: markInterruptedPrompt(
      session.messages.map(normalizeMessageAfterRestore),
      session.activeRun?.promptMessageId
    )
  }
}

// Runtime activity state cannot resume after restart unless the exact active-Branch tool call is
// parked behind durable permission authority. An unowned Notebook call remains static: process loss
// is not evidence that its displayed code failed. Its process-scoped Run correlation is discarded.
export const normalizeActivityAfterRestore = (
  activity: PersistedToolActivity,
  permissionAuthority?: RestorablePermissionToolAuthority
): PersistedToolActivity => {
  const closesOpenActivity =
    (activity.status === 'pending' || activity.status === 'in_progress') &&
    !activity.elicitation?.durable &&
    // The resolver already validated these exact graph/flat projections. Main intentionally
    // omits the graph-owned prompt identity from its flat presentation.
    activity !== permissionAuthority?.activity &&
    activity !== permissionAuthority?.flatActivity
  const closesOpenNotebookActivity =
    closesOpenActivity &&
    (isPersistedNotebookRunActivity(activity) ||
      (activity.appOwned === true &&
        activity.id.startsWith('app-approval:') &&
        activity.providerToolName === 'Open-Science' &&
        typeof activity.rawInput === 'object' &&
        activity.rawInput !== null &&
        'notebookCodeRisk' in activity.rawInput))
  const normalized: PersistedToolActivity = {
    ...activity,
    ...(closesOpenActivity
      ? closesOpenNotebookActivity
        ? { toolDisposition: 'permission-closed' as const }
        : { status: 'failed' as const }
      : {}),
    ...(activity.elicitation?.state === 'pending' && !activity.elicitation.durable
      ? { elicitation: { ...activity.elicitation, state: 'cancelled' as const } }
      : {})
  }

  if (closesOpenNotebookActivity) {
    delete normalized.executionInvocationId
  }

  return normalized
}

export const normalizeActivityGroupAfterRestore = (
  group: PersistedActivityGroup
): PersistedActivityGroup =>
  group.completedAt === undefined ? { ...group, completedAt: group.updatedAt } : group
