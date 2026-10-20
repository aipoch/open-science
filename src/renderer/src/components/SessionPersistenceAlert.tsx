import { useState } from 'react'
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
  dismissLabel?: string
  onRetry?: () => void
  retryLabel?: string
  onAction?: () => void
  actionLabel?: string
}

const SessionPersistenceAlertContent = ({
  title,
  message,
  variant = 'error',
  inline = false,
  className,
  onDismiss,
  dismissLabel,
  onRetry,
  retryLabel,
  onAction,
  actionLabel
}: SessionPersistenceAlertProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  // A floating warning is not the safety gate. Its owner retains failed targets and local recovery.
  // Inline failures replace unavailable content and must remain visible until recovery succeeds.
  if (!inline && dismissed) return null
  const dismiss = onDismiss ?? (inline ? undefined : () => setDismissed(true))

  // Standalone recovery belongs behind modal backdrops, like the page whose actions they block.
  // Inline alerts and alerts inside ActionToastStack retain their owner's stacking context.
  return (
    <div
      data-testid="session-persistence-alert"
      data-bottom-notice={inline ? undefined : true}
      className={cn(
        inline
          ? 'pointer-events-auto w-full'
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
          dismiss
            ? {
                label: dismissLabel ?? t('Dismiss storage warning'),
                onClick: dismiss,
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

// Reset presentation dismissal only for a changed failure; identical refreshes retain it.
const SessionPersistenceAlert = (props: SessionPersistenceAlertProps): React.JSX.Element => (
  <SessionPersistenceAlertContent
    key={JSON.stringify([props.title, props.message, props.variant])}
    {...props}
  />
)

export { SessionPersistenceAlert }
