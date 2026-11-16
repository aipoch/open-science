import type { ClassifiedFailure } from './failure/contract'
export type TurnOutcome =
  | Readonly<{ kind: 'completed'; settledAt: number }>
  | Readonly<{
      kind: 'failed'
      settledAt: number
      error?: string
      failure?: ClassifiedFailure
      // Definitive Main boundary evidence; omitted means execution must be reconciled.
      execution?: 'not-started'
      recovery?: 'retry-artifact-publication'
    }>
  | Readonly<{ kind: 'cancelled'; settledAt: number; recovery: 'resume' }>
  | Readonly<{
      kind: 'interrupted'
      settledAt: number
      cause: 'app-restart' | 'connection-lost' | 'terminal-commit-failed'
      error?: string
      failure?: ClassifiedFailure
      recovery: 'resume'
    }>
