/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: update action · genre: modern-minimal · theme: existing Open Science
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: existing project token pairs
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, RefreshCw, RotateCcw, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../shared/update'

type UpdateCapsuleProps = {
  className?: string
  variant?: 'home' | 'session'
}

const FOCUS_ATTENTION_COOLDOWN_MS = 15 * 60 * 1000

const updateCopy = (
  status: UpdateStatus,
  t: (key: string, options?: Record<string, unknown>) => string
): { title: string; action: string; icon: LucideIcon } => {
  if (status.state === 'downloading') {
    return {
      title: t('Downloading'),
      action: `${Math.round(status.progress ?? 0)}%`,
      icon: LoaderCircle
    }
  }
  if (status.state === 'ready') {
    return {
      title: t('Update ready'),
      action: status.applyKind === 'installer' ? t('Install') : t('Restart'),
      icon: RefreshCw
    }
  }
  if (status.state === 'error') {
    return { title: t('Update failed'), action: t('Retry'), icon: RotateCcw }
  }
  return { title: t('New version'), action: t('Update', { context: 'verb' }), icon: ArrowUp }
}

const UpdateAttention = (): React.JSX.Element => (
  <span className="update-reminder-attention" aria-hidden="true">
    <span className="update-reminder-sheen" />
    <span className="update-reminder-orbit" />
  </span>
)

const UpdateMark = ({
  Icon,
  status
}: {
  Icon: LucideIcon
  status: UpdateStatus
}): React.JSX.Element => {
  return (
    <span className="update-reminder-mark" aria-hidden="true">
      <Icon
        className={cn(
          'relative z-10 size-3.5',
          status.state === 'downloading' && 'animate-spin motion-reduce:animate-none'
        )}
        strokeWidth={2.25}
      />
    </span>
  )
}

// The same terse update action fits both constrained surfaces: Home exposes extra context on
// hover/focus, while Session keeps a single persistent action above the footer controls.
const UpdateCapsule = ({
  className,
  variant = 'home'
}: UpdateCapsuleProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const status = useUpdateStore((state) => state.status)
  const openDialog = useUpdateStore((state) => state.openDialog)
  const [focusAttentionCycle, setFocusAttentionCycle] = useState(0)
  const lastAttentionAtRef = useRef(0)

  const drawsAttention = status.state === 'available' || status.state === 'ready'

  useEffect(() => {
    if (!drawsAttention) return

    lastAttentionAtRef.current = Date.now()

    const replayAttention = (): void => {
      const now = Date.now()
      if (
        document.visibilityState !== 'visible' ||
        now - lastAttentionAtRef.current < FOCUS_ATTENTION_COOLDOWN_MS
      ) {
        return
      }
      lastAttentionAtRef.current = now
      setFocusAttentionCycle((cycle) => cycle + 1)
    }

    window.addEventListener('focus', replayAttention)
    return () => window.removeEventListener('focus', replayAttention)
  }, [drawsAttention, status.latest, status.state])

  const isVisible =
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'ready' ||
    (status.state === 'error' && Boolean(status.latest))
  if (!isVisible) return null

  const copy = updateCopy(status, t)
  const Icon = copy.icon
  const label = `${copy.title}: ${copy.action}${status.latest ? ` (v${status.latest})` : ''}`
  const hasError = status.state === 'error'
  const attentionKey = `${status.state}:${status.latest ?? ''}:${focusAttentionCycle}`

  if (variant === 'session') {
    return (
      <button
        type="button"
        data-variant="session"
        data-state={status.state}
        onClick={() => openDialog()}
        aria-label={label}
        className={cn(
          'update-reminder relative isolate inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-semibold whitespace-nowrap text-primary-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11 motion-reduce:transform-none motion-reduce:transition-none',
          hasError && 'bg-danger-000 text-white hover:bg-danger-000/90',
          className
        )}
      >
        {drawsAttention ? <UpdateAttention key={`${attentionKey}:attention`} /> : null}
        <UpdateMark
          key={drawsAttention ? `${attentionKey}:mark` : undefined}
          Icon={Icon}
          status={status}
        />
        <span className="relative z-10">{copy.action}</span>
        {drawsAttention ? <span className="update-reminder-status-dot" aria-hidden="true" /> : null}
      </button>
    )
  }

  return (
    <TooltipProvider delayDuration={800}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-variant="home"
            data-state={status.state}
            onClick={() => openDialog()}
            aria-label={label}
            className={cn(
              'update-reminder relative isolate inline-flex size-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-semibold whitespace-nowrap text-primary-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-2.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11 motion-reduce:transform-none motion-reduce:transition-none',
              hasError && 'bg-danger-000 text-white hover:bg-danger-000/90',
              className
            )}
          >
            {drawsAttention ? <UpdateAttention key={`${attentionKey}:attention`} /> : null}
            <UpdateMark
              key={drawsAttention ? `${attentionKey}:mark` : undefined}
              Icon={Icon}
              status={status}
            />
            <span className="relative z-10 hidden sm:inline">{copy.action}</span>
            {drawsAttention ? (
              <span className="update-reminder-status-dot" aria-hidden="true" />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent
          data-update-details
          side="bottom"
          align="end"
          sideOffset={6}
          className={cn(
            'flex w-28 flex-col border border-border bg-popover px-2 py-1.5 text-left text-popover-foreground shadow-menu',
            hasError && 'border-danger-000/30'
          )}
        >
          <span
            className={cn(
              'text-[10px] font-medium leading-4 text-muted-foreground',
              hasError && 'text-danger-000'
            )}
          >
            {copy.title}
          </span>
          <span className="text-xs font-semibold leading-4">{copy.action}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { UpdateCapsule }
