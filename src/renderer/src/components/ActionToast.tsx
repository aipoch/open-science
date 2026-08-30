/* Hallmark · component: action toast · genre: modern-minimal · theme: project app tokens */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: project tokens · slop: pass */
import { useEffect, useEffectEvent, useState } from 'react'
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
        'fixed right-3 top-3 z-toast flex w-[min(24rem,calc(100vw-1.5rem))] items-center gap-3 rounded-lg border border-border-100 bg-bg-200 px-3 py-2 text-sm text-text-100 shadow-lg',
        className
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block">{title}</span>
        {detail ? (
          <span className="block truncate text-xs text-text-300" title={detail}>
            {detail}
          </span>
        ) : null}
      </span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex h-7 shrink-0 items-center rounded px-2 text-xs font-medium whitespace-nowrap text-primary hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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

export { ActionToast }
export type { ActionToastProps }
