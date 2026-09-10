/** Facts captured at failure time, not a live availability check or permission to replay a command. */
export type NotebookExecutionRecovery = Readonly<{
  execution: 'not-started' | 'may-have-run'
  retryAfter: 'runtime-ready' | 'cleanup-verified'
}>
