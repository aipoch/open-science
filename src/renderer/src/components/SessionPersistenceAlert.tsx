import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'

type SessionPersistenceAlertProps = {
  title: string
  message: string
  variant?: 'error' | 'warning'
  inline?: boolean
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
  onDismiss,
  onRetry,
  retryLabel,
  onAction,
  actionLabel
}: SessionPersistenceAlertProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-testid="session-persistence-alert"
      className={
        inline
          ? 'pointer-events-auto w-full max-w-md'
          : 'pointer-events-auto fixed bottom-3 right-3 z-toast w-[min(420px,calc(100vw-24px))] max-h-[calc(100svh-24px)] overflow-y-auto shadow-sm'
      }
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
