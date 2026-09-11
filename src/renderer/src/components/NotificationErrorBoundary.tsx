import { Bell } from 'lucide-react'
import { Component, useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { ErrorNotice } from './error-notice'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  isVisibleNotificationBell,
  OPEN_NOTIFICATION_CENTER_EVENT,
  type OpenNotificationCenterDetail
} from './notification-bell-events'

type Surface = 'center' | 'row' | 'toast'
type NotificationErrorBoundaryProps = Readonly<{
  children: ReactNode
  surface?: Surface
  className?: string
}>
type NotificationErrorBoundaryState = Readonly<{ failed: boolean }>

const NotificationRecovery = ({
  surface,
  className,
  reset
}: {
  surface: Surface
  className?: string
  reset: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const id = useId()
  useEffect(() => {
    if (surface !== 'center') return
    const openCenter = (event: Event): void => {
      const trigger = document.getElementById(id)
      const requestedId = (event as CustomEvent<OpenNotificationCenterDetail>).detail?.bellId
      if (trigger && isVisibleNotificationBell(trigger) && (!requestedId || requestedId === id)) {
        setOpen(true)
      }
    }
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, openCenter)
    return () => window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, openCenter)
  }, [id, surface])

  const notice = (
    <ErrorNotice
      role="alert"
      title={
        surface === 'row'
          ? t('This message could not be displayed.')
          : t('Messages could not be displayed.')
      }
      description={t('Retry reloads messages. It does not approve or reject requests.')}
      primaryButton={{
        label: t('Retry'),
        loading: retrying,
        onClick: () => {
          if (retrying) return
          setRetrying(true)
          // Only reload presentation state. Never replay or settle a business action here.
          void Promise.resolve()
            .then(() => useNotificationInboxStore.getState().refresh())
            .catch(() => undefined)
            .finally(reset)
        }
      }}
    />
  )
  if (surface !== 'center') {
    return (
      <div
        className={
          surface === 'toast'
            ? 'fixed bottom-4 right-4 z-[75] max-h-[80dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto'
            : 'my-1 min-w-0'
        }
      >
        {notice}
      </div>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          data-notification-bell-trigger="true"
          data-notification-bell-id={id}
          aria-label={t('Messages unavailable')}
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-status-warning-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          <Bell className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('Message center')}
        className="z-[90] max-h-[80dvh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto bg-bg-000 p-0 text-text-000"
        collisionPadding={8}
      >
        {notice}
      </PopoverContent>
    </Popover>
  )
}

// Notifications are best-effort. A failed row must not hide siblings or pending approvals.
class NotificationErrorBoundary extends Component<
  NotificationErrorBoundaryProps,
  NotificationErrorBoundaryState
> {
  state: NotificationErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): NotificationErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(): void {
    // Never inspect the exception, component stack, notification identity or payload.
    try {
      console.warn('[notifications] render-failed')
    } catch {
      /* Diagnostics are best-effort. */
    }
  }

  render(): ReactNode {
    return this.state.failed ? (
      <NotificationRecovery
        surface={this.props.surface ?? 'row'}
        className={this.props.className}
        reset={() => this.setState({ failed: false })}
      />
    ) : (
      this.props.children
    )
  }
}

export { NotificationErrorBoundary }
