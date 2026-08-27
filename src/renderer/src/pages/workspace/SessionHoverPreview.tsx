/* Hallmark · macrostructure: anchored session context card · genre: modern-minimal · theme: Open Science
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (40–41) · slop: pass (applicable component gates)
 * pre-emit critique: P5 H4 E5 S5 R5 V4
 */
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

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const SESSION_HOVER_PREVIEW_DELAY_MS = 0
const SESSION_HOVER_PREVIEW_SKIP_DELAY_MS = 300

type SessionPreviewContent = {
  title: string
  description?: string
}
type SessionPreviewDetails = SessionPreviewContent & { id: string }
type SessionPreviewRequest = (sessionId: string) => Promise<void> | void

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
      <TooltipProvider
        delayDuration={SESSION_HOVER_PREVIEW_DELAY_MS}
        skipDelayDuration={SESSION_HOVER_PREVIEW_SKIP_DELAY_MS}
      >
        {children}
      </TooltipProvider>
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

const SessionHoverPreviewCard = ({
  session,
  descriptionLoading = false,
  className
}: {
  session: SessionPreviewContent
  descriptionLoading?: boolean
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
      <p className="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em]">
        {session.title}
      </p>
      {description ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">
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
  children
}: {
  session: SessionPreviewDetails
  onPreviewRequest?: SessionPreviewRequest
  children: ReactElement
}): React.JSX.Element => {
  const context = useContext(SessionHoverPreviewContext)
  if (!context) throw new Error('SessionHoverPreview must be inside SessionHoverPreviewProvider')

  const { activeSessionId, closeNow, requestOpen } = context
  const open = activeSessionId === session.id
  const onPreviewRequestRef = useRef(onPreviewRequest)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [descriptionLoading, setDescriptionLoading] = useState(false)

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

  return (
    <Tooltip open={open}>
      <TooltipTrigger
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
          closeNow(session.id)
        }}
        onFocus={() => requestOpen(session.id)}
        onBlur={(event) => {
          if (event.currentTarget.matches(':hover')) return
          closeNow(session.id)
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={0}
        collisionPadding={8}
        onPointerLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            triggerRef.current?.contains(event.relatedTarget)
          ) {
            return
          }
          closeNow(session.id)
        }}
        onEscapeKeyDown={() => closeNow(session.id)}
        className="max-w-none overflow-visible bg-transparent py-0 pr-0 pl-2.5 text-inherit shadow-none motion-reduce:animate-none"
      >
        <SessionHoverPreviewCard
          session={session}
          descriptionLoading={open && descriptionLoading}
        />
      </TooltipContent>
    </Tooltip>
  )
}

export {
  SESSION_HOVER_PREVIEW_DELAY_MS,
  SESSION_HOVER_PREVIEW_SKIP_DELAY_MS,
  SessionHoverPreview,
  SessionHoverPreviewCard,
  SessionHoverPreviewProvider,
  SessionTitleMarquee
}
export type { SessionPreviewRequest }
