import type {
  ClassifiedFailure,
  FailureCategory,
  FailureDiagnostics,
  FailureReason
} from '../failure/contract'
import { resolveActiveConversationMessages } from '../conversation-graph'
import type { PersistedChatMessage } from '../session-message-contract'
import { asNumber, isRecord } from './primitives'
import { INTERRUPTED_TURN_ERROR } from '../failure/messages'
import type { PersistedChatSession } from './session'
import { latestTurnAnchor } from './turn-anchor'
import type { TurnOutcome } from '../session-turn-outcome-contract'
export { type TurnOutcome } from '../session-turn-outcome-contract'

// Legacy booleans are consumed only here, including Session and preparation snapshots.
export const readPersistedFailure = (value: Record<string, unknown>): ClassifiedFailure => {
  const raw = typeof value.error === 'string' ? value.error : undefined
  const failure = value.failure
  const categories: readonly FailureCategory[] = [
    'configuration',
    'service',
    'environment',
    'input',
    'session',
    'internal'
  ]
  if (
    isRecord(failure) &&
    categories.includes(failure.category as FailureCategory) &&
    isRecord(failure.diagnostics)
  ) {
    const category = failure.category as FailureCategory
    const diagnostics: { -readonly [K in keyof FailureDiagnostics]: FailureDiagnostics[K] } = {}
    const source = failure.diagnostics
    if (
      typeof source.status === 'number' &&
      Number.isInteger(source.status) &&
      source.status >= 100 &&
      source.status <= 599
    )
      diagnostics.status = source.status
    for (const key of ['code', 'provider', 'model', 'requestId', 'raw'] as const)
      if (typeof source[key] === 'string') diagnostics[key] = source[key]
    return {
      category,
      ...(typeof failure.reason === 'string' &&
      failure.reason.startsWith(`${category}/`) &&
      failure.reason.length > category.length + 1
        ? { reason: failure.reason as FailureReason }
        : {}),
      diagnostics
    }
  }
  return {
    category:
      value.failure === undefined && value.errorReportable === false
        ? value.kind === 'interrupted'
          ? 'session'
          : 'service'
        : 'internal',
    diagnostics: raw === undefined ? {} : { raw }
  }
}

// Reject malformed variants rather than converting an unknown outcome into a completed turn.
// Forward compatibility: a known kind keeps only the fields this version understands, so extra
// fields from a newer writer never discard a historical turn (the legacy fallback only rebuilds the
// latest one). An unknown kind, or an unknown value on a required enum (`interrupted.cause`,
// `cancelled`/`interrupted` recovery), is dropped: this reader cannot invent its meaning or the
// action it implies. An unrecognized optional `failed.recovery` (any type) is stripped instead,
// keeping the failure without offering an action this version does not understand.
export const sanitizeTurnOutcome = (value: unknown): TurnOutcome | undefined => {
  if (!isRecord(value)) return undefined
  const settledAt = asNumber(value.settledAt)
  if (settledAt === undefined || settledAt < 0) return undefined
  if (value.kind === 'completed') return { kind: 'completed', settledAt }
  if (value.kind === 'cancelled') {
    return value.recovery === 'resume'
      ? { kind: 'cancelled', settledAt, recovery: 'resume' }
      : undefined
  }
  if (value.error !== undefined && typeof value.error !== 'string') return undefined
  if (
    value.failure === undefined &&
    value.errorReportable !== undefined &&
    typeof value.errorReportable !== 'boolean'
  )
    return undefined
  const error = typeof value.error === 'string' ? { error: value.error } : {}
  if (value.kind === 'failed') {
    return {
      kind: 'failed',
      settledAt,
      ...error,
      failure: readPersistedFailure(value),
      ...(value.recovery === 'retry-artifact-publication' ? { recovery: value.recovery } : {})
    }
  }
  if (value.kind === 'interrupted') {
    // Terminal commit exhaustion is deliberately live-only; never accept it from Session JSON.
    if (
      (value.cause !== 'app-restart' && value.cause !== 'connection-lost') ||
      value.recovery !== 'resume'
    )
      return undefined
    return {
      kind: 'interrupted',
      settledAt,
      cause: value.cause,
      ...error,
      failure: readPersistedFailure(value),
      recovery: 'resume'
    }
  }
  return undefined
}

export const latestOutcomePrompt = (
  session: PersistedChatSession
): PersistedChatMessage | undefined =>
  latestTurnAnchor(
    session.conversationGraph
      ? resolveActiveConversationMessages(session.conversationGraph)
      : session.messages
  )

