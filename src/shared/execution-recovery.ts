/** Facts captured at failure time, not a live availability check or permission to replay a command. */
export type NotebookExecutionRecovery = Readonly<{
  execution: 'not-started' | 'may-have-run'
  retryAfter: 'runtime-ready' | 'cleanup-verified'
  kernel?: Readonly<{
    kind: 'python' | 'r' | 'repl'
    environment?: string
    exitCode: number | null
    signal: string | null
    cause: 'os-memory-pressure' | 'unknown'
    cleanup: 'verified' | 'unverified'
  }>
}>
