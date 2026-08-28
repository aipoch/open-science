import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SESSION_DETAILS_TITLE_MAX_LENGTH } from '../../../../shared/session-persistence'

const SESSION_HOVER_PREVIEW_DELAY_MS = 0
// Radix-internal close grace while the pointer crosses from the row onto the card; the explicit
// pointer-leave handlers below still close the card as soon as the hover region is left for good.
const SESSION_HOVER_PREVIEW_SKIP_DELAY_MS = 300
// align="start" anchors the card's top edge to the trigger's top edge; the trigger is the whole
// session row (py-1.5) and the card adds 1px border + p-4, so shift the card up to land the card
// title on the same baseline as the hovered row title (Popper rounds subpixels, hence -12 for the
// 11px design offset). For a title-only card this also centers the card vertically on the row.
const SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX = -12

type SessionPreviewContent = {
  title: string
  description?: string
}
type SessionPreviewDetails = SessionPreviewContent & { id: string }
type SessionPreviewRequest = (sessionId: string) => Promise<void> | void
type SessionRenameRequest = (title: string) => void

type SessionHoverPreviewContextValue = {
  activeSessionId: string | null
  closeNow: (sessionId: string) => void
  requestOpen: (sessionId: string) => void
}

const SessionHoverPreviewContext = createContext<SessionHoverPreviewContextValue | null>(null)

const SessionHoverPreviewProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)

  const requestOpen = useCallback((sessionId: string): void => {
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
  }, [])

  const closeNow = useCallback((sessionId: string): void => {
    if (activeSessionIdRef.current !== sessionId) return

    activeSessionIdRef.current = null
    setActiveSessionId(null)
  }, [])

  const value = useMemo(
    () => ({ activeSessionId, closeNow, requestOpen }),
    [activeSessionId, closeNow, requestOpen]
  )

  return (
    <SessionHoverPreviewContext.Provider value={value}>
      {children}
    </SessionHoverPreviewContext.Provider>
  )
}

