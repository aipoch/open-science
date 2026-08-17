import { Button } from '@/components/ui/button'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { HandoffTranscriptProjection } from './handoff-lifecycle-projection'

const targetLabel = (target: HandoffTranscriptProjection['target']): string =>
  target.kind === 'main' ? 'Main Agent' : target.name

const statusCopy = (handoff: HandoffTranscriptProjection, t: TFunction): string => {
  const target = targetLabel(handoff.target)

  switch (handoff.phase) {
    case 'awaiting-approval':
      return t('Awaiting approval to switch to {{target}}', { target })
    case 'switching':
      return t('Switching to {{target}}', { target })
    case 'reconfiguring':
      return t('Reconfiguring {{target}}', { target })
    case 'continuation-start':
      return t('Starting continuation with {{target}}', { target })
    case 'continued':
      return t('Continued with {{target}}', { target })
    case 'failed':
      return t('Could not continue with {{target}}', { target })
  }
}

const HandoffLifecycleStatus = ({
  handoff,
  onRetry
}: {
  handoff: HandoffTranscriptProjection
  onRetry?: () => Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()

  const isFailure = handoff.phase === 'failed'
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryError, setRetryError] = useState(false)

  const retry = async (): Promise<void> => {
    if (!onRetry || isRetrying) return
    setIsRetrying(true)
    setRetryError(false)
    try {
      await onRetry()
    } catch {
      setRetryError(true)
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div
      data-handoff-lifecycle=""
      data-originating-turn-id={handoff.originatingTurnId}
      data-originating-user-message-id={handoff.originatingUserMessageId}
      data-handoff-phase={handoff.phase}
      role={isFailure ? 'alert' : 'status'}
      aria-live={isFailure ? 'assertive' : 'polite'}
      className={
        isFailure
          ? 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
          : 'rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground'
      }
    >
      <span className="font-medium text-foreground">{statusCopy(handoff, t)}</span>
      {handoff.phase === 'continued' ? (
        <span className="ml-1">{t('The original task continues in this turn.')}</span>
      ) : null}
      {handoff.failure ? <span className="ml-1">{handoff.failure.message}</span> : null}
      {isFailure && onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-2"
          disabled={isRetrying}
          onClick={() => void retry()}
        >
          {isRetrying ? t('Retrying…') : t('Retry handoff')}
        </Button>
      ) : null}
      {isFailure && retryError ? (
        <span className="ml-1">
          {t('Retry could not start. The saved handoff remains available.')}
        </span>
      ) : null}
    </div>
  )
}

export { HandoffLifecycleStatus }
