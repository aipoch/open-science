import { Button } from '@/components/ui/button'

type SessionPersistenceAlertProps = {
  title: string
  message: string
  variant?: 'error' | 'warning'
  inline?: boolean
  onRetry?: () => void
}

const SessionPersistenceAlert = ({
  title,
  message,
  variant = 'error',
  inline = false,
  onRetry
}: SessionPersistenceAlertProps): React.JSX.Element => (
  <div
    role="alert"
    data-testid="session-persistence-alert"
    className={`${inline ? 'flex w-full max-w-md' : 'fixed bottom-3 right-3 z-50 flex w-[min(420px,calc(100vw-24px))]'} items-start gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-sm ${
      variant === 'warning' ? 'border-border' : 'border-destructive/40'
    }`}
  >
    <div className="min-w-0 flex-1">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{message}</p>
    </div>
    {onRetry ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="session-persistence-retry"
        onClick={onRetry}
        className="shrink-0"
      >
        Retry
      </Button>
    ) : null}
  </div>
)

export { SessionPersistenceAlert }
