/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: context-window dialog · turns: composition (full-width ratio strip) + pinned run history; calls: 3-metric summary + stacked per-call chart with gray turn lanes and pinned call details · genre: modern-minimal · theme: product tokens (chart-1..5) · contrast: pass (40–41) · mobile: pass (34, 49, 50–57) · slop: pass (1–58) */
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import { SettingsSegmentedControl } from '@/pages/settings/SettingsSegmentedControl'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatSession } from '@/stores/session-store'
import {
  Activity,
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  CircleStop,
  Minimize2,
  X,
  type LucideIcon
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDisplayNumber } from '@/lib/locale-format'

import type {
  AcpContextUsage,
  AcpContextUsageCategory,
  AcpContextUsageCategoryKey,
  AcpModelCallUsage,
  AcpPromptStopReason
} from '../../../../shared/acp'
import {
  groupContextWindowCallsByTurn,
  selectContextWindowCallPoints,
  selectContextWindowTrendPoints,
  summarizeContextWindowCallPoints,
  type ContextWindowCallPoint,
  type ContextWindowCallSummary,
  type ContextWindowCallTurnBand,
  type ContextWindowTrendPoint
} from './context-window-trend'
import { resolveSessionProviderId } from './error-report'

type ContextWindowDialogProps = {
  open: boolean
  session: ChatSession | undefined
  contextUsage?: AcpContextUsage
  onOpenChange: (open: boolean) => void
}

