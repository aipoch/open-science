import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'

/** Project trusted, bounded facts; never infer recovery instructions from command output. */
export const executionRecoveryContext = (
  value: unknown
): (NotebookExecutionRecovery & { guidance: string }) | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { execution, retryAfter, kernel: rawKernel } = value as Record<string, unknown>
  if (
    (execution !== 'not-started' && execution !== 'may-have-run') ||
    (retryAfter !== 'runtime-ready' && retryAfter !== 'cleanup-verified')
  )
    return undefined
  const candidate =
    rawKernel && typeof rawKernel === 'object' ? (rawKernel as Record<string, unknown>) : undefined
  const kernel: NotebookExecutionRecovery['kernel'] =
    candidate &&
    ['python', 'r', 'repl'].includes(String(candidate.kind)) &&
    (candidate.kind === 'repl' ||
      (typeof candidate.environment === 'string' && candidate.environment.length > 0)) &&
    (candidate.signal === null ||
      (typeof candidate.signal === 'string' && /^SIG[A-Z0-9]+$/.test(candidate.signal))) &&
    (candidate.exitCode === null || Number.isInteger(candidate.exitCode)) &&
    ['unknown', 'os-memory-pressure'].includes(String(candidate.cause)) &&
    ['verified', 'unverified'].includes(String(candidate.cleanup))
      ? {
          kind: candidate.kind as 'python' | 'r' | 'repl',
          ...(candidate.kind !== 'repl' ? { environment: candidate.environment as string } : {}),
          signal: candidate.signal as string | null,
          exitCode: candidate.exitCode as number | null,
          cause: candidate.cause as 'unknown' | 'os-memory-pressure',
          cleanup: candidate.cleanup as 'verified' | 'unverified'
        }
      : undefined
  const prerequisite =
    retryAfter === 'cleanup-verified'
      ? 'At failure, cleanup was unverified. The affected runtime can resume after Open-Science verifies cleanup.'
      : 'The affected runtime must be available before retrying. This result does not establish its current availability.'
  const effects =
    execution === 'not-started'
      ? 'This command was not started.'
      : 'This command may have changed files or external state; its output is not verified completion. Review its effects before deciding whether to rerun it.'
  if (kernel) {
    const target =
      kernel.kind === 'repl'
        ? '{"kernel":"repl"}'
        : JSON.stringify({ language: kernel.kind, environment: kernel.environment })
    const cause =
      kernel.cause === 'os-memory-pressure'
        ? 'OS logs confirm memory pressure; consider reducing memory demand.'
        : kernel.signal === 'SIGKILL'
          ? 'The cause is unconfirmed; SIGKILL alone does not establish memory pressure.'
          : 'The underlying cause of this exit is unconfirmed.'
    const recovery =
      kernel.cleanup === 'unverified'
        ? `At failure, cleanup was unverified. If still unresolved, notebook_restart with ${target} can recheck cleanup for this interpreter.`
        : 'Cleanup was verified; no extra restart is needed for this exit.'
    return {
      execution,
      retryAfter,
      kernel,
      guidance: `${effects} ${cause} ${recovery} The exited interpreter's variables were lost; rebuild required state if it has not already been restored.`
    }
  }
  return {
    execution,
    retryAfter,
    guidance: `${effects} ${prerequisite}`
  }
}
