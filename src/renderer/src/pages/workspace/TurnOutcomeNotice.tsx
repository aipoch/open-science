import { ChevronRight, Flag, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TurnOutcome } from '../../../../shared/session-persistence'
import { isReportableRunFailure } from '../../../../shared/run-error-classification'
import {
  isCodexCliCompatibilityError,
  isUnsupportedCodexAcpVersionError
} from '../../../../shared/codex-runtime'
import { SessionInterruptedBanner } from './SessionInterruptedBanner'

type TurnOutcomeActions = {
  resumePromptMessageId?: string
  canResume: boolean
  isResuming: boolean
  isDisabled: boolean
  onResume: () => void
  artifactRetryingPromptMessageId?: string
  artifactRetryDisabled: boolean
  onRetryArtifact: (promptMessageId: string) => void
  onReportError: (error: string) => void
  resolveError: (error: string | undefined) => string
  settingsAction?: (error: string | undefined) => { label: string; onClick: () => void } | undefined
}

const TurnOutcomeNotice = ({
  promptMessageId,
  outcome,
  actions
}: {
  promptMessageId: string
  outcome: Exclude<TurnOutcome, { kind: 'completed' }>
  actions: TurnOutcomeActions
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  // Ordinary terminal write exhaustion belongs to the existing global storage alert.
  if (outcome.kind === 'interrupted' && outcome.cause === 'terminal-commit-failed') return null
  if (outcome.kind === 'interrupted' || outcome.kind === 'cancelled') {
    const message =
      outcome.kind === 'cancelled'
        ? t('This turn was interrupted. Resume to continue.')
        : outcome.error
          ? actions.resolveError(outcome.error)
          : outcome.cause === 'connection-lost'
            ? t('Connection lost — Resume to reconnect and continue.')
            : t('Session was interrupted before the app closed.')
    const ownsRecovery = actions.resumePromptMessageId === promptMessageId
    return (
      <div data-slot="turn-outcome-notice" data-prompt-message-id={promptMessageId}>
        <SessionInterruptedBanner
          message={message}
          showResume={ownsRecovery}
          isDisabled={!actions.canResume || actions.isDisabled}
          isResuming={ownsRecovery && actions.isResuming}
          onResume={actions.onResume}
        />
      </div>
    )
  }

  const error = actions.resolveError(outcome.error)
  const canRetryArtifact = outcome.recovery === 'retry-artifact-publication'
  const retrying = actions.artifactRetryingPromptMessageId === promptMessageId
  const canReport =
    !isUnsupportedCodexAcpVersionError(outcome.error) &&
    !isCodexCliCompatibilityError(outcome.error) &&
    (outcome.errorReportable ?? isReportableRunFailure(outcome.error))
  const settingsAction = actions.settingsAction?.(outcome.error)
  return (
    <div
      role="alert"
      data-slot="turn-outcome-notice"
      data-prompt-message-id={promptMessageId}
      className="mb-2 flex flex-col gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300"
    >
      <span className="min-w-0 break-words">{error}</span>
      {canRetryArtifact || canReport || settingsAction ? (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {canRetryArtifact ? (
            <button
              type="button"
              onClick={() => actions.onRetryArtifact(promptMessageId)}
              disabled={actions.artifactRetryDisabled}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
              aria-label={t('Retry Artifact publication')}
            >
              {retrying ? (
                <Loader2 className="size-3 animate-spin" strokeWidth={2.2} aria-hidden="true" />
              ) : null}
              {t('Retry Artifact publication')}
            </button>
          ) : null}
          {canReport ? (
            <button
              type="button"
              onClick={() => actions.onReportError(error)}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
              aria-label={t('Report this error')}
            >
              <Flag className="size-3" strokeWidth={2.2} aria-hidden="true" />
              {t('Report error')}
            </button>
          ) : null}
          {settingsAction ? (
            <button
              type="button"
              onClick={settingsAction.onClick}
              className="inline-flex h-6 items-center rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              {settingsAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const HistoricalTurnOutcome = ({
  promptMessageId,
  outcome,
  actions
}: {
  promptMessageId: string
  outcome: Extract<TurnOutcome, { kind: 'failed' }>
  actions: TurnOutcomeActions
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <details
      data-slot="historical-turn-outcome"
      data-prompt-message-id={promptMessageId}
      className="group mb-2"
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md bg-status-failure-surface px-1.5 py-0.5 text-[11px] font-medium text-status-failure-foreground focus-visible:keyboard-focus dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 transition-transform group-open:rotate-90"
          strokeWidth={2.2}
          aria-hidden="true"
        />
        {t('Failed')}
      </summary>
      <div className="mt-1.5">
        <TurnOutcomeNotice promptMessageId={promptMessageId} outcome={outcome} actions={actions} />
      </div>
    </details>
  )
}

export { HistoricalTurnOutcome, TurnOutcomeNotice }
export type { TurnOutcomeActions }
