import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TurnOutcome } from '../../../../shared/session-persistence'
import { ComposerNoticeSlot } from '@/components/composer-notice/ComposerNoticeSlot'

type TurnOutcomeActions = {
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
  if (outcome.kind !== 'failed') return null
  const failure = {
    ...(outcome.failure ?? { category: 'internal' as const }),
    diagnostics: {
      ...outcome.failure?.diagnostics,
      raw: outcome.failure?.diagnostics.raw ?? outcome.error
    }
  }
  return (
    <div data-slot="turn-outcome-notice" data-prompt-message-id={promptMessageId}>
      <ComposerNoticeSlot
        notices={[
          {
            id: promptMessageId,
            source: 'turn',
            occurredAt: outcome.settledAt,
            failure,
            promptMessageId,
            recovery: outcome.recovery
          }
        ]}
        handlers={{
          report: { run: () => actions.onReportError(actions.resolveError(outcome.error)) },
          ...(outcome.recovery === 'retry-artifact-publication'
            ? {
                retry: {
                  run: () => actions.onRetryArtifact(promptMessageId),
                  disabled: () =>
                    actions.artifactRetryDisabled ||
                    actions.artifactRetryingPromptMessageId === promptMessageId
                }
              }
            : {}),
          ...(actions.settingsAction?.(outcome.error)
            ? {
                'open-provider-settings': {
                  run: () => actions.settingsAction?.(outcome.error)?.onClick()
                }
              }
            : {})
        }}
      />
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