// Read-only compatibility for old codecs. Assign to the latest eligible turn BEFORE hiding controls.
export const resolveTurnOutcome = (
  session: PersistedChatSession,
  promptMessageId: string
): TurnOutcome | undefined => {
  const messages = session.conversationGraph?.messages ?? session.messages
  const prompt = messages.find(
    (message) => message.id === promptMessageId && message.role === 'user'
  )
  if (!prompt) return undefined
  if (prompt.turnOutcome) return prompt.turnOutcome
  if (
    latestOutcomePrompt(session)?.id !== promptMessageId ||
    session.activeRun ||
    session.status.startsWith('waiting-') ||
    session.status === 'running'
  )
    return undefined
  const settledAt = session.updatedAt
  const recovery = session.resumeRecovery
  // Session recovery may belong to an independently admitted routed reply. Never borrow its
  // terminal state for a different message merely because that message is the latest turn anchor.
  if (recovery && recovery.promptMessageId !== promptMessageId) return undefined
  if (recovery?.cause === 'cancelled') return { kind: 'cancelled', settledAt, recovery: 'resume' }
  if (recovery)
    return {
      kind: 'interrupted',
      settledAt,
      cause: recovery.cause,
      error: session.error,
      failure: session.failure ?? { category: 'session', diagnostics: {} },
      recovery: 'resume'
    }
  if (session.status === 'error') {
    const activeMessages = session.messages
    const responseIds = activeMessages
      .slice(activeMessages.findIndex(({ id }) => id === promptMessageId) + 1)
      .filter(
        (message) =>
          message.role === 'agent' &&
          (!message.responseToMessageId || message.responseToMessageId === promptMessageId)
      )
      .flatMap((message) => message.artifactIds ?? [])
    const artifactFailure =
      (session.error?.startsWith('Generated file finalization failed') ||
        session.error?.startsWith('Generated file finalization cannot be retried')) &&
      responseIds.some((id) => {
        const artifact = session.artifacts?.find((candidate) => candidate.id === id)
        return (
          artifact && (artifact.versionId || artifact.path.split(/[\\/]+/u).at(-3) === '.pending')
        )
      })
    return {
      kind: 'failed',
      settledAt,
      error: session.error,
      failure: session.failure,
      ...(artifactFailure ? { recovery: 'retry-artifact-publication' as const } : {})
    }
  }
  // An optimistic user append is not proof of a completed turn in a legacy idle Session.
  if (
    !messages.some(
      (message) =>
        message.role === 'agent' &&
        message.responseToMessageId === promptMessageId &&
        message.status === 'complete'
    ) &&
    session.runtimeTranscriptLastRun?.promptMessageId !== promptMessageId
  )
    return undefined
  return { kind: 'completed', settledAt }
}

export const legacySessionStateForOutcome = (
  outcome: TurnOutcome,
  promptMessageId: string
): Pick<PersistedChatSession, 'status' | 'error' | 'failure' | 'resumeRecovery'> => ({
  status: outcome.kind === 'failed' || outcome.kind === 'interrupted' ? 'error' : 'idle',
  error:
    outcome.kind === 'cancelled'
      ? INTERRUPTED_TURN_ERROR
      : outcome.kind === 'completed'
        ? undefined
        : outcome.error,
  failure:
    outcome.kind === 'failed' || outcome.kind === 'interrupted' ? outcome.failure : undefined,
  resumeRecovery:
    outcome.kind === 'cancelled' || outcome.kind === 'interrupted'
      ? {
          kind: 'resume-required',
          promptMessageId,
          cause:
            outcome.kind === 'cancelled'
              ? 'cancelled'
              : outcome.cause === 'terminal-commit-failed'
                ? 'connection-lost'
                : outcome.cause
        }
      : undefined
})

// Main mutation helper: clone both representations, preserving every other historical node.
export const setTurnOutcome = (
  session: PersistedChatSession,
  promptMessageId: string,
  outcome: TurnOutcome | undefined
): PersistedChatSession => {
  const update = <T extends PersistedChatMessage>(message: T): T => {
    if (message.id !== promptMessageId || message.role !== 'user') return message
    const next = { ...message }
    if (outcome) next.turnOutcome = structuredClone(outcome)
    else delete next.turnOutcome
    if (outcome?.kind === 'cancelled' || outcome?.kind === 'interrupted') next.interrupted = true
    else delete next.interrupted
    return next
  }
  return {
    ...session,
    messages: session.messages.map(update),
    ...(session.conversationGraph
      ? {
          conversationGraph: {
            ...session.conversationGraph,
            messages: session.conversationGraph.messages.map(update)
          }
        }
      : {})
  }
}
