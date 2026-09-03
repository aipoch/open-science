import { X } from 'lucide-react'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openNotificationProject, useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { NotificationErrorBoundary } from './NotificationErrorBoundary'
import { NotificationEventIcon } from './NotificationEventIcon'
import {
  isVisibleNotificationBell,
  NOTIFICATION_CENTER_OPENED_EVENT,
  OPEN_NOTIFICATION_CENTER_EVENT,
  type OpenNotificationCenterDetail
} from './notification-bell-events'
import {
  notificationEventToneClasses,
  resolveNotificationEventVisual
} from './notification-event-visual'
import {
  presentNotificationInbox,
  type PresentedNotificationInboxItem
} from './notification-inbox-presentation'
import { runNotificationTask } from './notification-safety'

const AUTO_DISMISS_MS = 6000
const TOAST_GAP = 8
const VIEWPORT_MARGIN = 8
const TOAST_MAX_WIDTH = 320

type LiveNotice = Readonly<{
  lead: PresentedNotificationInboxItem
  count: number
}>

type ToastPosition = Readonly<{
  placement: 'above' | 'below'
  style: CSSProperties
  arrowLeft: number
}>

const visibleBell = (): HTMLButtonElement | undefined => {
  try {
    return [
      ...document.querySelectorAll<HTMLButtonElement>('[data-notification-bell-trigger="true"]')
    ]
      .filter(isVisibleNotificationBell)
      .sort(
        (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom
      )[0]
  } catch {
    return undefined
  }
}

const openVisibleNotificationCenter = (): void => {
  try {
    const anchor = visibleBell()
    if (!anchor) return
    window.dispatchEvent(
      new CustomEvent<OpenNotificationCenterDetail>(OPEN_NOTIFICATION_CENTER_EVENT, {
        detail: { bellId: anchor.dataset.notificationBellId }
      })
    )
  } catch {
    // The durable inbox remains available if its transient cross-component event cannot dispatch.
  }
}

const NotificationLiveToastContent = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const status = useNotificationInboxStore((state) => state.status)
  const latestSequence = useNotificationInboxStore((state) => state.latestSequence)
  const items = useNotificationInboxStore((state) => state.items)
  const markRead = useNotificationInboxStore((state) => state.markRead)
  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const projects = useProjectStore((state) => state.projects)
  const view = useNavigationStore((state) => state.view)
  const [notice, setNotice] = useState<LiveNotice>()
  const [paused, setPaused] = useState(false)
  const [position, setPosition] = useState<ToastPosition>()
  const baselineSequenceRef = useRef<number | undefined>(undefined)
  const toastRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (status !== 'ready') return
    if (baselineSequenceRef.current === undefined) {
      baselineSequenceRef.current = latestSequence
      return
    }

    const previousSequence = baselineSequenceRef.current
    baselineSequenceRef.current = Math.max(previousSequence, latestSequence)
    let windowHasFocus = false
    try {
      windowHasFocus = document.hasFocus()
    } catch {
      return
    }
    if (latestSequence <= previousSequence || !windowHasFocus) return

    const activeSessionId = view === 'workspace' ? selectedSessionId : undefined
    const added = items.filter(
      (item) =>
        item.sequence > previousSequence &&
        item.readAt === undefined &&
        item.targetInvalidatedAt === undefined &&
        item.sessionId !== activeSessionId
    )
    if (added.length === 0) return

    setNotice((current) => {
      const candidates = current ? [current.lead.notification, ...added] : added
      const lead = presentNotificationInbox(candidates, sessions, projects)[0]?.items[0]
      if (!lead) return current
      return {
        lead,
        count: (current?.count ?? 0) + added.length
      }
    })
  }, [items, latestSequence, projects, selectedSessionId, sessions, status, view])

  useEffect(() => {
    const dismiss = (): void => setNotice(undefined)
    window.addEventListener(NOTIFICATION_CENTER_OPENED_EVENT, dismiss)
    return () => window.removeEventListener(NOTIFICATION_CENTER_OPENED_EVENT, dismiss)
  }, [])

  useEffect(() => {
    if (!notice || paused) return
    const timeout = window.setTimeout(() => setNotice(undefined), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timeout)
  }, [notice, paused])

  const updatePosition = useCallback((): void => {
    try {
      const anchor = visibleBell()
      const toast = toastRef.current
      if (!anchor || !toast) {
        setPosition(undefined)
        return
      }

      const anchorRect = anchor.getBoundingClientRect()
      const toastRect = toast.getBoundingClientRect()
      const width = Math.max(0, Math.min(TOAST_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2))
      const left = Math.min(
        Math.max(anchorRect.left + anchorRect.width / 2 - width / 2, VIEWPORT_MARGIN),
        window.innerWidth - VIEWPORT_MARGIN - width
      )
      const above = anchorRect.top - TOAST_GAP - toastRect.height
      const placement = above >= VIEWPORT_MARGIN ? 'above' : 'below'
      const top = placement === 'above' ? above : anchorRect.bottom + TOAST_GAP
      const arrowLeft = Math.min(
        Math.max(anchorRect.left + anchorRect.width / 2 - left - 4, 16),
        width - 24
      )

      setPosition({ placement, style: { left, top, width }, arrowLeft })
    } catch {
      setPosition(undefined)
    }
  }, [])

  useLayoutEffect(() => {
    if (!notice) return
    const frame = window.requestAnimationFrame(updatePosition)
    return () => window.cancelAnimationFrame(frame)
  }, [notice, updatePosition, view])

  useEffect(() => {
    if (!notice) return
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [notice, updatePosition])

  if (!notice) return null

  const { notification, projectName, sessionTitle, detailPreview } = notice.lead
  const openLead = async (): Promise<void> => {
    let completed = false
    const completeOpen = (): void => {
      if (completed) return
      completed = true
      if (notification.readAt === undefined) {
        runNotificationTask(() => markRead([notification.id]))
      }
      setNotice((current) =>
        current?.lead.notification.id === notification.id ? undefined : current
      )
    }
    let opened = true
    try {
      if (notification.sessionId) {
        opened = useNavigationStore
          .getState()
          .openSessionById(notification.sessionId, 'notification', completeOpen)
      } else if (notification.projectId) {
        opened = await openNotificationProject(notification.projectId, completeOpen)
      } else {
        openVisibleNotificationCenter()
      }
    } catch {
      // Keep the durable inbox entry unread when its target cannot be opened.
      return
    }
    if (!opened) return
    completeOpen()
  }

  return (
    <div
      ref={toastRef}
      role="status"
      data-testid="notification-live-toast"
      data-placement={position?.placement}
      style={
        position?.style ?? {
          width: Math.min(TOAST_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
        }
      }
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false)
      }}
      className={cn(
        'fixed z-[75] rounded-xl border border-border-200/80 bg-bg-000 p-3 text-text-000 shadow-dialog motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none',
        !position && 'invisible'
      )}
    >
      <span
        aria-hidden="true"
        style={{ left: position?.arrowLeft }}
        className={cn(
          'absolute size-2 rotate-45 border-border-200/80 bg-bg-000',
          position?.placement === 'above'
            ? '-bottom-[5px] border-b border-r'
            : '-top-[5px] border-l border-t'
        )}
      />
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
            notificationEventToneClasses[resolveNotificationEventVisual(notification).tone].tile
          )}
        >
          <NotificationEventIcon notification={notification} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {sessionTitle ?? t(notification.title)}
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-300">
            {[t(notification.title), projectName].filter(Boolean).join(' · ')}
          </span>
          {detailPreview ? (
            <span className="mt-1 block truncate text-xs leading-4 text-text-100">
              {detailPreview}
            </span>
          ) : null}
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('Close')}
                onClick={() => setNotice(undefined)}
                className="-mr-1 -mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('Close')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-9">
        <button
          type="button"
          onClick={openLead}
          className="inline-flex h-7 items-center rounded-md border border-border-200 bg-bg-100 px-2.5 text-xs font-medium text-text-000 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {t('Open')}
        </button>
        {notice.count > 1 ? (
          <button
            type="button"
            onClick={() => {
              openVisibleNotificationCenter()
              setNotice(undefined)
            }}
            className="truncate rounded-sm text-xs text-text-300 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t('{{count}} more messages', {
              count: notice.count - 1,
              defaultValue_one: '{{count}} more message'
            })}
          </button>
        ) : null}
      </div>
    </div>
  )
}

const NotificationLiveToast = (): React.JSX.Element => (
  <NotificationErrorBoundary>
    <NotificationLiveToastContent />
  </NotificationErrorBoundary>
)

export { NotificationLiveToast }
