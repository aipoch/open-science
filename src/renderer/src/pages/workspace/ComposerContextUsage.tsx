// Composer context-usage indicator: a compact "% of context window" pill with a hover breakdown,
// mirroring Claude Code's /context. During generation the local request estimate updates independently;
// once an Agent total exists it remains the numerator until a fresher usage_update arrives. The
// denominator is bound to the selected model and agent-context generation when that window is known.

import { useTranslation } from 'react-i18next'
import { Gauge, Minimize2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AcpContextUsage, AcpContextUsageCategoryKey } from '../../../../shared/acp'

type ComposerContextUsageProps = {
  // Latest usage for the active session, or undefined when the framework never reported any.
  contextUsage: AcpContextUsage | undefined
  canCompact?: boolean
  compacting?: boolean
  compactDisabledReason?: string
  onCompact?: () => void
}

const COMPACT_ACTION_THRESHOLD_PERCENT = 30

// `label` holds a catalog key, not display text: this map is module-level, so a resolved string
// would freeze the first language the module loaded under. Both render sites pass it through t().
const CATEGORY_PRESENTATION: Record<AcpContextUsageCategoryKey, { label: string; color: string }> =
  {
    system: { label: 'System prompt', color: 'bg-emerald-500' },
    tools: { label: 'Tools and agents', color: 'bg-amber-400' },
    messages: { label: 'Messages', color: 'bg-violet-500' },
    mcp: { label: 'Connectors and MCP', color: 'bg-cyan-400' },
    skills: { label: 'Skills', color: 'bg-blue-500' },
    other: { label: 'Agent/framework overhead', color: 'bg-slate-400' }
  }

// Tokenizer ids are protocol values and stay English; only the Anthropic row is prose.
const TOKENIZER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic approx.',
  o200k_base: 'o200k_base',
  cl100k_base: 'cl100k_base'
}

// Compact token count: 1_000_000 -> "1M", 24_890 -> "25k", 512 -> "512".
const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

const formatDetailedTokens = (tokens: number): string => {
  const absolute = Math.abs(tokens)
  if (absolute < 1_000) return String(Math.round(tokens))
  const divisor = absolute >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = divisor === 1_000_000 ? 'M' : 'k'
  const value = tokens / divisor
  return `${Math.abs(value) >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}${suffix}`
}

