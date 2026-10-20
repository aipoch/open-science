export type TurnOutcome =
  | Readonly<{ kind: 'completed'; settledAt: number }>
  | Readonly<{
      kind: 'failed'
      settledAt: number
      error?: string
      errorReportable?: boolean
      recovery?: 'retry-artifact-publication'
    }>
  | Readonly<{ kind: 'cancelled'; settledAt: number; recovery: 'resume' }>
  | Readonly<{
      kind: 'interrupted'
      settledAt: number
      cause: 'app-restart' | 'connection-lost' | 'terminal-commit-failed'
      error?: string
      errorReportable?: false
      recovery: 'resume'
    }>
