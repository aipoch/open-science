import { classifyFailure } from '../../shared/failure/classify'
import { isDeepStrictEqual } from 'node:util'
import {
  legacySessionStateForOutcome,
  isPreparedSessionRun,
  isInheritedForkTurn,
  latestOutcomePrompt,
  normalizeSessionAfterRestore,
  resolveTurnOutcome,
  setTurnOutcome,
  type PersistedChatMessage,
  type PersistedChatSession,
  type TurnOutcome
} from '../../shared/session-persistence'

// Every submitted representation is untrusted, including graph-only historical Branches.
export const preserveMainTurnOutcomes = (
  submitted: PersistedChatSession,
  authority: PersistedChatSession | undefined,
  preservePreparation = true
): PersistedChatSession => {
  const outcomes = new Map(
    [...(authority?.messages ?? []), ...(authority?.conversationGraph?.messages ?? [])]
      .filter(({ role }) => role === 'user')
      .map((message) => [message.id, message.turnOutcome])
  )
  const restore = <T extends PersistedChatMessage>(message: T): T => {
    const result = { ...message }
    const outcome = message.role === 'user' ? outcomes.get(message.id) : undefined
    if (outcome) result.turnOutcome = structuredClone(outcome)
    else delete result.turnOutcome
    return result
  }
  return {
    ...submitted,
    promptPreparation: preservePreparation
      ? authority?.promptPreparation
        ? structuredClone(authority.promptPreparation)
        : undefined
      : submitted.promptPreparation,
    messages: submitted.messages.map(restore),
    ...(submitted.conversationGraph
      ? {
          conversationGraph: {
            ...submitted.conversationGraph,
            messages: submitted.conversationGraph.messages.map(restore)
          }
        }
      : {})
  }
}

// Restore decoding is shared with renderer. Only Main commits this newly abandoned execution.
export const recordRestartTurnOutcome = (
  restored: PersistedChatSession,
  authority: PersistedChatSession
): PersistedChatSession => {
  const preparation = authority.promptPreparation
  if (preparation && (!authority.activeRun || isPreparedSessionRun(authority))) {
    const next = { ...authority, activeRun: undefined, promptPreparation: undefined }
    const target =
      preparation.mode === 'new' &&
      authority.messages.some(
        (message) => message.id === preparation.promptMessageId && message.role === 'user'
      )
        ? {
            status: 'idle' as const,
            error: undefined,
            failure: undefined,
            resumeRecovery: undefined
          }
        : preparation.previousState
    for (const key of ['status', 'error', 'failure', 'resumeRecovery'] as const) {
      if (isDeepStrictEqual(authority[key], preparation.expectedState[key]))
        Object.assign(next, { [key]: target[key] })
    }
    return next
  }
  if (
    restored.resumeRecovery?.cause !== 'app-restart' ||
    restored.activeRun ||
    !authority.activeRun
  )
    return restored
  const promptId = restored.resumeRecovery.promptMessageId ?? latestOutcomePrompt(restored)?.id
  if (!promptId) return restored
  const prompt = (restored.conversationGraph?.messages ?? restored.messages).find(
    ({ id, role }) => id === promptId && role === 'user'
  )
  if (!prompt || prompt.turnOutcome) return restored
  const outcome: TurnOutcome = {
    kind: 'interrupted',
    cause: 'app-restart',
    settledAt: restored.updatedAt,
    error: restored.error,
    failure: classifyFailure({ origin: 'session' }),
    recovery: 'resume'
  }
  return {
    ...setTurnOutcome(restored, promptId, outcome),
    ...legacySessionStateForOutcome(outcome, promptId)
  }
}

// An idle snapshot can retain a run after its execution owner is gone. Only the active
// branch's latest prompt may acquire an interruption. Older or invisible runs just expire.
export const recoverDetachedIdleRun = (session: PersistedChatSession): PersistedChatSession => {
  if (
    session.status !== 'idle' ||
    !session.activeRun ||
    session.promptPreparation ||
    session.packageOrigin
  )
    return session
  const cleared = { ...session, activeRun: undefined }
  const prompt = latestOutcomePrompt(session)
  if (
    !prompt ||
    prompt.id !== session.activeRun.promptMessageId ||
    isInheritedForkTurn(session, prompt.id)
  )
    return cleared
  const graph = session.conversationGraph
  if (graph) {
    const node = graph.messages.find(({ id }) => id === prompt.id)
    const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)
    if (
      !node ||
      !frame ||
      node.agentFrameId !== frame.id ||
      node.introducedOnBranchId !== frame.activeBranchId
    )
      return cleared
  }
  // The flat transcript here is the decoded active branch. Other branches can contain
  // finished replies to the same prompt. A last-run identity alone cannot prove completion.
  const outcome = resolveTurnOutcome(
    { ...cleared, conversationGraph: undefined, runtimeTranscriptLastRun: undefined },
    prompt.id
  )
  if (outcome) return { ...cleared, ...legacySessionStateForOutcome(outcome, prompt.id) }
  return recordRestartTurnOutcome(
    normalizeSessionAfterRestore({ ...session, status: 'running' }),
    session
  )
}
