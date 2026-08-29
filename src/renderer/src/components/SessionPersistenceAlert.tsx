/* Hallmark · component: storage alert · genre: modern-minimal · theme: project app tokens
 * pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: pass (40–41) · responsive: pass (34, 49, 50–57)
 * interaction states: shared Button contract · alert states: warning · error
 */
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

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
      role="alert"
      data-testid="session-persistence-alert"
      className={`${inline ? 'w-full max-w-md' : 'fixed bottom-3 right-3 z-50 w-[min(420px,calc(100vw-24px))]'} rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-sm ${
        variant === 'warning' ? 'border-border' : 'border-destructive/40'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{message}</p>
        </div>
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('Dismiss storage warning')}
            data-testid="session-persistence-dismiss"
            onClick={onDismiss}
            className="shrink-0"
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {onRetry || (onAction && actionLabel) ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="session-persistence-retry"
              onClick={onRetry}
            >
              {retryLabel ?? t('Retry')}
            </Button>
          ) : null}
          {onAction && actionLabel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="session-persistence-action"
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export { SessionPersistenceAlert }
