import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'

/** Project trusted, bounded facts; never infer recovery instructions from command output. */
export const executionRecoveryContext = (
  value: unknown
): (NotebookExecutionRecovery & { guidance: string }) | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { execution, retryAfter } = value as Record<string, unknown>
  if (
    (execution !== 'not-started' && execution !== 'may-have-run') ||
    (retryAfter !== 'runtime-ready' && retryAfter !== 'cleanup-verified')
  )
    return undefined
  const prerequisite =
    retryAfter === 'cleanup-verified'
      ? 'Open-Science must verify cleanup before the affected runtime can be used again. Restarting alone does not prove cleanup.'
      : 'The affected runtime must be available before retrying. This result does not establish its current availability.'
  const effects =
    execution === 'not-started'
      ? 'This command was not started.'
      : 'This command may have changed files or external state; its output is not verified completion. Review its effects before deciding whether to rerun it.'
  return {
    execution,
    retryAfter,
    guidance: `${effects} ${prerequisite} Stop automatic retries and report this error to the user. Do not bypass the block with another execution tool, kill processes, or delete runtime resources to force recovery.`
  }
}
