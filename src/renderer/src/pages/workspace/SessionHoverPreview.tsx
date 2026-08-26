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

const SESSION_HOVER_PREVIEW_DELAY_MS = 2_000
const SESSION_HOVER_PREVIEW_SKIP_DELAY_MS = 300

type SessionPreviewContent = {
  title: string
  description?: string
}
type SessionPreviewDetails = SessionPreviewContent & { id: string }

type SessionHoverPreviewContextValue = {
  activeSessionId: string | null
  closeNow: (sessionId: string) => void
  keepOpen: () => void
  requestOpen: (sessionId: string, immediate?: boolean) => void
  scheduleClose: (sessionId: string) => void
}

const SessionHoverPreviewContext = createContext<SessionHoverPreviewContextValue | null>(null)

const SessionHoverPreviewProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const pendingSessionIdRef = useRef<string | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearOpenTimer = useCallback((): void => {
    clearTimeout(openTimerRef.current)
    openTimerRef.current = undefined
    pendingSessionIdRef.current = null
  }, [])

  const keepOpen = useCallback((): void => {
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }, [])

  const requestOpen = useCallback(
    (sessionId: string, immediate = false): void => {
      keepOpen()
      if (immediate || activeSessionIdRef.current !== null) {
        clearOpenTimer()
        activeSessionIdRef.current = sessionId
        setActiveSessionId(sessionId)
        return
      }
      if (pendingSessionIdRef.current === sessionId) return

      clearOpenTimer()
      pendingSessionIdRef.current = sessionId
      openTimerRef.current = setTimeout(() => {
        pendingSessionIdRef.current = null
        activeSessionIdRef.current = sessionId
        setActiveSessionId(sessionId)
      }, SESSION_HOVER_PREVIEW_DELAY_MS)
    },
    [clearOpenTimer, keepOpen]
  )

  const scheduleClose = useCallback(
    (sessionId: string): void => {
      if (pendingSessionIdRef.current === sessionId) clearOpenTimer()
      if (activeSessionIdRef.current !== sessionId) return

      keepOpen()
      closeTimerRef.current = setTimeout(() => {
        if (activeSessionIdRef.current !== sessionId) return
        activeSessionIdRef.current = null
        setActiveSessionId(null)
      }, SESSION_HOVER_PREVIEW_SKIP_DELAY_MS)
    },
    [clearOpenTimer, keepOpen]
  )

  const closeNow = useCallback(
    (sessionId: string): void => {
      if (pendingSessionIdRef.current === sessionId) clearOpenTimer()
      if (activeSessionIdRef.current !== sessionId) return

      keepOpen()
      activeSessionIdRef.current = null
      setActiveSessionId(null)
    },
    [clearOpenTimer, keepOpen]
  )

  useEffect(
    () => () => {
      clearOpenTimer()
      keepOpen()
    },
    [clearOpenTimer, keepOpen]
  )

  const value = useMemo(
    () => ({ activeSessionId, closeNow, keepOpen, requestOpen, scheduleClose }),
    [activeSessionId, closeNow, keepOpen, requestOpen, scheduleClose]
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
          duration: Math.min(12_000, Math.max(2_000, overflow * 35)),
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
  className
}: {
  session: SessionPreviewContent
  className?: string
}): React.JSX.Element => {
  const description = session.description?.trim()

  return (
    <div
      data-slot="session-hover-preview"
      className={cn(
        'w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-dialog',
        'max-h-[min(24rem,calc(100vh-1rem))]',
        className
      )}
    >
      <p className="break-words text-[15px] font-semibold leading-5 tracking-[-0.01em] [text-wrap:pretty]">
        {session.title}
      </p>
      {description ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  )
}

const SessionHoverPreview = ({
  session,
  children
}: {
  session: SessionPreviewDetails
  children: ReactElement
}): React.JSX.Element => {
  const context = useContext(SessionHoverPreviewContext)
  if (!context) throw new Error('SessionHoverPreview must be inside SessionHoverPreviewProvider')

  const { activeSessionId, closeNow, keepOpen, requestOpen, scheduleClose } = context
  const open = activeSessionId === session.id

  return (
    <Tooltip open={open}>
      <TooltipTrigger
        asChild
        onPointerEnter={() => requestOpen(session.id)}
        onPointerLeave={(event) => {
          if (event.currentTarget.matches(':focus-visible')) return
          scheduleClose(session.id)
        }}
        onFocus={() => requestOpen(session.id, true)}
        onBlur={(event) => {
          if (event.currentTarget.matches(':hover')) return
          scheduleClose(session.id)
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={8}
        onPointerEnter={keepOpen}
        onPointerLeave={() => scheduleClose(session.id)}
        onEscapeKeyDown={() => closeNow(session.id)}
        className="max-w-none overflow-visible bg-transparent p-0 text-inherit shadow-none motion-reduce:animate-none"
      >
        <SessionHoverPreviewCard session={session} />
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
