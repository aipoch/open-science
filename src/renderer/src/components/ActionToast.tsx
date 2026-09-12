/* Hallmark · component: action toast · genre: modern-minimal · theme: project app tokens */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: project tokens · slop: pass */
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

type ActionToastProps = {
  title: string
  detail?: string
  actionLabel?: string
  dismissLabel: string
  onAction?: () => void
  onDismiss: () => void
  autoDismissMs?: number
  className?: string
  testId?: string
}

const ActionToast = ({
  title,
  detail,
  actionLabel,
  dismissLabel,
  onAction,
  onDismiss,
  autoDismissMs,
  className,
  testId
}: ActionToastProps): React.JSX.Element => {
  const [hovered, setHovered] = useState(false)
  const [focusedWithin, setFocusedWithin] = useState(false)
  const paused = hovered || focusedWithin
  const dismissAfterTimeout = useEffectEvent(onDismiss)

  useEffect(() => {
    if (!autoDismissMs || paused) return
    const timeout = window.setTimeout(dismissAfterTimeout, autoDismissMs)
    return () => window.clearTimeout(timeout)
  }, [autoDismissMs, paused])

  return (
    <div
      role="status"
      data-testid={testId}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusedWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWithin(false)
      }}
      className={cn(
        'pointer-events-auto fixed right-3 top-3 z-toast flex w-[min(24rem,calc(100vw-1.5rem))] max-h-[calc(100svh-1.5rem)] flex-wrap items-start gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 text-sm text-foreground shadow-dialog',
        className
      )}
    >
      <span className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]">
        <span className="block">{title}</span>
        {detail ? (
          <span
            className="mt-1 block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
            title={detail}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex min-h-7 max-w-full items-center rounded px-2 text-xs font-medium whitespace-normal [overflow-wrap:anywhere] text-primary hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-text-300 hover:bg-bg-300 hover:text-text-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

// Keep global notices in document flow within one viewport; no timer or event ownership moves here.
const ActionToastStack = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div
    data-action-toast-stack
    className="pointer-events-none fixed right-3 top-3 z-toast flex max-h-[calc(100svh-1.5rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto [&>div]:static [&>div]:w-full [&>div]:shrink-0"
  >
    {children}
  </div>
)

export { ActionToast, ActionToastStack }
export type { ActionToastProps }
