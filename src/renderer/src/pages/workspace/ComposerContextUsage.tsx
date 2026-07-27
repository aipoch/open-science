// Composer context-usage indicator: a compact "% of context window" pill with a hover breakdown,
// mirroring Claude Code's /context. The numerator (tokens in context) comes from the ACP usage_update
// the runtime records per session; the denominator is already bound to the same agent-context generation
// by the main process. Renders nothing until the active framework emits its first usage_update rather
// than showing a fabricated zero.

import { Gauge, Minimize2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AcpContextUsage } from '../../../../shared/acp'

type ComposerContextUsageProps = {
  // Latest usage for the active session, or undefined when the framework never reported any.
  contextUsage: AcpContextUsage | undefined
  canCompact?: boolean
  compacting?: boolean
  compactDisabledReason?: string
  onCompact?: () => void
}

const COMPACT_ACTION_THRESHOLD_PERCENT = 30

// Compact token count: 1_000_000 -> "1M", 24_890 -> "25k", 512 -> "512".
const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

const ComposerContextUsage = ({
  contextUsage,
  canCompact = false,
  compacting = false,
  compactDisabledReason,
  onCompact
}: ComposerContextUsageProps): React.JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openedFromPointerRef = useRef(false)

  const keepOpen = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  const scheduleClose = (): void => {
    keepOpen()
    closeTimerRef.current = setTimeout(() => {
      const focused = document.activeElement
      if (triggerRef.current?.contains(focused) || contentRef.current?.contains(focused)) return
      setOpen(false)
    }, 100)
  }

  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    if (triggerRef.current?.contains(next) || contentRef.current?.contains(next)) return
    scheduleClose()
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    []
  )

  if (!contextUsage || typeof contextUsage.used !== 'number') return null

  const size = contextUsage.size
  const used = contextUsage.used
  const usagePercent = size && size > 0 ? Math.min(100, (used / size) * 100) : undefined
  const percent = usagePercent !== undefined ? Math.round(usagePercent) : undefined

  const label = percent !== undefined ? `${percent}%` : formatTokens(used)
  const showCompactAction =
    compacting || (usagePercent !== undefined && usagePercent >= COMPACT_ACTION_THRESHOLD_PERCENT)
  const compactUnavailable = !canCompact || !onCompact
  const compactHint = !compacting && compactUnavailable ? compactDisabledReason : undefined

  const compactButton = (
    <button
      type="button"
      aria-label={compacting ? 'Compacting context' : 'Compact context'}
      aria-disabled={compactUnavailable ? true : undefined}
      disabled={compacting || (compactUnavailable && !compactHint)}
      onClick={compacting || compactUnavailable ? undefined : onCompact}
      className={`inline-flex h-6 w-full items-center justify-center gap-1 rounded bg-bg-000 px-2 text-[11px] text-text-000 transition-colors hover:bg-bg-100 disabled:cursor-not-allowed disabled:opacity-50 ${compactHint ? 'cursor-not-allowed opacity-50 hover:bg-bg-000' : ''}`}
    >
      <Minimize2 className="size-3" aria-hidden="true" />
      {compacting ? 'Compacting…' : 'Compact'}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-000 transition-colors duration-200 ease-out hover:bg-bg-200"
          aria-label={`Context used: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          onPointerEnter={() => {
            openedFromPointerRef.current = true
            keepOpen()
            setOpen(true)
          }}
          onPointerLeave={scheduleClose}
          onFocus={() => {
            openedFromPointerRef.current = false
            keepOpen()
            setOpen(true)
          }}
          onBlur={handleBlur}
          onClick={() => {
            openedFromPointerRef.current = false
            keepOpen()
            setOpen(true)
          }}
        >
          <Gauge className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="tabular-nums @max-[28rem]/composer:hidden">{label}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        id={contentId}
        side="top"
        className="max-w-64"
        onPointerEnter={keepOpen}
        onPointerLeave={scheduleClose}
        onFocusCapture={keepOpen}
        onBlurCapture={handleBlur}
        onOpenAutoFocus={(event) => {
          if (openedFromPointerRef.current) event.preventDefault()
        }}
      >
        <div className="space-y-1 text-[12px]">
          <div className="font-medium">Context window</div>
          <div>
            {formatTokens(used)} / {formatTokens(size)} tokens
            {percent !== undefined ? ` (${percent}%)` : ''}
          </div>
          {showCompactAction ? (
            <div className="flex pt-1">
              {compactHint ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>{compactButton}</TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-center leading-relaxed">
                      {compactHint}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                compactButton
              )}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { ComposerContextUsage }
