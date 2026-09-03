/* Hallmark · component: message-center · genre: modern-minimal · theme: project-tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (40–41) · pre-emit critique: P5 H5 E5 S5 R5 V4
 */
import { FocusScope } from '@radix-ui/react-focus-scope'
import { Bell, CheckCheck, X } from 'lucide-react'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { NotificationInboxItem } from '../../../shared/notifications'

import { useMediaQuery } from '@/hooks/useMediaQuery'
import { relativeTimeParts } from '@/lib/format-relative-time'
import { sessionWaitReasonLabelKeys } from '@/lib/session-wait-reason-labels'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { openNotificationProject, useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { NotificationErrorBoundary } from './NotificationErrorBoundary'
import { NotificationEventIcon } from './NotificationEventIcon'
import {
  notificationEventToneClasses,
  resolveNotificationEventVisual
} from './notification-event-visual'
import {
  isVisibleNotificationBell,
  NOTIFICATION_CENTER_OPENED_EVENT,
  OPEN_NOTIFICATION_CENTER_EVENT,
  type OpenNotificationCenterDetail
} from './notification-bell-events'
import { presentNotificationInbox } from './notification-inbox-presentation'
import { runNotificationTask } from './notification-safety'

type NotificationBellProps = Readonly<{
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  onOpen?: () => void
}>

const actionLabel = (
  item: NotificationInboxItem,
  t: ReturnType<typeof useTranslation>['t']
): string | undefined => {
  if (item.targetInvalidatedAt !== undefined) return t('Session no longer available')
  if (
    item.actionState === 'pending' &&
    (item.attentionReason === 'waiting-for-user' ||
      item.attentionReason === 'waiting-permission' ||
      item.attentionReason === 'waiting-plan-approval')
  ) {
    return t(sessionWaitReasonLabelKeys[item.attentionReason])
  }
  if (item.attentionReason === 'task-max-tokens') return t('Length limit reached')
  if (item.attentionReason === 'task-max-turn-requests') return t('Turn limit reached')
  if (item.attentionReason === 'task-refusal') return t('Request declined')
  if (item.attentionReason === 'task-unclean-stop') return t('Task stopped unexpectedly')
  if (item.source === 'agent-question') {
    if (item.actionState === 'pending') return t('Needs response')
    if (item.actionState === 'resolved') return t('Answered')
    if (item.actionState === 'rejected') return t('Skipped')
  }
  if (item.actionState === 'pending') return t('Needs approval')
  if (item.actionState === 'expired') return t('Expired')
  if (item.actionState === 'cancelled') return t('Cancelled')
  if (item.actionState === 'rejected') return t('Rejected')
  if (item.actionState === 'resolved') return t('Resolved')
  return undefined
}

const VIEWPORT_MARGIN = 8
const PANEL_GAP = 8
const PANEL_MAX_WIDTH = 440
const MOBILE_MESSAGE_CENTER_QUERY = '(max-width: 47.999rem)'

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum)

const replayPendingApproval = async (item: NotificationInboxItem): Promise<boolean> => {
  if (item.actionState !== 'pending') return false
  if (
    item.source === 'connector' &&
    (item.attentionReason === undefined || item.attentionReason === 'waiting-permission')
  ) {
    const request = await window.api.settings.replayConnectorApproval(item.originId)
    if (!request) return false
    useSettingsStore.getState().enqueueApproval(request)
    return true
  }
  if (item.source === 'compute') {
    const request = await window.api.compute.replayApproval(item.originId)
    if (!request) return false
    useComputeStore.getState().enqueueApproval(request)
    return true
  }
  return false
}

