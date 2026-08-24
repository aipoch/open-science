/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: context-window dialog · genre: modern-minimal · theme: product tokens · contrast: pass (40–41) · mobile: pass (34, 49, 50–57) */
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
  AcpPromptStopReason
} from '../../../../shared/acp'
import {
  selectContextWindowTrendPoints,
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
const categoryPresentation: Record<AcpContextUsageCategoryKey, { label: string; color: string }> = {
  system: { label: 'System prompt', color: 'bg-emerald-500' },
  tools: { label: 'Tools and agents', color: 'bg-amber-400' },
  messages: { label: 'Messages', color: 'bg-violet-500' },
  mcp: { label: 'Connectors and MCP', color: 'bg-cyan-400' },
  skills: { label: 'Skills', color: 'bg-blue-500' },
  other: { label: 'Agent/framework overhead', color: 'bg-slate-400' }
}

const visibleCategories = (usage: AcpContextUsage): AcpContextUsageCategory[] =>
  usage.breakdown?.categories.filter((category) => category.tokens > 0) ?? []

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

const CompositionStrip = ({ usage }: { usage: AcpContextUsage }): React.JSX.Element => {
  const { t } = useTranslation()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
  const visualTotal = Math.max(usage.used, categoryTotal)
  const occupancy = usage.size ? Math.min(100, (visualTotal / usage.size) * 100) : 100

  return (
    <div
      className="flex h-3 overflow-hidden rounded-full bg-muted"
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

const CategoryLegend = ({
  usage,
  singleRow = false
}: {
  usage: AcpContextUsage
  singleRow?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)

  return (
    <div
      className={cn(
        'grid min-w-0 gap-x-5 gap-y-1.5',
        singleRow ? 'grid-flow-col auto-cols-fr' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
      )}
      data-slot="context-category-legend"
    >
      {categories.map((category) => (
        <div
          key={category.key}
          className="flex min-w-0 items-center justify-between gap-3 text-[11px]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-[2px]',
                categoryPresentation[category.key].color
              )}
              aria-hidden="true"
            />
            <span className="truncate text-foreground">
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
      className="rounded-lg border border-border bg-card p-4"
      data-slot="current-composition"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="current-composition-title" className="text-sm font-medium text-foreground">
          {t('Current composition')}
        </h3>
        {model ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{model}</span>
        ) : null}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {formatTokens(usage.used)}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {usage.size ? t('/ {{size}} tokens', { size: formatTokens(usage.size) }) : t('tokens')}
          {percent === undefined ? '' : ` (${percent}%)`}
        </span>
      </div>
      <div className="mt-3">
        <CompositionStrip usage={usage} />
      </div>
      {categories.length ? (
        <div className="mt-3">
          <CategoryLegend usage={usage} singleRow />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('Category breakdown is unavailable for this snapshot.')}
        </p>
      )}
      <div className="mt-2">
        <BreakdownDiagnostics usage={usage} />
      </div>
    </section>
  )
}

const PointDetails = ({ point }: { point: ContextWindowTrendPoint }): React.JSX.Element => {
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
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-xs"
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
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [
      point.sample.contextWindow.used,
      point.sample.contextWindow.size ?? 0
    ])
  )
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
                    {usage.size ? (
                      <span
                        className="pointer-events-none absolute inset-x-1 border-t border-dashed border-success-000"
                        style={{ bottom: `${Math.min(100, (usage.size / maximum) * 100)}%` }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className={cn(
                        'relative flex min-h-0 w-8 flex-col-reverse overflow-hidden rounded-t-[2px] bg-primary ring-2 transition-shadow duration-150 motion-reduce:transition-none group-hover:ring-ring/40 group-focus-visible:ring-ring/60',
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
          {points.some((point) => point.sample.contextWindow.size) ? (
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
      </div>
      <div className="mt-4">{activePoint ? <PointDetails point={activePoint} /> : null}</div>
    </section>
  )
}

const ContextWindowDialog = ({
  open,
  session,
  contextUsage,
  onOpenChange
}: ContextWindowDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const messages = session?.messages
  const activities = session?.activities
  const conversationGraph = session?.conversationGraph
  const points = useMemo(
    () =>
      messages === undefined
        ? []
        : selectContextWindowTrendPoints({ activities, conversationGraph, messages }),
    [activities, conversationGraph, messages]
  )
  const latestPoint = points.at(-1)
  const currentUsage = contextUsage ?? latestPoint?.sample.contextWindow
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
          <div className={dialogHeaderClassName} data-slot="context-window-dialog-header">
            <div className="min-w-0">
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
                className={dialogCloseButtonClassName}
                aria-label={t('Close context window')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div
            className={cn(dialogBodyClassName, 'min-h-0 flex-1 overflow-y-auto')}
            data-slot="context-window-dialog-body"
          >
            <div className="space-y-6">
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
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ContextWindowDialog }