const SessionTitleMarquee = ({
  title,
  className
}: {
  title: string
  className?: string
}): React.JSX.Element => {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const animationRef = useRef<Animation>(undefined)

  useEffect(() => {
    const trigger = viewportRef.current?.closest('button')
    const stop = (): void => {
      animationRef.current?.cancel()
      animationRef.current = undefined
    }
    const start = (): void => {
      stop()
      const viewport = viewportRef.current
      const content = contentRef.current
      if (
        !viewport ||
        !content ||
        content.scrollWidth <= viewport.clientWidth ||
        typeof content.animate !== 'function' ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return
      }

      const overflow = content.scrollWidth - viewport.clientWidth
      animationRef.current = content.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${overflow}px)` }],
        {
          delay: 300,
          duration: overflow * 35,
          easing: 'linear',
          fill: 'forwards'
        }
      )
    }

    trigger?.addEventListener('pointerenter', start)
    trigger?.addEventListener('pointerleave', stop)
    return () => {
      trigger?.removeEventListener('pointerenter', start)
      trigger?.removeEventListener('pointerleave', stop)
      stop()
    }
  }, [])

  return (
    <span
      ref={viewportRef}
      data-slot="session-title-marquee"
      className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', className)}
    >
      <span ref={contentRef} className="inline-block min-w-max">
        {title}
      </span>
    </span>
  )
}

const sessionHoverPreviewTitleClassName = 'truncate text-sm font-semibold leading-5'

// Click-to-edit title for the hover card. Enter or blur commits a non-empty trimmed title,
// Escape cancels; editing state is mirrored to the parent so the card stays open mid-edit.
const SessionHoverPreviewTitle = ({
  title,
  canRename,
  onRenameTitle,
  onEditingChange
}: {
  title: string
  canRename: boolean
  onRenameTitle?: SessionRenameRequest
  onEditingChange?: (editing: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const updateEditing = useCallback(
    (next: boolean): void => {
      editingRef.current = next
      setEditing(next)
      onEditingChange?.(next)
    },
    [onEditingChange]
  )

  const commit = useCallback((): void => {
    if (!editingRef.current) return
    const nextTitle = inputRef.current?.value.trim() ?? ''
    updateEditing(false)
    if (nextTitle && nextTitle !== title) onRenameTitle?.(nextTitle)
  }, [onRenameTitle, title, updateEditing])

  if (!canRename) {
    return <p className={sessionHoverPreviewTitleClassName}>{title}</p>
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        defaultValue={title}
        autoFocus
        maxLength={SESSION_DETAILS_TITLE_MAX_LENGTH}
        aria-label={t('Session title')}
        className="h-auto rounded-sm px-1 py-0 text-sm font-semibold leading-5"
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            return
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            updateEditing(false)
          }
        }}
        onBlur={commit}
      />
    )
  }

  return (
    <button
      type="button"
      data-slot="session-hover-preview-title-button"
      aria-label={t('Rename session title')}
      className={cn(
        'block w-full cursor-pointer rounded-sm text-left outline-none',
        'hover:bg-bg-300 focus-visible:ring-2 focus-visible:ring-ring',
        sessionHoverPreviewTitleClassName
      )}
      onClick={() => updateEditing(true)}
    >
      {title}
    </button>
  )
}

const SessionHoverPreviewCard = ({
  session,
  descriptionLoading = false,
  canRename = false,
  onRenameTitle,
  onEditingChange,
  className
}: {
  session: SessionPreviewContent
  descriptionLoading?: boolean
  canRename?: boolean
  onRenameTitle?: SessionRenameRequest
  onEditingChange?: (editing: boolean) => void
  className?: string
}): React.JSX.Element => {
  const description = session.description?.trim()

  return (
    <div
      data-slot="session-hover-preview"
      aria-busy={descriptionLoading || undefined}
      className={cn(
        'w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-dialog',
        'max-h-[min(24rem,calc(100vh-1rem))]',
        className
      )}
    >
      <SessionHoverPreviewTitle
        title={session.title}
        canRename={canRename}
        onRenameTitle={onRenameTitle}
        onEditingChange={onEditingChange}
      />
      {description ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-4 text-muted-foreground">
          {description}
        </p>
      ) : descriptionLoading ? (
        <span
          data-slot="session-hover-preview-description-loading"
          className="mt-2 block h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}

const SessionHoverPreview = ({
  session,
  onPreviewRequest,
  canRename = false,
  onRenameTitle,
  children
}: {
  session: SessionPreviewDetails
  onPreviewRequest?: SessionPreviewRequest
  canRename?: boolean
  onRenameTitle?: SessionRenameRequest
  children: ReactElement
}): React.JSX.Element => {
  const context = useContext(SessionHoverPreviewContext)
  if (!context) throw new Error('SessionHoverPreview must be inside SessionHoverPreviewProvider')

  const { activeSessionId, closeNow, requestOpen } = context
  const open = activeSessionId === session.id
  const onPreviewRequestRef = useRef(onPreviewRequest)
  // Radix types the trigger ref as its default anchor element; with asChild the rendered element
  // is the caller's child, and only Element-level APIs (contains/matches) are used here.
  const triggerRef = useRef<HTMLAnchorElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [descriptionLoading, setDescriptionLoading] = useState(false)
  // While the inline title editor is active the card is pinned open; pointer leaves and
  // Radix-initiated close requests are ignored until the edit commits or cancels.
  const editingRef = useRef(false)

  useEffect(() => {
    onPreviewRequestRef.current = onPreviewRequest
  }, [onPreviewRequest])

  useEffect(() => {
    if (!open) return

    const request = onPreviewRequestRef.current?.(session.id)
    if (!request) {
      void Promise.resolve().then(() => setDescriptionLoading(false))
      return
    }
    void Promise.resolve().then(() => setDescriptionLoading(true))
    void request.finally(() => {
      setDescriptionLoading(false)
    })
  }, [open, session.id])

  useEffect(() => () => closeNow(session.id), [closeNow, session.id])

  const requestClose = useCallback((): void => {
    if (editingRef.current) return
    // Focus moved into the portaled card (e.g. Tab from the row to the rename control): keep the
    // interactive card open until that focus leaves the card.
    if (contentRef.current?.contains(document.activeElement)) return
    closeNow(session.id)
  }, [closeNow, session.id])

  const handleEditingChange = useCallback(
    (editing: boolean): void => {
      editingRef.current = editing
      if (editing) return
      // Editing ended (commit or cancel): resume normal close semantics by closing immediately
      // when the pointer is no longer over the trigger or the card.
      if (triggerRef.current?.matches(':hover') || contentRef.current?.matches(':hover')) return
      closeNow(session.id)
    },
    [closeNow, session.id]
  )

  return (
    <HoverCard
      open={open}
      openDelay={SESSION_HOVER_PREVIEW_DELAY_MS}
      closeDelay={SESSION_HOVER_PREVIEW_SKIP_DELAY_MS}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          requestOpen(session.id)
          return
        }
        requestClose()
      }}
    >
      <HoverCardTrigger
        ref={triggerRef}
        asChild
        onPointerEnter={() => requestOpen(session.id)}
        onPointerLeave={(event) => {
          if (event.currentTarget.matches(':focus-visible')) return
          if (
            event.relatedTarget instanceof Node &&
            contentRef.current?.contains(event.relatedTarget)
          ) {
            return
          }
          requestClose()
        }}
        onFocus={() => requestOpen(session.id)}
        onBlur={(event) => {
          if (event.currentTarget.matches(':hover')) return
          if (
            event.relatedTarget instanceof Node &&
            contentRef.current?.contains(event.relatedTarget)
          ) {
            // Internal focus transition; preventDefault also skips Radix's composed trigger-blur
            // close (composeEventHandlers honors defaultPrevented).
            event.preventDefault()
            return
          }
          // Defer the close decision until focus settles: document.activeElement then reflects the
          // destination even when relatedTarget is null (programmatic focus moves), and
          // requestClose keeps the card open while focus stays inside it.
          setTimeout(requestClose, 0)
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={0}
        alignOffset={SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX}
        collisionPadding={8}
        onPointerLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            triggerRef.current?.contains(event.relatedTarget)
          ) {
            return
          }
          requestClose()
        }}
        onEscapeKeyDown={() => requestClose()}
        className="max-w-none overflow-visible bg-transparent py-0 pr-0 pl-2.5 text-inherit shadow-none motion-reduce:animate-none"
      >
        <SessionHoverPreviewCard
          session={session}
          descriptionLoading={open && descriptionLoading}
          canRename={canRename}
          onRenameTitle={onRenameTitle}
          onEditingChange={handleEditingChange}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

export {
  SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX,
  SESSION_HOVER_PREVIEW_DELAY_MS,
  SESSION_HOVER_PREVIEW_SKIP_DELAY_MS,
  SessionHoverPreview,
  SessionHoverPreviewCard,
  SessionHoverPreviewProvider,
  SessionTitleMarquee
}
export type { SessionPreviewRequest, SessionRenameRequest }
