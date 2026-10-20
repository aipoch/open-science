import type { TurnOutcome } from './session-turn-outcome-contract'

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
