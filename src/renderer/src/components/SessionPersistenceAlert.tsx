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
    className={`${inline ? 'flex w-full max-w-md' : 'fixed bottom-3 right-3 z-50 flex w-[min(420px,calc(100vw-24px))]'} items-start gap-3 rounded-xl border bg-bg-100 p-4 text-sm text-text-100 shadow-dialog ${
      variant === 'warning'
        ? 'border-amber-300 dark:border-amber-700/70'
        : 'border-red-200 dark:border-red-800/60'
    }`}
  >
    <div className="min-w-0 flex-1">
      <p className="font-medium text-text-000">{title}</p>
      <p className="mt-1 break-words text-xs leading-5 text-text-300">{message}</p>
    </div>
    {onRetry ? (
      <button
        type="button"
        data-testid="session-persistence-retry"
        onClick={onRetry}
        className="shrink-0 rounded-lg border border-border-200 px-2.5 py-1 text-xs font-medium text-text-000 hover:bg-bg-200"
      >
        Retry
      </button>
    ) : null}
  </div>
)

export { SessionPersistenceAlert }
