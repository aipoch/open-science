import { Bell, CheckCheck, CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react'
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

import type { NotificationInboxItem } from '../../../shared/notifications'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'

type NotificationBellProps = Readonly<{
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}>

const iconFor = (item: NotificationInboxItem): React.JSX.Element => {
  if (item.kind === 'authorization.required') {
    return <ShieldCheck className="size-4" strokeWidth={2} aria-hidden="true" />
  }
  if (item.kind === 'task.completed') {
    return <CircleCheck className="size-4" strokeWidth={2} aria-hidden="true" />
  }
  return <CircleAlert className="size-4" strokeWidth={2} aria-hidden="true" />
}

const actionLabel = (item: NotificationInboxItem): string | undefined => {
  if (item.actionState === 'pending') return 'Needs approval'
  if (item.actionState === 'expired') return 'Expired'
  if (item.actionState === 'cancelled') return 'Cancelled'
  if (item.actionState === 'resolved') return 'Resolved'
  return undefined
}

const VIEWPORT_MARGIN = 8
const PANEL_GAP = 8
const PANEL_MAX_WIDTH = 368

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum)

// One shared entry point for Home, desktop Workspace, and the always-visible mobile conversation
// header. The backend owns read state, so multiple rendered bells always converge after one action.
const NotificationBell = ({
  className,
  side = 'bottom',
  align = 'end'
}: NotificationBellProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
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

  const updatePanelPosition = useCallback((): void => {
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
  }, [align, side])

  useLayoutEffect(() => {
    if (open) updatePanelPosition()
  }, [open, updatePanelPosition])

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
    if (item.readAt === undefined) await markRead([item.id])
    if (item.sessionId) {
      useNavigationStore.getState().openSessionById(item.sessionId, 'notification')
      setOpen(false)
    } else if (item.projectId) {
      useNavigationStore.getState().openProject(item.projectId, 'notification')
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={
          unreadCount > 0 ? `Messages, ${unreadCount} unread` : 'Messages, no unread messages'
        }
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const nextOpen = !open
          setOpen(nextOpen)
          if (nextOpen) void refresh()
        }}
        className={cn(
          'relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000',
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
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Message center"
              style={position}
              className="fixed z-modal overflow-hidden rounded-xl border border-border-200/70 bg-bg-000 p-0 text-text-000 shadow-menu"
            >
              <div className="flex h-12 items-center justify-between border-b border-border-200/60 px-3">
                <div>
                  <div className="text-sm font-semibold">Messages</div>
                  <div className="text-[11px] text-text-300">
                    {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={unreadCount === 0}
                  onClick={() => void markAllRead()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-100 hover:bg-bg-300 hover:text-text-000 disabled:cursor-default disabled:opacity-40"
                >
                  <CheckCheck className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  Mark all read
                </button>
              </div>

              <div className="max-h-[min(28rem,70vh)] overflow-y-auto p-1.5">
                {status === 'error' ? (
                  <div className="rounded-lg px-3 py-6 text-center text-xs text-danger-000">
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <div className="px-3 py-10 text-center text-sm text-text-300">
                    {status === 'loading' ? 'Loading messages…' : 'No messages yet.'}
                  </div>
                ) : (
                  items.map((item) => {
                    const label = actionLabel(item)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => void openItem(item)}
                        className={cn(
                          'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-bg-300',
                          item.readAt === undefined && 'bg-bg-100/70'
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-bg-300 text-text-100',
                            item.kind === 'authorization.required' && 'text-session-waiting',
                            item.kind === 'task.failed' && 'text-danger-000'
                          )}
                        >
                          {iconFor(item)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-000">
                              {item.title}
                            </span>
                            <span className="shrink-0 text-[10px] text-text-300">
                              {formatRelativeTime(item.createdAt)}
                            </span>
                          </span>
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-text-100">
                            {item.summary}
                          </span>
                          {label ? (
                            <span className="mt-1 inline-flex rounded bg-bg-300 px-1.5 py-0.5 text-[10px] text-text-100">
                              {label}
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
                  })
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export { NotificationBell }
