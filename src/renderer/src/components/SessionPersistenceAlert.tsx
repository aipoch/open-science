import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { ErrorNotice } from '@/components/error-notice'

type SessionPersistenceAlertProps = {
  title: string
  message: string
  variant?: 'error' | 'warning'
  inline?: boolean
  className?: string
  onDismiss?: () => void
  onRetry?: () => void
  retryLabel?: string
  onAction?: () => void
  actionLabel?: string
}

const SessionPersistenceAlert = ({
  title,
  message,
  variant = 'error',
  inline = false,
  className,
  onDismiss,
  onRetry,
  retryLabel,
  onAction,
  actionLabel
}: SessionPersistenceAlertProps): React.JSX.Element => {
  const { t } = useTranslation()

  // Standalone recovery belongs behind modal backdrops, like the page whose actions they block.
  // Inline alerts and alerts inside ActionToastStack retain their owner's stacking context.
  return (
    <div
      data-testid="session-persistence-alert"
      data-bottom-notice={inline ? undefined : true}
      className={cn(
        inline
          ? 'pointer-events-auto w-full max-w-md'
          : 'pointer-events-auto fixed bottom-3 right-3 z-toast w-[min(420px,calc(100vw-24px))] max-h-[calc(100svh-24px)] overflow-y-auto shadow-sm',
        className
      )}
    >
      <ErrorNotice
        role="alert"
        tone={variant === 'warning' ? 'amber' : 'red'}
        title={title}
        description={message}
        dismissButton={
          onDismiss
            ? {
                label: t('Dismiss storage warning'),
                onClick: onDismiss,
                testId: 'session-persistence-dismiss'
              }
            : undefined
        }
        primaryButton={
          onRetry
            ? {
                label: retryLabel ?? t('Retry'),
                onClick: onRetry,
                testId: 'session-persistence-retry'
              }
            : undefined
        }
        secondaryButton={
          onAction && actionLabel
            ? { label: actionLabel, onClick: onAction, testId: 'session-persistence-action' }
            : undefined
        }
      />
    </div>
  )
}

export { SessionPersistenceAlert }
