import {
  noticeSurfaceClassName,
  noticeCapsuleClassName,
  noticeTitleClassName,
  noticeActionClassName,
  noticeDismissClassName
} from './ui/notice-chrome'
/* Hallmark · component: action toast · genre: modern-minimal · theme: project app tokens */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: project tokens · slop: pass */
import { useState, type ReactNode, type Ref } from 'react'
import { X } from 'lucide-react'

import { NoticeText } from './notice-text'
import { useNoticeCountdown } from './use-notice-countdown'

import { Notice, type NoticeLevel } from './notice'

import { cn } from '@/lib/utils'

type ActionToastProps = {
  title: string
  detail?: string
  level?: NoticeLevel
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
  level = 'info',
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
  useNoticeCountdown(autoDismissMs || undefined, paused, onDismiss)

  return (
    <div
      role="status"
      data-testid={testId}
      data-action-toast-compact={!detail ? true : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusedWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWithin(false)
      }}
      className={cn(
        'pointer-events-auto fixed inset-x-3 top-3 mx-auto z-toast flex w-[min(24rem,calc(100vw-1.5rem))] max-h-[calc(100svh-1.5rem)] flex-wrap items-start gap-3 overflow-y-auto shadow-dialog',
        detail ? 'rounded-2xl' : noticeSurfaceClassName,
        !detail && [noticeCapsuleClassName, 'w-fit max-w-[min(24rem,calc(100vw-1.5rem))]'],
        className
      )}
    >
      {detail ? (
        <Notice
          level={level}
          title={title}
          description={detail}
          primaryButton={
            actionLabel && onAction ? { label: actionLabel, onClick: onAction } : undefined
          }
          dismissButton={{ label: dismissLabel, onClick: onDismiss }}
        />
      ) : (
        <>
          <NoticeText text={title} className={cn(noticeTitleClassName, 'font-normal')} />
          {actionLabel && onAction ? (
            <button type="button" onClick={onAction} className={noticeActionClassName}>
              {actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={dismissLabel}
            onClick={onDismiss}
            className={noticeDismissClassName}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  )
}

// One viewport-wide scroller leaves room around centered cards for their shadows to fade.
// Nested notice owners must not clip shadows; timers and event ownership stay with them.
const ActionToastStack = ({
  children,
  ref
}: {
  children?: ReactNode
  ref?: Ref<HTMLDivElement>
}): React.JSX.Element => (
  <div
    data-action-toast-stack
    ref={ref}
    className="pointer-events-none fixed inset-x-0 top-0 z-toast flex max-h-svh flex-col items-center gap-2 overflow-y-auto px-3 pt-3 pb-10 [&>div]:static [&>div]:max-w-[min(24rem,100%)] [&>div:not([data-action-toast-compact])]:w-full [&>div]:shrink-0"
  >
    {children}
  </div>
)

// Bottom recovery notices share layout only; their owners retain retry and dismissal state.
const BottomNoticeStack = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div
    data-bottom-notice-stack
    className="pointer-events-none fixed bottom-3 right-3 z-toast flex max-h-[calc(100svh-24px)] w-[min(420px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto [&_[data-bottom-notice]]:static [&_[data-bottom-notice]]:w-full [&_[data-bottom-notice]]:max-w-none [&_[data-bottom-notice]]:shrink-0"
  >
    {children}
  </div>
)

export { ActionToast, ActionToastStack, BottomNoticeStack }
export type { ActionToastProps }
