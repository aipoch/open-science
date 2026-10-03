import { resolveActiveConversationMessages } from '../conversation-graph'
import type { PersistedChatSession } from './session'
import { isHiddenControlMessage } from './message'
import { isInheritedForkTurn, isTurnAnchor } from './turn-anchor'
import { resolveTurnOutcome, type TurnOutcome } from './turn-outcome'

export type SessionRecordProblem = 'missing-record' | 'size-limit' | 'conversation-graph-sync'

export type SessionAttentionTurn = Readonly<{
  promptMessageId: string
  outcome: Extract<TurnOutcome, { kind: 'failed' | 'interrupted' }>
}>

export type SessionAttention = Readonly<{
  turn?: SessionAttentionTurn
  recordProblems: readonly SessionRecordProblem[]
}>

export type SessionAttentionFacts = Readonly<{
  latestVisibleTurn?: SessionAttentionTurn
  recordProblems?: readonly SessionRecordProblem[]
}>

const PROBLEM_ORDER: readonly SessionRecordProblem[] = [
  'missing-record',
  'size-limit',
  'conversation-graph-sync'
]

export const projectSessionAttention = (
  facts: SessionAttentionFacts
): SessionAttention | undefined => {
  const problems = PROBLEM_ORDER.filter((problem) => facts.recordProblems?.includes(problem))
  if (!facts.latestVisibleTurn && problems.length === 0) return undefined
  return {
    ...(facts.latestVisibleTurn ? { turn: facts.latestVisibleTurn } : {}),
    recordProblems: problems
  }
}

export const latestVisibleTurn = (
  session: PersistedChatSession
): SessionAttentionTurn | undefined => {
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  // Hidden controls are not visible turns. Legacy fallback still belongs only to the
  // newest eligible prompt, as enforced by resolveTurnOutcome, so it cannot migrate.
  const anchor = messages.findLast(
    (message) => isTurnAnchor(message) && !isHiddenControlMessage(message)
  )
  // Turns copied into a fork are history; the fork's Attention starts with its own prompts.
  if (!anchor || isInheritedForkTurn(session, anchor.id)) return undefined
  // Attention only needs unsuccessful legacy outcomes; proving a completed turn would scan
  // every historical reply each time an actionability consumer reads an idle Session.
  const outcome =
    anchor.turnOutcome ??
    (session.status === 'error' || session.resumeRecovery
      ? resolveTurnOutcome(session, anchor.id)
      : undefined)
  if (!outcome || (outcome.kind !== 'failed' && outcome.kind !== 'interrupted')) return undefined
  if (outcome.kind === 'interrupted' && outcome.cause === 'terminal-commit-failed') return undefined
  return { promptMessageId: anchor.id, outcome }
}

export const deriveSessionAttention = (
  session: PersistedChatSession,
  recordProblems: readonly SessionRecordProblem[] = session.recordProblems ?? []
): SessionAttention | undefined =>
  projectSessionAttention({ latestVisibleTurn: latestVisibleTurn(session), recordProblems })