const ComposerContextUsage = ({
  contextUsage,
  canCompact = false,
  compacting = false,
  compactDisabledReason,
  onCompact
}: ComposerContextUsageProps): React.JSX.Element | null => {
  const { t } = useTranslation()
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
  const hasKnownSize = size !== undefined && size > 0
  const usagePercent = hasKnownSize ? Math.min(100, (used / size) * 100) : undefined
  const percent = usagePercent !== undefined ? Math.round(usagePercent) : undefined

  const label = percent !== undefined ? `${percent}%` : formatTokens(used)
  const breakdown = contextUsage.breakdown
  const estimating = breakdown?.status === 'preflight'
  const hasAgentTotal = !estimating || contextUsage.agentUsed !== undefined
  // Whole sentences per branch rather than a swapped-in noun: a pre-Agent snapshot is announced as an
  // estimate, not as settled usage, and that distinction has to survive translation.
  const triggerAriaLabel = hasAgentTotal
    ? t('Context used: {{label}}', { label })
    : t('Estimated context: {{label}}', { label })
  const showCompactAction =
    compacting ||
    (!estimating && usagePercent !== undefined && usagePercent >= COMPACT_ACTION_THRESHOLD_PERCENT)
  const compactUnavailable = !canCompact || !onCompact
  const compactHint = !compacting && compactUnavailable ? compactDisabledReason : undefined
  const categories = breakdown?.categories.filter((category) => category.tokens > 0) ?? []
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
  const visualUsed = estimating
    ? (breakdown?.estimatedTokens ?? categoryTotal)
    : Math.max(used, categoryTotal)
  const visualPercent = hasKnownSize ? Math.min(100, (visualUsed / size) * 100) : 100

  const compactButton = (
    <button
      type="button"
      aria-label={compacting ? t('Compacting context') : t('Compact context')}
      aria-disabled={compactUnavailable ? true : undefined}
      disabled={compacting || (compactUnavailable && !compactHint)}
      onClick={compacting || compactUnavailable ? undefined : onCompact}
      className={`inline-flex h-6 w-full items-center justify-center gap-1 rounded-lg bg-bg-200 px-2 text-[11px] text-text-000 outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-300 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-bg-400 disabled:cursor-not-allowed disabled:opacity-50 ${compactHint ? 'cursor-not-allowed opacity-50 hover:bg-bg-200' : ''}`}
    >
      <Minimize2 className="size-3" aria-hidden="true" />
      {compacting ? t('Compacting…') : t('Compact')}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-000 outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-200 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-bg-300"
          aria-label={triggerAriaLabel}
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
        align="center"
        sideOffset={8}
        className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-menu"
        onPointerEnter={keepOpen}
        onPointerLeave={scheduleClose}
        onFocusCapture={keepOpen}
        onBlurCapture={handleBlur}
        onOpenAutoFocus={(event) => {
          if (openedFromPointerRef.current) event.preventDefault()
        }}
      >
        <div className="space-y-2.5 text-[12px]">
          <div>
            <div className="text-[13px] font-medium">{t('Context window')}</div>
            <div
              data-slot="context-usage-summary"
              className="mt-1 flex min-w-0 items-baseline gap-2 whitespace-nowrap"
            >
              <span className="shrink-0 text-xl font-semibold tabular-nums">
                {usagePercent !== undefined ? `${usagePercent.toFixed(1)}%` : formatTokens(used)}
              </span>
              <span className="min-w-0 truncate text-muted-foreground tabular-nums">
                {hasAgentTotal ? t('Agent used') : t('Local estimate')}
                {hasKnownSize
                  ? ` ${formatDetailedTokens(used)} / ${formatDetailedTokens(size)}`
                  : null}
              </span>
            </div>
          </div>
          {breakdown ? (
            <>
              <div
                className="flex h-2 overflow-hidden rounded-full bg-bg-200"
                aria-label={
                  hasKnownSize
                    ? t('Estimated category occupancy: {{used}} of {{size}} tokens', {
                        used: formatDetailedTokens(visualUsed),
                        size: formatDetailedTokens(size)
                      })
                    : t('Estimated category distribution: {{used}} tokens', {
                        used: formatDetailedTokens(visualUsed)
                      })
                }
              >
                {categories.map((category) => {
                  const presentation = CATEGORY_PRESENTATION[category.key]
                  const width =
                    categoryTotal > 0 ? (category.tokens / categoryTotal) * visualPercent : 0
                  return (
                    <span
                      key={category.key}
                      className={`${presentation.color} h-full border-r border-bg-000/80 last:border-r-0`}
                      style={{ width: `${width}%` }}
                      title={`${t(presentation.label)}: ${formatDetailedTokens(category.tokens)}`}
                    />
                  )
                })}
              </div>
              <div className="space-y-1">
                {categories.map((category) => {
                  const presentation = CATEGORY_PRESENTATION[category.key]
                  return (
                    <div
                      key={category.key}
                      className="flex items-center justify-between gap-3 whitespace-nowrap"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`${presentation.color} size-2 shrink-0 rounded-full`} />
                        <span className="truncate">{t(presentation.label)}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {category.estimated ? '~' : ''}
                        {formatDetailedTokens(category.tokens)}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div
                data-slot="context-usage-diagnostics"
                className="space-y-0.5 border-t border-border pt-2 text-[11px] leading-4 text-muted-foreground"
                title={
                  estimating
                    ? contextUsage.agentUsed === undefined
                      ? t('Local estimate updates while the Agent is generating.')
                      : t(
                          'The latest Agent total remains authoritative while local categories update.'
                        )
                    : t('Agent total is authoritative; category values are local estimates.')
                }
              >
                {estimating && contextUsage.agentUsed !== undefined ? (
                  <div className="whitespace-nowrap tabular-nums">
                    {t('Local {{local}} · Latest Agent {{agent}}', {
                      local: formatDetailedTokens(breakdown.estimatedTokens),
                      agent: formatDetailedTokens(contextUsage.agentUsed)
                    })}
                  </div>
                ) : estimating ? null : (
                  <div className="whitespace-nowrap tabular-nums">
                    {t('Local {{local}} · Agent {{agent}} · Δ {{difference}}', {
                      local: formatDetailedTokens(breakdown.estimatedTokens),
                      agent: formatDetailedTokens(used),
                      difference: `${breakdown.difference > 0 ? '+' : ''}${formatDetailedTokens(breakdown.difference)}`
                    })}
                  </div>
                )}
                <div className="truncate whitespace-nowrap">
                  {estimating ? t('Estimating') : t('Reconciled')}
                  {breakdown.tokenizer
                    ? ` · ${breakdown.tokenizer === 'anthropic' ? t(TOKENIZER_LABELS[breakdown.tokenizer]) : TOKENIZER_LABELS[breakdown.tokenizer]}`
                    : ''}
                  {breakdown.model ? ` · ${breakdown.model}` : ''}
                </div>
              </div>
            </>
          ) : (
            <div className="whitespace-nowrap text-muted-foreground tabular-nums">
              {hasKnownSize ? `${formatTokens(used)} / ${formatTokens(size)}` : formatTokens(used)}{' '}
              {t('tokens')}
              {percent !== undefined ? ` (${percent}%)` : ''}
            </div>
          )}
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
