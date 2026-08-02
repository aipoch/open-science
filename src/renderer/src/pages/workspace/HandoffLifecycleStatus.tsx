import { Button } from '@/components/ui/button'
import { useState } from 'react'

import type { HandoffTranscriptProjection } from './handoff-lifecycle-projection'

const targetLabel = (target: HandoffTranscriptProjection['target']): string =>
  target.kind === 'main' ? 'Main Agent' : target.name

const statusCopy = (handoff: HandoffTranscriptProjection): string => {
  const target = targetLabel(handoff.target)

  switch (handoff.phase) {
    case 'awaiting-approval':
      return `Awaiting approval to switch to ${target}`
    case 'switching':
      return `Switching to ${target}`
    case 'reconfiguring':
      return `Reconfiguring ${target}`
    case 'continuation-start':
      return `Starting continuation with ${target}`
    case 'continued':
      return `Continued with ${target}`
    case 'failed':
      return `Could not continue with ${target}`
  }
}

const HandoffLifecycleStatus = ({
  handoff,
  onRetry
}: {
  handoff: HandoffTranscriptProjection
  onRetry?: () => Promise<void>
}): React.JSX.Element => {
  const isFailure = handoff.phase === 'failed'
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | undefined>()

  const retry = async (): Promise<void> => {
    if (!onRetry || isRetrying) return
    setIsRetrying(true)
    setRetryError(undefined)
    try {
      await onRetry()
    } catch {
      setRetryError('Retry could not start. The saved handoff remains available.')
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
      <span className="font-medium text-foreground">{statusCopy(handoff)}</span>
      {handoff.phase === 'continued' ? (
        <span className="ml-1">The original task continues in this turn.</span>
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
          {isRetrying ? 'Retrying…' : 'Retry handoff'}
        </Button>
      ) : null}
      {isFailure && retryError ? <span className="ml-1">{retryError}</span> : null}
    </div>
  )
}

export { HandoffLifecycleStatus }
