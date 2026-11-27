export type NotebookMemoryRejectionCode = 'NOTEBOOK_MEMORY_PRESSURE' | 'NOTEBOOK_MEMORY_UNAVAILABLE'
export const isNotebookMemoryRejectionCode = (
  value: unknown
): value is NotebookMemoryRejectionCode =>
  value === 'NOTEBOOK_MEMORY_PRESSURE' || value === 'NOTEBOOK_MEMORY_UNAVAILABLE'

/** Live backend evidence projected to a conversation before the human submits a new message. */
export type NotebookExecutionRefusal = Readonly<{
  projectId: string
  sessionId: string
  refusalId: string
  generation: string
  order: number
}>

/** Facts captured at failure time, not a live availability check or permission to replay a command. */
export type NotebookExecutionRecovery = Readonly<{
  execution: 'not-started' | 'may-have-run'
  retryAfter: 'runtime-ready' | 'cleanup-verified'
  memoryRejectionCode?: NotebookMemoryRejectionCode
  kernel?: Readonly<{
    kind: 'python' | 'r' | 'repl'
    environment?: string
    exitCode: number | null
    signal: string | null
    cause: 'os-memory-pressure' | 'nul-initialization-unavailable' | 'unknown'
    // Historical Notebook recovery records included process cleanup evidence.
    cleanup?: 'verified' | 'unverified'
  }>
}>
