import type { NotebookRunRecord } from '../../../../shared/notebook'

type Translate = (key: string, options?: Record<string, unknown>) => string
type ShellFailureFacts = {
  status?: string
  errorCode?: string
  exitCode?: number | null
}

// Only durable Shell facts can identify why a command failed. Historical runs without those facts
// retain a neutral failure label instead of guessing from stderr or a missing exit code.
export const shellFailureLabel = (facts: ShellFailureFacts): string | undefined => {
  if (facts.status !== 'failed') return undefined
  if (
    facts.errorCode === 'shell-runtime-unavailable' ||
    facts.errorCode === 'shell-start-failed' ||
    facts.errorCode === 'shell-network-transport-unsupported' ||
    facts.errorCode === 'shell-command-blocked'
  ) {
    return 'Shell did not start'
  }
  if (facts.errorCode === 'shell-nonzero-exit') {
    return 'Command failed'
  }
  // Other known failures are not command exits, even if a synthetic result carries a number.
  if (facts.errorCode) return 'Shell execution failed'
  if (facts.exitCode !== null && typeof facts.exitCode === 'number' && facts.exitCode !== 0) {
    return 'Command failed'
  }
  return 'Shell execution failed'
}

export const shellFailureMetaLabel = (
  facts: ShellFailureFacts,
  t: Translate
): string | undefined => {
  const label = shellFailureLabel(facts)
  if (!label) return undefined
  if (label === 'Command failed' && typeof facts.exitCode === 'number') {
    return t('Command failed (exit {{code}})', { code: facts.exitCode })
  }
  return t(label)
}

export const shellRunFailureLabel = (run: NotebookRunRecord): string | undefined =>
  run.kernelKind === 'bash'
    ? shellFailureLabel({
        status: run.status,
        errorCode: run.shellErrorCode,
        exitCode: run.exitCode
      })
    : undefined

export const shellRunOutcomeNotice = (run: NotebookRunRecord, t: Translate): string | undefined => {
  if (run.kernelKind !== 'bash' || run.status !== 'failed') return undefined
  if (run.recovery?.retryAfter === 'cleanup-verified') {
    return t(
      'Shell cleanup could not be verified. Do not retry until cleanup is verified; check for partial effects.'
    )
  }
  if (run.shellErrorCode === 'shell-runtime-unavailable') {
    return t('The Shell runtime was unavailable. The command was not run.')
  }
  if (
    run.shellErrorCode === 'shell-start-failed' ||
    run.shellErrorCode === 'shell-network-transport-unsupported'
  ) {
    return t('The Shell process did not start. The command was not run.')
  }
  if (run.shellErrorCode === 'shell-command-blocked') {
    return t('The Shell command was blocked before execution.')
  }
  if (
    shellFailureLabel({
      status: run.status,
      errorCode: run.shellErrorCode,
      exitCode: run.exitCode
    }) === 'Command failed' &&
    typeof run.exitCode === 'number'
  ) {
    return t('The Shell command exited with code {{code}}.', { code: run.exitCode })
  }
  return t('Shell execution failed. Check the output for details.')
}