const formatTokens = (tokens: number): string => {
  const absolute = Math.abs(tokens)
  if (absolute >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${formatDisplayNumber(value, {
      maximumFractionDigits: Math.abs(value) >= 10 || Number.isInteger(value) ? 0 : 1
    })}M`
  }
  if (absolute >= 1_000) {
    const value = tokens / 1_000
    return `${formatDisplayNumber(value, {
      maximumFractionDigits: Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 1
    })}K`
  }
  return formatDisplayNumber(tokens)
}

// Catalog keys stay unresolved at module scope so changing locale updates every render site.
// Colors use the muted design-system chart tokens (main.css --chart-1..5), not the vivid Tailwind
// palette, and match the per-message usage bars in WorkspaceMessageItem.
const categoryPresentation: Record<AcpContextUsageCategoryKey, { label: string; color: string }> = {
  system: { label: 'System prompt', color: 'bg-chart-2' },
  tools: { label: 'Tools and agents', color: 'bg-chart-3' },
  messages: { label: 'Messages', color: 'bg-chart-4' },
  mcp: { label: 'Connectors and MCP', color: 'bg-chart-1' },
  skills: { label: 'Skills', color: 'bg-chart-5' },
  other: { label: 'Agent/framework overhead', color: 'bg-muted-foreground/40' }
}

const visibleCategories = (usage: AcpContextUsage): AcpContextUsageCategory[] =>
  usage.breakdown?.categories.filter((category) => category.tokens > 0) ?? []

// Per-call stacked-bar segments, bottom to top. When the adapter does not split cache into
// read/write, a single Cache segment spans both (cache-read color).
type CallSegmentKey = 'input' | 'cache-read' | 'cache-write' | 'cache' | 'output'

// Catalog keys stay unresolved at module scope so changing locale updates every render site.
// Segment colors mirror the message Usage popover in WorkspaceMessageItem: Input is the deep
// blue chart-1, Cache read its light tint (cache is reused input), Cache write amber chart-3,
// Output green chart-2 — the same metric keeps the same color app-wide.
const callSegmentPresentation: Record<CallSegmentKey, { label: string; color: string }> = {
  input: { label: 'Input', color: 'bg-chart-1' },
  'cache-read': { label: 'Cache read', color: 'bg-chart-1/40' },
  'cache-write': { label: 'Cache write', color: 'bg-chart-3' },
  cache: { label: 'Cache', color: 'bg-chart-1/40' },
  output: { label: 'Output', color: 'bg-chart-2' }
}

type CallTokenSegment = Readonly<{ key: CallSegmentKey; tokens: number }>

const callTokenSegments = (call: AcpModelCallUsage): CallTokenSegment[] => {
  const segments: CallTokenSegment[] = [{ key: 'input', tokens: call.inputTokens }]
  if (call.cachedReadTokens !== undefined && call.cachedWriteTokens !== undefined) {
    segments.push(
      { key: 'cache-read', tokens: call.cachedReadTokens },
      { key: 'cache-write', tokens: call.cachedWriteTokens }
    )
  } else {
    segments.push({ key: 'cache', tokens: call.cacheTokens })
  }
  segments.push({ key: 'output', tokens: call.outputTokens })
  return segments
}

const callTotalTokens = (call: AcpModelCallUsage): number =>
  call.inputTokens + call.cacheTokens + call.outputTokens

const signedTokens = (tokens: number): string => `${tokens > 0 ? '+' : ''}${formatTokens(tokens)}`

// Catalog keys, not resolved copy. `satisfies` makes an upstream-added reason a compile failure.
const stopReasonLabel = {
  end_turn: 'Completed',
  max_tokens: 'Max tokens',
  max_turn_requests: 'Turn limit',
  refusal: 'Refused',
  cancelled: 'Interrupted'
} satisfies Record<AcpPromptStopReason, string>

type PointPresentation = Readonly<{
  label: string
  code: string
  color: string
  ring: string
  icon: LucideIcon
}>

const pointState = (point: ContextWindowTrendPoint): PointPresentation => {
  const termination = point.sample.termination
  if (termination.kind === 'error') {
    return {
      label: 'Error',
      code: 'error',
      color: 'text-danger-000',
      ring: 'ring-danger-000',
      icon: AlertCircle
    }
  }
  const interrupted = termination.stopReason === 'cancelled'
  return {
    label: stopReasonLabel[termination.stopReason],
    code: termination.stopReason,
    color: interrupted ? 'text-warning-900' : 'text-muted-foreground',
    ring: interrupted ? 'ring-warning-900' : 'ring-transparent',
    icon: interrupted ? CircleStop : CheckCircle2
  }
}

const sourceLabel = {
  'provider-response': 'Provider response',
  'provider-update': 'Provider update',
  'local-estimate': 'Local estimate'
} as const

const CompositionStrip = ({
  usage,
  className = 'h-3'
}: {
  usage: AcpContextUsage
  className?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
  const visualTotal = Math.max(usage.used, categoryTotal)
  const occupancy = usage.size ? Math.min(100, (visualTotal / usage.size) * 100) : 100

  return (
    <div
      className={cn('flex overflow-hidden rounded-full bg-muted', className)}
      data-slot="context-composition-strip"
      aria-label={
        usage.size
          ? t('Estimated category occupancy: {{used}} of {{size}} tokens', {
              used: formatTokens(visualTotal),
              size: formatTokens(usage.size)
            })
          : t('Estimated category distribution: {{used}} tokens', {
              used: formatTokens(visualTotal)
            })
      }
    >
      {categories.map((category) => (
        <span
          key={category.key}
          className={cn(
            'h-full border-r border-background/80 last:border-r-0',
            categoryPresentation[category.key].color
          )}
          style={{ width: `${categoryTotal ? (category.tokens / categoryTotal) * occupancy : 0}%` }}
          title={`${t(categoryPresentation[category.key].label)}: ${formatTokens(category.tokens)}`}
        />
      ))}
    </div>
  )
}

const CategoryLegend = ({ usage }: { usage: AcpContextUsage }): React.JSX.Element => {
  const { t } = useTranslation()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)

  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3"
      data-slot="context-category-legend"
    >
      {categories.map((category) => (
        <div
          key={category.key}
          className="flex min-w-0 items-center justify-between gap-3 text-[11px]"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-[2px]',
                categoryPresentation[category.key].color
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-foreground">
              {t(categoryPresentation[category.key].label)}
            </span>
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {category.estimated ? '~' : ''}
            {formatTokens(category.tokens)}{' '}
            {categoryTotal ? `${Math.round((category.tokens / categoryTotal) * 100)}%` : '0%'}
          </span>
        </div>
      ))}
    </div>
  )
}

const BreakdownDiagnostics = ({ usage }: { usage: AcpContextUsage }): React.JSX.Element | null => {
  const { t } = useTranslation()
  const breakdown = usage.breakdown
  if (!breakdown) return null

  return (
    <div className="text-[11px] leading-4 text-muted-foreground" data-slot="context-diagnostics">
      {breakdown.status === 'reconciled' ? (
        <span className="tabular-nums">
          {t('Local {{local}} · Agent {{agent}} · Δ {{difference}}', {
            local: formatTokens(breakdown.estimatedTokens),
            agent: formatTokens(usage.used),
            difference: signedTokens(breakdown.difference)
          })}
        </span>
      ) : usage.agentUsed !== undefined ? (
        <span className="tabular-nums">
          {t('Local {{local}} · Latest Agent {{agent}}', {
            local: formatTokens(breakdown.estimatedTokens),
            agent: formatTokens(usage.agentUsed)
          })}
        </span>
      ) : (
        <span>{t('Local estimate updates while the Agent is generating.')}</span>
      )}
    </div>
  )
}

const CurrentComposition = ({
  usage,
  model
}: {
  usage: AcpContextUsage
  model?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const categories = visibleCategories(usage)
  const percent = usage.size ? Math.round((usage.used / usage.size) * 100) : undefined

  return (
    <section
      aria-labelledby="current-composition-title"
      className="overflow-hidden rounded-lg border border-border bg-card"
      data-slot="current-composition"
    >
      <div className="p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 id="current-composition-title" className="text-sm font-medium text-foreground">
            {t('Current composition')}
          </h3>
          {model ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{model}</span>
          ) : null}
        </div>
        {/* The ratio strip leads the card at full width so the category mix reads at a glance. */}
        <div className="mt-3">
          <CompositionStrip usage={usage} className="h-4" />
        </div>
        <div className="mt-4 grid min-w-0 gap-5 lg:grid-cols-[minmax(12rem,0.72fr)_minmax(0,1.28fr)] lg:gap-8">
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline justify-between gap-x-3">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                  {formatTokens(usage.used)}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {usage.size
                    ? t('/ {{size}} tokens', { size: formatTokens(usage.size) })
                    : t('tokens')}
                </span>
              </div>
              {percent === undefined ? null : (
                <span className="shrink-0 text-xs font-medium tabular-nums text-primary">
                  {percent}%
                </span>
              )}
            </div>
            <div className="mt-3">
              <BreakdownDiagnostics usage={usage} />
            </div>
          </div>

          <div className="min-w-0 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            {categories.length ? (
              <CategoryLegend usage={usage} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('Category breakdown is unavailable for this snapshot.')}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

const PointDetails = ({
  point,
  contained = false
}: {
  point: ContextWindowTrendPoint
  contained?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const frameworks = useSettingsStore((state) => state.agentFrameworks)
  const providers = useSettingsStore((state) => state.providers)
  const state = pointState(point)
  const StateIcon = state.icon
  const framework = frameworks.find((candidate) => candidate.id === point.runtime?.frameworkId)
  const providerId = resolveSessionProviderId(point.runtime?.backendId)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const frameworkLabel = framework?.displayName ?? point.runtime?.frameworkId
  const providerLabel = provider?.name ?? point.runtime?.backendId
  const usage = point.sample.contextWindow
  const categories = visibleCategories(usage)
  const modelStepUsage = point.sample.modelStepUsage
  const recoverableCodexCacheRead =
    point.runtime?.frameworkId === 'codex' &&
    point.sample.source === 'provider-response' &&
    modelStepUsage !== undefined &&
    modelStepUsage.cachedReadTokens === undefined &&
    Number.isSafeInteger(modelStepUsage.inputTokens + modelStepUsage.cacheTokens) &&
    usage.used === modelStepUsage.inputTokens + modelStepUsage.cacheTokens
      ? modelStepUsage.cacheTokens
      : undefined
  const cachedReadTokens = modelStepUsage?.cachedReadTokens ?? recoverableCodexCacheRead
  const uncachedTokens = modelStepUsage?.inputTokens
  const modelInputTokens =
    cachedReadTokens === undefined || uncachedTokens === undefined
      ? undefined
      : cachedReadTokens + uncachedTokens
  const cacheReadPercent =
    cachedReadTokens !== undefined && modelInputTokens !== undefined && modelInputTokens > 0
      ? Math.round((cachedReadTokens / modelInputTokens) * 100)
      : undefined

  return (
    <section
      className={cn(
        'min-w-0 bg-card p-4 text-xs sm:p-5',
        !contained && 'rounded-lg border border-border'
      )}
      data-slot="context-window-point-details"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground" data-slot="context-window-point-title">
            {t('Run {{runNumber}} · Message {{messageNumber}}', {
              runNumber: point.runNumber,
              messageNumber: point.messageNumber
            })}
          </h3>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={point.prompt}>
            {point.prompt || t('Empty prompt')}
          </div>
        </div>
        <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', state.color)}>
          <StateIcon className="size-3.5" aria-hidden="true" />
          {t(state.label)}
        </span>
      </div>

      <div className="mt-3 grid min-w-0 gap-4 border-y border-border py-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{t('Window used')}</span>
            <span className="font-medium tabular-nums text-foreground">
              {formatTokens(usage.used)}
              {usage.size ? (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  / {formatTokens(usage.size)}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-2">
            <CompositionStrip usage={usage} />
          </div>
          {categories.length ? (
            <div className="mt-3">
              <CategoryLegend usage={usage} />
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('Category breakdown is unavailable for this run.')}
            </p>
          )}
          <div
            className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex-nowrap"
            data-slot="context-diagnostics-row"
          >
            <BreakdownDiagnostics usage={usage} />
            {cacheReadPercent === undefined ? null : (
              <div className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {t('cache-read {{cached}}% · uncached {{uncached}}%', {
                  cached: cacheReadPercent,
                  uncached: 100 - cacheReadPercent
                })}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-1 text-[11px] leading-4 text-muted-foreground">
          {frameworkLabel || point.agentName ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Bot className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">
                {t('Agent:')} {point.agentName ?? frameworkLabel}
                {point.agentName && frameworkLabel ? ` · ${frameworkLabel}` : ''}
              </span>
            </div>
          ) : null}
          {point.runtime?.model || providerLabel ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Brain className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate" title={point.runtime?.model}>
                {t('Model:')} {point.runtime?.model ?? t('Unknown')}
                {providerLabel ? ` · ${providerLabel}` : ''}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1 text-[10px]">
            <span>{t(sourceLabel[point.sample.source])}</span>
            <span className="shrink-0 tabular-nums">{formatDate(point.sample.timestamp)}</span>
          </div>
        </div>
      </div>
      <div className="sr-only">
        {t('Terminal state code:')} {state.code}
      </div>
    </section>
  )
}

const ContextHistoryChart = ({
  points,
  activeIndex,
  pinnedIndex,
  onPreview,
  onSelect
}: {
  points: ContextWindowTrendPoint[]
  activeIndex: number
  pinnedIndex: number
  onPreview: (index: number | undefined) => void
  onSelect: (index: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  // Scale to the usage data, never to capacity: a window far larger than every run would squash
  // all bars onto the baseline. Capacity dashes render only when they land inside this range.
  const maximum = Math.max(1, ...points.map((point) => point.sample.contextWindow.used))
  const chartWidth = Math.max(560, points.length * 38 + 16)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [points.length])

  return (
    <div className="flex min-w-0" data-slot="context-window-trend-chart">
      <div
        className="flex h-60 w-12 shrink-0 flex-col justify-between border-r border-border py-2 pr-2 text-right text-[10px] tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        <span>{formatTokens(maximum)}</span>
        <span>{formatTokens(maximum / 2)}</span>
        <span>0</span>
      </div>
      <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div
          className="relative h-60 min-w-full"
          style={{ width: `${chartWidth}px` }}
          role="group"
          aria-label={t('Context window chart across {{count}} terminal outcomes', {
            count: points.length
          })}
        >
          <div
            className="pointer-events-none absolute inset-x-0 inset-y-2 flex flex-col justify-between"
            aria-hidden="true"
          >
            <span className="border-t border-border" />
            <span className="border-t border-border" />
            <span className="border-t border-border" />
          </div>
          <div className="absolute inset-0 flex items-end justify-start gap-0.5 px-2">
            {points.map((point, index) => {
              const usage = point.sample.contextWindow
              const categories = visibleCategories(usage)
              const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
              const state = pointState(point)
              const isActive = activeIndex === index
              const isPinned = pinnedIndex === index
              return (
                <div
                  key={point.sample.id}
                  className="relative flex h-full w-9 shrink-0 items-end justify-center pb-7 pt-2"
                >
                  <button
                    type="button"
                    data-slot="context-window-point"
                    data-active={isActive ? 'true' : undefined}
                    aria-pressed={isPinned}
                    aria-label={t('Run {{run}}, {{state}}, {{tokens}} context-window tokens', {
                      run: point.runNumber,
                      state: t(state.label),
                      tokens: formatDisplayNumber(usage.used)
                    })}
                    onPointerEnter={() => onPreview(index)}
                    onPointerLeave={() => onPreview(undefined)}
                    onFocus={() => onPreview(index)}
                    onBlur={() => onPreview(undefined)}
                    onClick={() => onSelect(index)}
                    className={cn(
                      'group relative flex h-full w-9 items-end justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    {usage.size !== undefined && usage.size <= maximum ? (
                      <span
                        className="pointer-events-none absolute inset-x-1 border-t border-dashed border-success-000"
                        style={{ bottom: `${(usage.size / maximum) * 100}%` }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className={cn(
                        'relative flex min-h-0 w-8 flex-col-reverse overflow-hidden rounded-t-[2px] ring-2 transition-shadow duration-150 motion-reduce:transition-none group-hover:ring-ring/40 group-focus-visible:ring-ring/60',
                        // Solid primary only as the no-breakdown fallback; with categories the
                        // segments fill the bar and a base color would bleed through the seams.
                        categories.length === 0 && 'bg-primary',
                        state.ring,
                        isActive && 'ring-ring/60',
                        isPinned && 'ring-foreground'
                      )}
                      data-slot="context-window-bar"
                      style={{ height: `${Math.max(2, (usage.used / maximum) * 100)}%` }}
                      aria-hidden="true"
                    >
                      {categories.map((category) => (
                        <span
                          key={category.key}
                          className={cn('w-full', categoryPresentation[category.key].color)}
                          style={{
                            height: `${categoryTotal ? (category.tokens / categoryTotal) * 100 : 0}%`
                          }}
                        />
                      ))}
                    </span>
                  </button>
                  <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[10px] tabular-nums text-muted-foreground">
                    {point.runNumber}
                  </span>
                  {point.compactedAfter ? (
                    <span
                      className="absolute -right-2.5 bottom-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground"
                      data-slot="context-window-compaction-marker"
                      role="img"
                      title={t('Context compacted after run {{run}}', { run: point.runNumber })}
                      aria-label={t('Context compacted after run {{run}}', {
                        run: point.runNumber
                      })}
                    >
                      <Minimize2 className="size-3" aria-hidden="true" />
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

const ContextHistory = ({ points }: { points: ContextWindowTrendPoint[] }): React.JSX.Element => {
  const { t } = useTranslation()
  const [pinnedSampleId, setPinnedSampleId] = useState<string>()
  const [previewIndex, setPreviewIndex] = useState<number>()
  const selectedIndex = pinnedSampleId
    ? points.findIndex((point) => point.sample.id === pinnedSampleId)
    : -1
  const pinnedIndex = selectedIndex >= 0 ? selectedIndex : points.length - 1
  const activeIndex = previewIndex ?? pinnedIndex
  const activePoint = points[activeIndex] ?? points.at(-1)
  // Match the chart: the Capacity chip only makes sense when a capacity dash can render inside
  // the data-scaled range.
  const maxUsed = Math.max(1, ...points.map((point) => point.sample.contextWindow.used))
  const capacityVisible = points.some((point) => {
    const size = point.sample.contextWindow.size
    return size !== undefined && size <= maxUsed
  })

  return (
    <section aria-labelledby="context-window-history-title" data-slot="context-window-history">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 id="context-window-history-title" className="text-sm font-medium text-foreground">
            {t('History')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'One bar per terminal run; hover or focus to preview, then select to keep details visible.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2.5 w-4 rounded-[2px] bg-primary" aria-hidden="true" />
            {t('Window used')}
          </span>
          {capacityVisible ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-4 border-t border-dashed border-success-000" aria-hidden="true" />
              {t('Capacity')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ContextHistoryChart
          points={points}
          activeIndex={activeIndex}
          pinnedIndex={pinnedIndex}
          onPreview={setPreviewIndex}
          onSelect={(index) =>
            setPinnedSampleId((current) =>
              current === points[index]?.sample.id || index === points.length - 1
                ? undefined
                : points[index]?.sample.id
            )
          }
        />
        {activePoint ? (
          <div className="border-t border-border">
            <PointDetails point={activePoint} contained />
          </div>
        ) : null}
      </div>
    </section>
  )
}

type ContextWindowGranularity = 'turn' | 'call'

const ContextCallSummary = ({
  summary
}: {
  summary: ContextWindowCallSummary
}): React.JSX.Element => {
  const { t } = useTranslation()
  const totalTokens = summary.inputTokens + summary.cacheTokens + summary.outputTokens
  const peakPercent =
    summary.peakContextUsedTokens !== undefined &&
    summary.contextWindowSize !== undefined &&
    summary.contextWindowSize > 0
      ? Math.round((summary.peakContextUsedTokens / summary.contextWindowSize) * 100)
      : undefined
  const metrics: { label: string; value: string; hint?: string }[] = [
    {
      label: t('Total calls'),
      value: t('{{count}} calls', {
        count: summary.callCount,
        defaultValue_one: '{{count}} call'
      })
    },
    {
      label: t('Total tokens'),
      value: formatTokens(totalTokens),
      hint: t('In {{in}} · Cache {{cache}} · Out {{out}}', {
        in: formatTokens(summary.inputTokens),
        cache: formatTokens(summary.cacheTokens),
        out: formatTokens(summary.outputTokens)
      })
    },
    {
      label: t('Peak window'),
      value:
        summary.peakContextUsedTokens === undefined
          ? '—'
          : `${formatTokens(summary.peakContextUsedTokens)}${
              summary.contextWindowSize === undefined
                ? ''
                : ` / ${formatTokens(summary.contextWindowSize)}`
            }${peakPercent === undefined ? '' : ` · ${peakPercent}%`}`
    }
  ]

  return (
    <section
      className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5"
      data-slot="context-call-summary"
      aria-label={t('Session call summary')}
    >
      <h3 className="text-sm font-medium text-foreground">{t('Session call summary')}</h3>
      <div
        className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-border pt-3 lg:grid-cols-3"
        data-slot="context-call-metrics"
      >
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0">
            <div className="text-[11px] text-muted-foreground">{metric.label}</div>
            <div className="mt-1 truncate text-base font-semibold tracking-tight tabular-nums text-foreground sm:text-xl">
              {metric.value}
            </div>
            {metric.hint === undefined ? null : (
              <div className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
                {metric.hint}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

const ContextCallChart = ({
  bands,
  activeCallId,
  pinnedCallId,
  onPreview,
  onSelect
}: {
  bands: readonly ContextWindowCallTurnBand[]
  activeCallId?: string
  pinnedCallId?: string
  onPreview: (callId: string | undefined) => void
  onSelect: (callId: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const points = bands.flatMap((band) => band.calls)
  const callCount = points.length
  // Scale to the call data. Bar height is the billing-style total (input + cache + output), so
  // window capacity — a context-usage limit — is not plotted on this axis; it lives in the
  // per-call details panel instead.
  const maximum = Math.max(1, ...points.map((point) => callTotalTokens(point.call)))
  const chartWidth = Math.max(560, callCount * 38 + bands.length * 24 + 16)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [callCount])

  return (
    <div className="flex min-w-0" data-slot="context-call-chart">
      <div
        className="flex h-60 w-12 shrink-0 flex-col justify-between border-r border-border py-2 pr-2 text-right text-[10px] tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        <span>{formatTokens(maximum)}</span>
        <span>{formatTokens(maximum / 2)}</span>
        <span>0</span>
      </div>
      <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div
          className="relative h-60 min-w-full"
          style={{ width: `${chartWidth}px` }}
          role="group"
          aria-label={t('Call usage chart across {{count}} model calls', {
            count: callCount,
            defaultValue_one: 'Call usage chart across {{count}} model call'
          })}
        >
          <div
            className="pointer-events-none absolute inset-x-0 inset-y-2 flex flex-col justify-between"
            aria-hidden="true"
          >
            <span className="border-t border-border" />
            <span className="border-t border-border" />
            <span className="border-t border-border" />
          </div>
          <div className="absolute inset-0 flex items-end justify-start px-2">
            {bands.map((band, bandIndex) => (
              <div
                key={band.turnNumber}
                className={cn(
                  'relative flex h-full items-end gap-0.5 pb-7 pt-2',
                  bandIndex > 0 && 'ml-3'
                )}
                data-slot="context-call-band"
              >
                {band.calls.map((point) => {
                  const total = callTotalTokens(point.call)
                  const isActive = activeCallId === point.call.id
                  const isPinned = pinnedCallId === point.call.id
                  return (
                    <div
                      key={point.call.id}
                      className="relative flex h-full w-9 shrink-0 items-end justify-center"
                    >
                      <button
                        type="button"
                        data-slot="context-call-point"
                        data-active={isActive ? 'true' : undefined}
                        aria-pressed={isPinned}
                        aria-label={t('Turn {{turn}} · Call {{call}}, {{tokens}} tokens', {
                          turn: point.turnNumber,
                          call: point.callNumber,
                          tokens: formatDisplayNumber(total)
                        })}
                        onPointerEnter={() => onPreview(point.call.id)}
                        onPointerLeave={() => onPreview(undefined)}
                        onFocus={() => onPreview(point.call.id)}
                        onBlur={() => onPreview(undefined)}
                        onClick={() => onSelect(point.call.id)}
                        className={cn(
                          'group relative flex h-full w-9 items-end justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                        )}
                      >
                        <span
                          className={cn(
                            'relative flex min-h-0 w-8 flex-col-reverse overflow-hidden rounded-t-[2px] ring-2 ring-transparent transition-shadow duration-150 motion-reduce:transition-none group-hover:ring-ring/40 group-focus-visible:ring-ring/60',
                            isActive && 'ring-ring/60',
                            isPinned && 'ring-foreground'
                          )}
                          data-slot="context-call-bar"
                          style={{ height: `${Math.max(2, (total / maximum) * 100)}%` }}
                          aria-hidden="true"
                        >
                          {callTokenSegments(point.call).map((segment) => (
                            <span
                              key={segment.key}
                              className={cn('w-full', callSegmentPresentation[segment.key].color)}
                              style={{ height: `${total ? (segment.tokens / total) * 100 : 0}%` }}
                            />
                          ))}
                        </span>
                      </button>
                    </div>
                  )
                })}
                {/* One gray lane per turn: the label sits inside the lane so each turn reads as
                    a single grouped block under its calls. */}
                <span className="pointer-events-none absolute inset-x-0 bottom-1 flex h-5 items-center justify-center rounded-md bg-muted text-[10px] tabular-nums text-muted-foreground">
                  {t('T{{turn}}', { turn: band.turnNumber })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const ContextCallDetails = ({ point }: { point: ContextWindowCallPoint }): React.JSX.Element => {
  const { t } = useTranslation()
  const frameworks = useSettingsStore((state) => state.agentFrameworks)
  const providers = useSettingsStore((state) => state.providers)
  const framework = frameworks.find((candidate) => candidate.id === point.runtime?.frameworkId)
  const providerId = resolveSessionProviderId(point.runtime?.backendId)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const frameworkLabel = framework?.displayName ?? point.runtime?.frameworkId
  const providerLabel = provider?.name ?? point.runtime?.backendId
  const used = point.call.contextUsedTokens
  const size = point.call.contextWindowSize
  const occupancy =
    used !== undefined && size !== undefined && size > 0
      ? Math.min(100, Math.round((used / size) * 100))
      : undefined
  const segments = callTokenSegments(point.call)
  const total = callTotalTokens(point.call)
  const cachedReadTokens = point.call.cachedReadTokens
  const modelInputTokens =
    cachedReadTokens === undefined ? undefined : cachedReadTokens + point.call.inputTokens
  const cacheReadPercent =
    cachedReadTokens !== undefined && modelInputTokens !== undefined && modelInputTokens > 0
      ? Math.round((cachedReadTokens / modelInputTokens) * 100)
      : undefined

  return (
    <section className="min-w-0 bg-card p-4 text-xs sm:p-5" data-slot="context-call-details">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground" data-slot="context-call-details-title">
            {t('Turn {{turn}} · Call {{call}}', {
              turn: point.turnNumber,
              call: point.callNumber
            })}
          </h3>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={point.prompt}>
            {point.prompt || t('Empty prompt')}
          </div>
        </div>
        <div className="shrink-0 space-y-1 text-[11px] leading-4 text-muted-foreground">
          {frameworkLabel || point.agentName ? (
            <div className="flex items-center justify-end gap-1.5">
              <Bot className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="max-w-56 truncate">
                {t('Agent:')} {point.agentName ?? frameworkLabel}
                {point.agentName && frameworkLabel ? ` · ${frameworkLabel}` : ''}
              </span>
            </div>
          ) : null}
          {point.runtime?.model || providerLabel ? (
            <div className="flex items-center justify-end gap-1.5">
              <Brain className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="max-w-56 truncate" title={point.runtime?.model}>
                {t('Model:')} {point.runtime?.model ?? t('Unknown')}
                {providerLabel ? ` · ${providerLabel}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid min-w-0 gap-4 border-y border-border py-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{t('Window used')}</span>
            <span className="font-medium tabular-nums text-foreground">
              {used === undefined ? '—' : formatTokens(used)}
              {used !== undefined && size ? (
                <span className="font-normal text-muted-foreground"> / {formatTokens(size)}</span>
              ) : null}
            </span>
          </div>
          {occupancy === undefined ? null : (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              data-slot="context-call-window-meter"
              aria-hidden="true"
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${occupancy}%` }}
              />
            </div>
          )}
          <div className="mt-3 space-y-1.5" data-slot="context-call-token-mix">
            {segments.map((segment) => {
              const presentation = callSegmentPresentation[segment.key]
              const share = total > 0 ? (segment.tokens / total) * 100 : 0
              return (
                <div key={segment.key} className="flex items-center gap-2 text-[11px]">
                  <span
                    className={cn('size-2.5 shrink-0 rounded-[2px]', presentation.color)}
                    aria-hidden="true"
                  />
                  <span className="w-20 shrink-0 truncate text-muted-foreground">
                    {t(presentation.label)}
                  </span>
                  <span
                    className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <span
                      className={cn('block h-full rounded-full', presentation.color)}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    <span className="text-foreground">{formatTokens(segment.tokens)}</span>{' '}
                    {Math.round(share)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="min-w-0 space-y-1 text-[11px] leading-4 text-muted-foreground">
          <div className="tabular-nums">
            {cacheReadPercent === undefined
              ? '—'
              : t('cache-read {{cached}}% · uncached {{uncached}}%', {
                  cached: cacheReadPercent,
                  uncached: 100 - cacheReadPercent
                })}
          </div>
          <div className="tabular-nums">
            {t('Message {{messageNumber}}', { messageNumber: point.messageNumber })}
          </div>
        </div>
      </div>
    </section>
  )
}

const ContextCallEmptyState = (): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      className="grid min-h-64 place-items-center rounded-lg border border-dashed border-border bg-bg-100/40 px-6 text-center"
      data-slot="context-call-empty"
    >
      <div className="max-w-md">
        <Activity className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-medium text-foreground">{t('No call details yet')}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t(
            'This Session may predate call tracking, or its framework reported only aggregate turn usage.'
          )}
        </p>
      </div>
    </div>
  )
}

const ContextCallHistory = ({
  points
}: {
  points: readonly ContextWindowCallPoint[]
}): React.JSX.Element => {
  const { t } = useTranslation()
  const bands = useMemo(() => groupContextWindowCallsByTurn(points), [points])
  const [pinnedCallId, setPinnedCallId] = useState<string>()
  const [previewCallId, setPreviewCallId] = useState<string>()
  const pinnedPoint = points.find((point) => point.call.id === pinnedCallId) ?? points.at(-1)
  const activePoint =
    (previewCallId === undefined
      ? undefined
      : points.find((point) => point.call.id === previewCallId)) ?? pinnedPoint
  // Legend reflects the segments the providers actually reported: calls without a cache
  // read/write split get a single Cache entry instead of misleading read/write chips.
  const legendKeys = useMemo(() => {
    const present = new Set<CallSegmentKey>()
    for (const point of points) {
      for (const segment of callTokenSegments(point.call)) {
        if (segment.tokens > 0) present.add(segment.key)
      }
    }
    return (Object.keys(callSegmentPresentation) as CallSegmentKey[]).filter((key) =>
      present.has(key)
    )
  }, [points])

  return (
    <section aria-labelledby="context-call-history-title" data-slot="context-call-history">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 id="context-call-history-title" className="text-sm font-medium text-foreground">
            {t('Call history')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'One bar per model call; hover or focus to preview, then select to keep details visible.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {legendKeys.map((key) => (
            <span key={key} className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                className={cn('h-2.5 w-4 rounded-[2px]', callSegmentPresentation[key].color)}
                aria-hidden="true"
              />
              {t(callSegmentPresentation[key].label)}
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ContextCallChart
          bands={bands}
          activeCallId={activePoint?.call.id}
          pinnedCallId={pinnedPoint?.call.id}
          onPreview={setPreviewCallId}
          onSelect={(callId) =>
            setPinnedCallId((current) =>
              current === callId || callId === points.at(-1)?.call.id ? undefined : callId
            )
          }
        />
        {activePoint ? (
          <div className="border-t border-border">
            <ContextCallDetails point={activePoint} />
          </div>
        ) : null}
      </div>
    </section>
  )
}

type ContextWindowDialogDataProps = Pick<ContextWindowDialogProps, 'session' | 'contextUsage'> & {
  granularity: ContextWindowGranularity
}

// Radix mounts this child only while the dialog is present. Keep history projection here so a
// closed dialog does not rescan the active Session on every streaming message or tool update.
const ContextWindowDialogData = ({
  granularity,
  session,
  contextUsage
}: ContextWindowDialogDataProps): React.JSX.Element => {
  const { t } = useTranslation()
  const messages = session?.messages
  const activities = session?.activities
  const conversationGraph = session?.conversationGraph
  const points = useMemo(
    () =>
      granularity !== 'turn' || messages === undefined
        ? []
        : selectContextWindowTrendPoints({ activities, conversationGraph, messages }),
    [activities, conversationGraph, granularity, messages]
  )
  const latestPoint = points.at(-1)
  const currentUsage = contextUsage ?? latestPoint?.sample.contextWindow
  const callPoints = useMemo(
    () =>
      granularity !== 'call' || messages === undefined
        ? []
        : selectContextWindowCallPoints({ activities, conversationGraph, messages }),
    [activities, conversationGraph, granularity, messages]
  )
  const callSummary = useMemo(() => summarizeContextWindowCallPoints(callPoints), [callPoints])

  return (
    <div className="space-y-6">
      {granularity === 'turn' ? (
        <>
          {currentUsage ? (
            <CurrentComposition
              usage={currentUsage}
              model={session?.agentModel ?? latestPoint?.runtime?.model}
            />
          ) : null}
          {points.length ? (
            <ContextHistory points={points} />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-border bg-bg-100/40 px-6 text-center">
              <div className="max-w-sm">
                <Activity className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                <h3 className="mt-3 text-sm font-medium text-foreground">
                  {t('No run history yet')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    'A bar appears after a run completes, is interrupted, or ends with an error. Older sessions remain compatible and may not contain history data.'
                  )}
                </p>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <ContextCallSummary summary={callSummary} />
          {callPoints.length ? (
            <ContextCallHistory points={callPoints} />
          ) : (
            <ContextCallEmptyState />
          )}
        </>
      )}
    </div>
  )
}

const ContextWindowDialog = ({
  open,
  session,
  contextUsage,
  onOpenChange
}: ContextWindowDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [granularity, setGranularity] = useState<ContextWindowGranularity>('turn')
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          ref={contentRef}
          data-slot="context-window-dialog"
          aria-describedby="context-window-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus()
          }}
          className={dialogPanelClassName(
            'flex max-h-[min(820px,calc(100dvh-1.5rem))] w-[min(1040px,calc(100vw-1.5rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div
            className={cn(dialogHeaderClassName, 'items-start')}
            data-slot="context-window-dialog-header"
          >
            <div className="min-w-0 flex-1">
              <Dialog.Title className={dialogTitleClassName}>{t('Context window')}</Dialog.Title>
              <Dialog.Description
                id="context-window-description"
                className={dialogDescriptionClassName}
              >
                {t(
                  'Current composition and terminal-run history for the active branch. Category values are estimates.'
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(dialogCloseButtonClassName, '-mr-2 -mt-1 size-11')}
                aria-label={t('Close context window')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div
            className="flex flex-col gap-2 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
            data-slot="context-window-toolbar"
          >
            <SettingsSegmentedControl
              value={granularity}
              options={[
                { value: 'turn', label: t('Turns') },
                { value: 'call', label: t('Calls') }
              ]}
              onValueChange={setGranularity}
              ariaLabel={t('Usage detail level')}
            />
          </div>

          <div
            className={cn(dialogBodyClassName, 'min-h-0 flex-1 overflow-y-auto')}
            data-slot="context-window-dialog-body"
          >
            <ContextWindowDialogData
              granularity={granularity}
              session={session}
              contextUsage={contextUsage}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ContextWindowDialog }