// One shared entry point for Home, desktop Workspace, and the always-visible mobile conversation
// header. The backend owns read state, so multiple rendered bells always converge after one action.
const NotificationBellContent = ({
  className,
  side = 'bottom',
  align = 'end',
  onOpen
}: NotificationBellProps): React.JSX.Element => {
  const { t } = useTranslation()
  const relativeTime = (timestamp: number): string => {
    const { unit, count } = relativeTimeParts(timestamp)
    if (unit === 'now') return t('just now')
    const labels = {
      minute: t('{{count}} minutes ago', { count }),
      hour: t('{{count}} hours ago', { count }),
      day: t('{{count}} days ago', { count }),
      week: t('{{count}} weeks ago', { count }),
      month: t('{{count}} months ago', { count }),
      year: t('{{count}} years ago', { count })
    }
    return labels[unit]
  }
  const [open, setOpen] = useState(false)
  const isMobile = useMediaQuery(MOBILE_MESSAGE_CENTER_QUERY)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const mobileWasOpenRef = useRef(false)
  const previousIsMobileRef = useRef(isMobile)
  const [position, setPosition] = useState<CSSProperties>({
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN
  })
  const panelId = useId()
  const items = useNotificationInboxStore((state) => state.items)
  const unreadCount = useNotificationInboxStore((state) => state.unreadCount)
  const status = useNotificationInboxStore((state) => state.status)
  const error = useNotificationInboxStore((state) => state.error)
  const refresh = useNotificationInboxStore((state) => state.refresh)
  const markRead = useNotificationInboxStore((state) => state.markRead)
  const markAllRead = useNotificationInboxStore((state) => state.markAllRead)
  const sessions = useSessionStore((state) => state.sessions)
  const projects = useProjectStore((state) => state.projects)
  const groups = presentNotificationInbox(items, sessions, projects)

  const updatePanelPosition = useCallback((): void => {
    if (isMobile) return
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return

    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const width = Math.min(PANEL_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
    const height = panelRect.height
    let left = triggerRect.right - width
    let top = triggerRect.bottom + PANEL_GAP

    if (side === 'top' || side === 'bottom') {
      if (align === 'start') left = triggerRect.left
      if (align === 'center') left = triggerRect.left + (triggerRect.width - width) / 2

      const topCandidate = triggerRect.top - PANEL_GAP - height
      const bottomCandidate = triggerRect.bottom + PANEL_GAP
      top = side === 'top' ? topCandidate : bottomCandidate
      if (
        top < VIEWPORT_MARGIN &&
        bottomCandidate + height <= window.innerHeight - VIEWPORT_MARGIN
      ) {
        top = bottomCandidate
      } else if (
        top + height > window.innerHeight - VIEWPORT_MARGIN &&
        topCandidate >= VIEWPORT_MARGIN
      ) {
        top = topCandidate
      }
    } else {
      if (align === 'start') top = triggerRect.top
      if (align === 'center') top = triggerRect.top + (triggerRect.height - height) / 2
      if (align === 'end') top = triggerRect.bottom - height

      const leftCandidate = triggerRect.left - PANEL_GAP - width
      const rightCandidate = triggerRect.right + PANEL_GAP
      left = side === 'left' ? leftCandidate : rightCandidate
      if (left < VIEWPORT_MARGIN && rightCandidate + width <= window.innerWidth - VIEWPORT_MARGIN) {
        left = rightCandidate
      } else if (
        left + width > window.innerWidth - VIEWPORT_MARGIN &&
        leftCandidate >= VIEWPORT_MARGIN
      ) {
        left = leftCandidate
      }
    }

    setPosition({
      left: clamp(left, VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width),
      top: clamp(top, VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - height),
      width
    })
  }, [align, isMobile, side])

  useLayoutEffect(() => {
    if (!open) return
    if (!isMobile) updatePanelPosition()
  }, [isMobile, open, updatePanelPosition])

  useEffect(() => {
    const becameMobile = isMobile && !previousIsMobileRef.current
    previousIsMobileRef.current = isMobile
    if (open && becameMobile) panelRef.current?.focus()
  }, [isMobile, open])

  useEffect(() => {
    if (!open || !isMobile) return
    const previousOverflow = document.body.style.overflow
    const appRoot = document.getElementById('root')
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null
    const previousInert = appRoot?.inert ?? false
    document.body.style.overflow = 'hidden'
    if (appRoot) {
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    return () => {
      document.body.style.overflow = previousOverflow
      if (!appRoot) return
      appRoot.inert = previousInert
      if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden')
      else appRoot.setAttribute('aria-hidden', previousAriaHidden)
    }
  }, [isMobile, open])

  const restoreMobileFocus = useCallback((): void => {
    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      document.contains(activeElement)
    ) {
      return
    }

    const trigger = triggerRef.current
    const returnFocusTarget =
      trigger?.isConnected && !trigger.closest('[inert], [aria-hidden="true"]')
        ? trigger
        : Array.from(
            document.querySelectorAll<HTMLElement>('[data-notification-bell-trigger="true"]')
          ).find(isVisibleNotificationBell)
    returnFocusTarget?.focus()
  }, [])

  useEffect(() => {
    if (open && isMobile) {
      mobileWasOpenRef.current = true
      return
    }
    if (open || !mobileWasOpenRef.current) return
    mobileWasOpenRef.current = false
    restoreMobileFocus()
  }, [isMobile, open, restoreMobileFocus])

  useEffect(() => {
    const openFromLiveToast = (event: Event): void => {
      const trigger = triggerRef.current
      if (!trigger || !isVisibleNotificationBell(trigger)) return
      const requestedBellId = (event as CustomEvent<OpenNotificationCenterDetail>).detail?.bellId
      if (requestedBellId && requestedBellId !== panelId) return
      setOpen(true)
      onOpen?.()
      runNotificationTask(refresh)
    }
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, openFromLiveToast)
    return () => window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, openFromLiveToast)
  }, [onOpen, panelId, refresh])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const reposition = (): void => updatePanelPosition()
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeWithEscape)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, updatePanelPosition])

  const openItem = async (item: NotificationInboxItem): Promise<void> => {
    if (item.targetInvalidatedAt !== undefined) return
    let replayedApproval = false
    try {
      replayedApproval = await replayPendingApproval(item)
    } catch {
      // Replaying an optional approval must not block navigation to the durable task.
    }

    let completed = false
    const completeOpen = (): void => {
      if (completed) return
      completed = true
      setOpen(false)
      if (item.readAt === undefined) runNotificationTask(() => markRead([item.id]))
    }

    try {
      if (item.sessionId) {
        const opened = useNavigationStore
          .getState()
          .openSessionById(item.sessionId, 'notification', completeOpen)
        if (!opened) return
        completeOpen()
      } else if (item.projectId) {
        const opened = await openNotificationProject(item.projectId, completeOpen)
        if (!opened) return
        completeOpen()
      } else if (replayedApproval) {
        completeOpen()
      } else {
        if (item.readAt === undefined) runNotificationTask(() => markRead([item.id]))
        return
      }
    } catch {
      return
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        data-notification-bell-trigger="true"
        data-notification-bell-id={panelId}
        type="button"
        aria-label={
          unreadCount > 0
            ? t('Messages, {{count}} unread', { count: unreadCount })
            : t('Messages, no unread messages')
        }
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const nextOpen = !open
          setOpen(nextOpen)
          if (nextOpen) {
            window.dispatchEvent(new Event(NOTIFICATION_CENTER_OPENED_EVENT))
            onOpen?.()
            runNotificationTask(refresh)
          }
        }}
        className={cn(
          "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] hover:bg-bg-300 hover:text-text-000 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-000 md:before:hidden",
          className
        )}
      >
        <Bell className="size-4" strokeWidth={2} aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive ring-2 ring-bg-000"
            aria-hidden="true"
          />
        ) : null}
      </button>
      {open
        ? createPortal(
            <>
              {isMobile ? (
                <button
                  type="button"
                  aria-label={t('Dismiss messages')}
                  onClick={() => setOpen(false)}
                  className="fixed inset-0 z-[80] bg-black/45 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 active:bg-black/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:animate-none"
                />
              ) : null}
              <FocusScope
                ref={panelRef}
                id={panelId}
                role="dialog"
                aria-label={t('Message center')}
                aria-modal={isMobile || undefined}
                tabIndex={-1}
                style={isMobile ? undefined : position}
                className={cn(
                  'fixed overflow-hidden border border-border-200/70 bg-bg-000 p-0 text-text-000 outline-none',
                  isMobile
                    ? 'inset-x-0 bottom-0 z-[90] flex h-[min(82dvh,760px)] w-full max-w-full flex-col rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] shadow-dialog motion-safe:animate-in motion-safe:slide-in-from-bottom motion-safe:duration-200 motion-reduce:animate-none'
                    : 'z-modal rounded-xl shadow-menu'
                )}
                loop={isMobile}
                trapped={isMobile}
                onMountAutoFocus={(event) => {
                  if (!isMobile) event.preventDefault()
                }}
                onUnmountAutoFocus={(event) => {
                  event.preventDefault()
                  if (mobileWasOpenRef.current) restoreMobileFocus()
                }}
              >
                <div
                  className={cn(
                    'relative flex shrink-0 items-center justify-between border-b border-border-200/60',
                    isMobile ? 'min-h-16 gap-2 px-2 pt-2' : 'h-12 px-3'
                  )}
                >
                  {isMobile ? (
                    <div
                      className="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-border-300"
                      aria-hidden="true"
                    />
                  ) : null}
                  <div className="flex min-w-0 items-center gap-1">
                    {isMobile ? (
                      <button
                        type="button"
                        aria-label={t('Close messages')}
                        onClick={() => setOpen(false)}
                        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-000"
                      >
                        <X className="size-5" strokeWidth={2} aria-hidden="true" />
                      </button>
                    ) : null}
                    <div className="min-w-0">
                      <div className={cn('font-semibold', isMobile ? 'text-base' : 'text-sm')}>
                        {t('Messages')}
                      </div>
                      <div className={cn('text-text-300', isMobile ? 'text-xs' : 'text-[11px]')}>
                        {unreadCount > 0
                          ? t('{{count}} unread', { count: unreadCount })
                          : t('All caught up')}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={unreadCount === 0}
                    onClick={() => runNotificationTask(markAllRead)}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-text-100 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-000 disabled:cursor-default disabled:opacity-40',
                      isMobile ? 'h-11 text-sm' : 'h-8 text-xs'
                    )}
                  >
                    <CheckCheck className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    {t('Mark all read')}
                  </button>
                </div>

                <div
                  className={cn(
                    'overflow-y-auto p-1.5',
                    isMobile ? 'min-h-0 flex-1 px-2 py-2' : 'max-h-[min(28rem,70vh)]'
                  )}
                >
                  {status === 'error' ? (
                    <div className="rounded-lg px-3 py-6 text-center text-xs text-danger-000">
                      {error}
                    </div>
                  ) : items.length === 0 ? (
                    <div className="px-3 py-10 text-center text-sm text-text-300">
                      {status === 'loading' ? t('Loading messages…') : t('No messages yet.')}
                    </div>
                  ) : (
                    groups.map((group) => (
                      <section key={group.key} aria-labelledby={`${panelId}-${group.key}`}>
                        <div
                          id={`${panelId}-${group.key}`}
                          className={cn(
                            'sticky z-10 bg-bg-000 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-300',
                            isMobile ? '-mx-2 -top-2 px-[18px]' : '-mx-1.5 -top-1.5 px-4'
                          )}
                        >
                          {t(group.label)}
                        </div>
                        {group.items.map((presented) => {
                          const item = presented.notification
                          const label = actionLabel(item, t)
                          const eventLabel = label ?? t(item.title)
                          const detail =
                            presented.detailPreview ??
                            (presented.sessionTitle ? undefined : t(item.summary))
                          const contextLabel =
                            presented.projectName ??
                            (item.targetInvalidatedAt !== undefined
                              ? t('Session no longer available')
                              : undefined)
                          const showEventLabel =
                            item.targetInvalidatedAt === undefined &&
                            (presented.sessionTitle !== undefined || label !== undefined)
                          const toneClasses =
                            notificationEventToneClasses[resolveNotificationEventVisual(item).tone]
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => void openItem(item)}
                              disabled={item.targetInvalidatedAt !== undefined}
                              className={cn(
                                'group flex w-full items-start gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-150 ease-out hover:bg-bg-300 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                isMobile ? 'py-2.5' : 'py-2',
                                item.readAt === undefined && 'bg-bg-100/70',
                                item.targetInvalidatedAt !== undefined &&
                                  'cursor-default opacity-60 hover:bg-transparent active:bg-transparent'
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
                                  toneClasses.tile
                                )}
                              >
                                <NotificationEventIcon notification={item} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span
                                  className={cn(
                                    'flex min-w-0 items-center gap-1.5 text-text-300',
                                    isMobile ? 'text-xs' : 'text-[10px]'
                                  )}
                                >
                                  {contextLabel ? (
                                    <span className="min-w-0 flex-1 truncate">{contextLabel}</span>
                                  ) : (
                                    <span className="min-w-0 flex-1" />
                                  )}
                                  <span className="shrink-0 tabular-nums">
                                    {relativeTime(item.createdAt)}
                                  </span>
                                </span>
                                <span className="mt-0.5 flex items-start gap-2">
                                  <span
                                    className={cn(
                                      'min-w-0 flex-1 truncate',
                                      item.readAt === undefined
                                        ? 'font-semibold text-text-000'
                                        : 'font-medium text-text-100',
                                      isMobile ? 'text-sm' : 'text-xs'
                                    )}
                                  >
                                    {presented.sessionTitle ?? t(item.title)}
                                  </span>
                                </span>
                                {detail ? (
                                  <span
                                    className={cn(
                                      'mt-0.5 line-clamp-2 text-text-100',
                                      isMobile ? 'text-sm leading-5' : 'text-[11px] leading-4'
                                    )}
                                  >
                                    {detail}
                                  </span>
                                ) : null}
                                {showEventLabel ? (
                                  <span
                                    className={cn(
                                      'mt-1 inline-flex w-fit items-center rounded-full border px-1.5 py-px font-medium',
                                      isMobile ? 'text-[11px]' : 'text-[10px]',
                                      toneClasses.chip
                                    )}
                                  >
                                    {eventLabel}
                                  </span>
                                ) : null}
                              </span>
                              {item.readAt === undefined ? (
                                <span
                                  className="mt-2 size-1.5 shrink-0 rounded-full bg-destructive"
                                  aria-hidden="true"
                                />
                              ) : null}
                            </button>
                          )
                        })}
                      </section>
                    ))
                  )}
                </div>
              </FocusScope>
            </>,
            document.body
          )
        : null}
    </div>
  )
}

const NotificationBell = (props: NotificationBellProps): React.JSX.Element => (
  <NotificationErrorBoundary>
    <NotificationBellContent {...props} />
  </NotificationErrorBoundary>
)

export { NotificationBell }
