import { ChartNoAxesCombined, Info, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  PersistedChatSession,
  SessionUsageProjection
} from '../../../../shared/session-persistence'
import type { Project } from '../../../../shared/projects'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useRelativeTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import { SettingsIconAction } from './SettingsLayout'
import {
  buildTokenUsageAnalytics,
  buildTokenUsageAnalyticsFromProjection,
  selectTokenUsageSummary,
  tokenUsageMetricValue,
  type TokenUsageDailyPoint,
  type TokenUsageHeatmapMetric,
  type TokenUsagePeriod
} from './token-usage-analytics'

// Hallmark · macrostructure: Stat-Led · theme: application-native · tone: technical / utilitarian
// Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 · contrast: pass (40–41) · slop: pass

type TokenUsagePanelProps = {
  sessions: readonly PersistedChatSession[]
  projects: readonly Project[]
  now?: number
}

type UsageProjectionLoadResult = Readonly<{
  projection?: SessionUsageProjection
  failed?: boolean
  lastRefreshedAt?: number
}>

type LoadUsage = () => Promise<SessionUsageProjection>

const USAGE_PROJECTION_CACHE_TTL_MS = 10 * 60_000
const usageProjectionCache = new WeakMap<LoadUsage, UsageProjectionLoadResult>()

const readCachedUsageProjection = (
  loadUsage: LoadUsage | undefined
): UsageProjectionLoadResult | undefined => {
  if (!loadUsage) return undefined
  const cached = usageProjectionCache.get(loadUsage)
  return cached?.lastRefreshedAt !== undefined &&
    Date.now() - cached.lastRefreshedAt < USAGE_PROJECTION_CACHE_TTL_MS
    ? cached
    : undefined
}

const PERIODS: ReadonlyArray<{ value: TokenUsagePeriod; label: string; shortLabel: string }> = [
  { value: 'today', label: 'Today', shortLabel: 'Today' },
  { value: 'week', label: 'This week', shortLabel: 'Week' },
  { value: '30-days', label: 'Last 30 days', shortLabel: '30 days' },
  { value: 'all', label: 'All time', shortLabel: 'All' }
]

const HEATMAP_METRICS: ReadonlyArray<{
  value: TokenUsageHeatmapMetric
  label: string
}> = [
  { value: 'totalTokens', label: 'Total tokens' },
  { value: 'inputTokens', label: 'Input tokens' },
  { value: 'outputTokens', label: 'Output tokens' },
  { value: 'cacheTokens', label: 'Cache tokens' },
  { value: 'newConversations', label: 'New sessions' },
  { value: 'newProjects', label: 'New projects' },
  { value: 'newArtifacts', label: 'New artifacts' },
  { value: 'runs', label: 'Runs' }
]

const HEATMAP_INTENSITY_CLASSES = [
  'border-border bg-muted/35',
  'border-primary/15 bg-primary/15',
  'border-primary/25 bg-primary/30',
  'border-primary/35 bg-primary/45',
  'border-primary/45 bg-primary/65',
  'border-primary/55 bg-primary/90'
] as const

const heatmapIntensity = (value: number, maximum: number): number => {
  if (value <= 0 || maximum <= 0) return 0
  return Math.min(5, Math.max(1, Math.ceil((value / maximum) * 5)))
}

const tokenScaleMaximum = (maximum: number): number => {
  if (!Number.isFinite(maximum) || maximum <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(maximum))
  return Math.ceil(maximum / magnitude) * magnitude
}

const metricLabel = (metric: TokenUsageHeatmapMetric): string =>
  HEATMAP_METRICS.find((candidate) => candidate.value === metric)?.label ?? 'Total tokens'

function TokenUsagePanel({
  sessions,
  projects,
  now: providedNow
}: TokenUsagePanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const formatRelative = useRelativeTimeFormat()
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now())
  const now = providedNow ?? currentTime
  const [period, setPeriod] = useState<TokenUsagePeriod>('30-days')
  const [heatmapMetric, setHeatmapMetric] = useState<TokenUsageHeatmapMetric>('totalTokens')
  const loadUsage = window.api?.sessions?.loadUsage
  const [initialCachedUsageProjection] = useState(() => readCachedUsageProjection(loadUsage))
  const [usageProjectionLoadResult, setUsageProjectionLoadResult] = useState<
    UsageProjectionLoadResult | undefined
  >(initialCachedUsageProjection)
  const [usageProjectionLoadAttempt, setUsageProjectionLoadAttempt] = useState(0)
  const canLoadUsageProjection = typeof loadUsage === 'function'
  const [isUsageProjectionRefreshing, setIsUsageProjectionRefreshing] = useState(
    canLoadUsageProjection && initialCachedUsageProjection === undefined
  )
  const usageProjection = usageProjectionLoadResult?.projection
  const usageProjectionLoadSettled = usageProjectionLoadResult !== undefined
  const usageProjectionLoadFailed = usageProjectionLoadResult?.failed === true
  const lastRefreshedAt = usageProjectionLoadResult?.lastRefreshedAt

  useEffect(() => {
    if (typeof loadUsage !== 'function') return
    if (usageProjectionLoadAttempt === 0 && initialCachedUsageProjection !== undefined) return
    let active = true
    void loadUsage()
      .then((projection) => {
        if (!active) return
        const refreshedAt = Date.now()
        const result = { projection, lastRefreshedAt: refreshedAt }
        usageProjectionCache.set(loadUsage, result)
        setUsageProjectionLoadResult(result)
        setCurrentTime(refreshedAt)
        setRelativeTimeNow(refreshedAt)
      })
      .catch(() => {
        if (active) setUsageProjectionLoadResult((current) => ({ ...current, failed: true }))
      })
      .finally(() => {
        if (active) setIsUsageProjectionRefreshing(false)
      })
    return () => {
      active = false
    }
  }, [initialCachedUsageProjection, loadUsage, usageProjectionLoadAttempt])

  useEffect(() => {
    if (lastRefreshedAt === undefined) return
    const intervalId = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [lastRefreshedAt])

  useEffect(() => {
    if (providedNow !== undefined) return

    let timeoutId: number
    const scheduleNextLocalDay = (): void => {
      const timestamp = Date.now()
      const nextDay = new Date(timestamp)
      nextDay.setHours(24, 0, 0, 0)
      timeoutId = window.setTimeout(
        () => {
          setCurrentTime(Date.now())
          scheduleNextLocalDay()
        },
        Math.max(1_000, nextDay.getTime() - timestamp + 1_000)
      )
    }

    scheduleNextLocalDay()
    return () => window.clearTimeout(timeoutId)
  }, [providedNow])

  const analytics = useMemo(
    () =>
      usageProjection
        ? buildTokenUsageAnalyticsFromProjection(usageProjection, now)
        : buildTokenUsageAnalytics(sessions, now, projects),
    [sessions, usageProjection, now, projects]
  )
  const summary = useMemo(() => selectTokenUsageSummary(analytics, period), [analytics, period])
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }),
    [i18n.language]
  )
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }),
    [i18n.language]
  )
  const compactNumberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
    [i18n.language]
  )
  const shortDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }),
    [i18n.language]
  )
  const fullDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }),
    [i18n.language]
  )

  const formatNumber = (value: number): string => numberFormatter.format(value)
  const formatTokenAxisValue = (value: number): string => {
    const units = [
      { threshold: 1_000_000_000, suffix: 'B' },
      { threshold: 1_000_000, suffix: 'M' },
      { threshold: 1_000, suffix: 'k' }
    ] as const
    const unit = units.find((candidate) => value >= candidate.threshold)
    return unit
      ? `${compactNumberFormatter.format(value / unit.threshold)}${unit.suffix}`
      : compactNumberFormatter.format(value)
  }
  const heatmapMaximum = Math.max(
    0,
    ...analytics.last30Days.map((point) => tokenUsageMetricValue(point, heatmapMetric))
  )
  const tokenMaximum = Math.max(0, ...analytics.last30Days.map((point) => point.totalTokens))
  const chartScaleMaximum = tokenScaleMaximum(tokenMaximum)
  const last30DaysTotal = analytics.last30Days.reduce(
    (total, point) => total + point.totalTokens,
    0
  )
  const tokenSummaryItems: ReadonlyArray<{
    label: string
    value: string
    featured?: boolean
    detailLabel?: string
    detailValue?: string
  }> = [
    { label: 'Total tokens', value: formatNumber(summary.totalTokens), featured: true },
    { label: 'Input tokens', value: formatNumber(summary.inputTokens) },
    {
      label: 'Cache tokens',
      value: formatNumber(summary.cacheTokens),
      detailLabel: 'Cache share',
      detailValue: summary.cacheShare === null ? '—' : percentFormatter.format(summary.cacheShare)
    },
    { label: 'Output tokens', value: formatNumber(summary.outputTokens) }
  ]
  const entitySummaryItems: ReadonlyArray<{
    newLabel?: string
    newValue?: string
    totalLabel: string
    totalValue: string
  }> = [
    {
      newLabel: 'New sessions',
      newValue: formatNumber(summary.newConversations),
      totalLabel: 'Total sessions',
      totalValue: formatNumber(summary.totalSessions)
    },
    {
      newLabel: 'New projects',
      newValue: formatNumber(summary.newProjects),
      totalLabel: 'Total projects',
      totalValue: formatNumber(summary.totalProjects)
    },
    {
      newLabel: 'New runs',
      newValue: formatNumber(summary.newRuns),
      totalLabel: 'Total runs',
      totalValue: formatNumber(summary.totalRuns)
    },
    {
      newLabel: 'New artifacts',
      newValue: formatNumber(summary.newArtifacts),
      totalLabel: 'Total artifacts',
      totalValue: formatNumber(summary.totalArtifacts)
    }
  ]

  const heatmapCellLabel = (point: TokenUsageDailyPoint): string =>
    t('{{date}}: {{value}} {{metric}}', {
      date: fullDateFormatter.format(point.dayStart),
      value: formatNumber(tokenUsageMetricValue(point, heatmapMetric)),
      metric: t(metricLabel(heatmapMetric)).toLocaleLowerCase(i18n.language)
    })

  const stackedBarLabel = (point: TokenUsageDailyPoint): string =>
    t('{{date}}: {{input}} input, {{cache}} cache, {{output}} output', {
      date: fullDateFormatter.format(point.dayStart),
      input: formatNumber(point.inputTokens),
      cache: formatNumber(point.cacheTokens),
      output: formatNumber(point.outputTokens)
    })

  const refreshUsageProjection = (): void => {
    setIsUsageProjectionRefreshing(true)
    setUsageProjectionLoadResult((current) =>
      current?.projection ? { ...current, failed: false } : undefined
    )
    setUsageProjectionLoadAttempt((attempt) => attempt + 1)
  }

  if (canLoadUsageProjection && usageProjectionLoadFailed && usageProjection === undefined) {
    return (
      <div data-slot="token-usage-panel" className="min-w-0 overflow-x-clip">
        <div role="alert" data-slot="token-usage-load-error" className="px-4 py-6 sm:px-5">
          <p className="text-sm text-destructive">{t('Could not load token usage.')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={refreshUsageProjection}
          >
            {t('Try again')}
          </Button>
        </div>
      </div>
    )
  }

  if (canLoadUsageProjection && usageProjection === undefined && !usageProjectionLoadSettled) {
    return (
      <div data-slot="token-usage-panel" className="min-w-0 overflow-x-clip">
        <p
          role="status"
          data-slot="token-usage-loading"
          className="px-4 py-6 text-sm text-muted-foreground sm:px-5"
        >
          {t('Loading…')}
        </p>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div data-slot="token-usage-panel" className="min-w-0 overflow-x-clip">
        <section className="flex flex-col gap-5 px-4 pb-5 pt-6 sm:px-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="min-w-0 max-w-xl">
              <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">
                {t('Token usage')}
              </h1>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t('Review token volume, daily composition, and conversation activity.')}
              </p>
            </div>
            <div
              role="group"
              aria-label={t('Time range')}
              className="grid w-full grid-cols-4 gap-1 rounded-lg bg-muted p-1 lg:w-auto"
            >
              {PERIODS.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t(item.label)}
                  aria-pressed={period === item.value}
                  className={cn(
                    'h-9 min-w-0 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground',
                    period === item.value &&
                      'bg-card text-foreground shadow-sm hover:bg-card hover:text-foreground'
                  )}
                  onClick={() => setPeriod(item.value)}
                >
                  <span className="sm:hidden">{t(item.shortLabel)}</span>
                  <span className="hidden sm:inline">{t(item.label)}</span>
                </Button>
              ))}
            </div>
          </div>

          {canLoadUsageProjection ? (
            <div className="-mt-2 flex min-h-7 items-center justify-between gap-3">
              <p
                role="status"
                aria-live="polite"
                className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                {isUsageProjectionRefreshing ? (
                  <>
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-foreground">{t('Refreshing…')}</span>
                    {lastRefreshedAt ? (
                      <span className="truncate">
                        ·{' '}
                        {t('Updated {{time}}', {
                          time: formatRelative(lastRefreshedAt, relativeTimeNow)
                        })}
                      </span>
                    ) : null}
                  </>
                ) : lastRefreshedAt ? (
                  <span>
                    {t('Updated {{time}}', {
                      time: formatRelative(lastRefreshedAt, relativeTimeNow)
                    })}
                  </span>
                ) : null}
              </p>
              <SettingsIconAction
                label={t('Refresh')}
                icon={RefreshCw}
                disabled={isUsageProjectionRefreshing}
                className={
                  isUsageProjectionRefreshing
                    ? '[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none'
                    : ''
                }
                onClick={refreshUsageProjection}
              />
            </div>
          ) : null}

          {usageProjectionLoadFailed ? (
            <p role="alert" className="-mt-2 text-xs text-destructive">
              {t('Could not load token usage.')}
            </p>
          ) : null}

          <div data-slot="token-usage-summary" className="border-y border-border py-5">
            <div className="grid grid-cols-2 gap-x-5 gap-y-5 lg:grid-cols-4">
              {tokenSummaryItems.map((item) => (
                <div key={item.label} className="min-w-0">
                  <p
                    data-stat-label={item.label}
                    className="truncate text-xs font-medium text-muted-foreground"
                  >
                    {t(item.label)}
                  </p>
                  <p
                    className={cn(
                      'mt-1 truncate font-semibold tabular-nums text-foreground',
                      item.featured ? 'text-2xl tracking-tight sm:text-3xl' : 'text-xl'
                    )}
                    title={item.value}
                  >
                    {item.value}
                  </p>
                  {item.detailLabel && item.detailValue ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {t(item.detailLabel)}{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {item.detailValue}
                      </span>
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5 lg:grid-cols-4">
              {entitySummaryItems.map((item) => (
                <div key={item.totalLabel} className="grid min-w-0 gap-5">
                  {item.newLabel && item.newValue ? (
                    <div className="min-h-14 min-w-0">
                      <p
                        data-stat-label={item.newLabel}
                        className="truncate text-xs font-medium text-muted-foreground"
                      >
                        {t(item.newLabel)}
                      </p>
                      <p
                        className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground"
                        title={item.newValue}
                      >
                        {item.newValue}
                      </p>
                    </div>
                  ) : null}
                  <div className="min-h-14 min-w-0">
                    <p
                      data-stat-label={item.totalLabel}
                      className="truncate text-xs font-medium text-muted-foreground"
                    >
                      {t(item.totalLabel)}
                    </p>
                    <p
                      className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground"
                      title={item.totalValue}
                    >
                      {item.totalValue}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {summary.newRuns > summary.reportedRuns ? (
            <div
              role="status"
              data-slot="token-usage-coverage"
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <p>
                {t(
                  'Token totals are available for {{reported}} of {{count}} runs in this period.',
                  {
                    reported: summary.reportedRuns,
                    count: summary.newRuns,
                    defaultValue_one:
                      'Token totals are available for {{reported}} of {{count}} run in this period.'
                  }
                )}{' '}
                {t('Older conversations or some providers may not report usage.')}
              </p>
            </div>
          ) : null}
        </section>

        <section
          aria-labelledby="token-activity-title"
          className="border-b border-border px-4 py-6 sm:px-5"
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <div className="min-w-0">
              <h2 id="token-activity-title" className="text-base font-semibold text-foreground">
                {t('Daily activity')}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {t('Compare each day over the last 30 days. Darker cells indicate higher usage.')}
              </p>
            </div>
            <Select
              value={heatmapMetric}
              onValueChange={(value) => setHeatmapMetric(value as TokenUsageHeatmapMetric)}
            >
              <SelectTrigger aria-label={t('Daily activity metric')} className="h-9">
                {t(metricLabel(heatmapMetric))}
              </SelectTrigger>
              <SelectContent>
                {HEATMAP_METRICS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-6 min-w-0">
            <div
              role="group"
              aria-label={t('Daily activity for the last 30 days')}
              className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(30,minmax(0,1fr))]"
            >
              {analytics.last30Days.map((point) => {
                const value = tokenUsageMetricValue(point, heatmapMetric)
                const intensity = heatmapIntensity(value, heatmapMaximum)
                return (
                  <Tooltip key={point.dateKey}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={heatmapCellLabel(point)}
                        className={cn(
                          'aspect-square w-full justify-self-center rounded-[3px] border outline-none transition-[background-color,border-color] duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:translate-y-px motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 sm:max-w-10 sm:rounded-md',
                          HEATMAP_INTENSITY_CLASSES[intensity]
                        )}
                      >
                        <span className="sr-only">{heatmapCellLabel(point)}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{heatmapCellLabel(point)}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
              <span>{t('Less')}</span>
              {HEATMAP_INTENSITY_CLASSES.map((className, index) => (
                <span
                  key={className}
                  aria-hidden="true"
                  className={cn('size-2.5 rounded-[3px] border', className)}
                  data-intensity={index}
                />
              ))}
              <span>{t('More')}</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="daily-token-usage-title" className="min-w-0 px-4 py-6 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="daily-token-usage-title" className="text-base font-semibold text-foreground">
                {t('Daily token usage')}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t('Daily input, cache, and output tokens over the last 30 days.')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {[
                ['bg-chart-1', 'Input'],
                ['bg-chart-2', 'Cache'],
                ['bg-chart-3', 'Output']
              ].map(([className, label]) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-2.5 rounded-[3px]', className)} aria-hidden="true" />
                  {t(label)}
                </span>
              ))}
            </div>
          </div>

          {tokenMaximum === 0 ? (
            <div className="mt-5 flex items-center gap-2 border-y border-dashed border-border py-4 text-sm text-muted-foreground">
              <ChartNoAxesCombined className="size-4 shrink-0" aria-hidden="true" />
              <p>
                {sessions.length === 0
                  ? t('Start a conversation to see token usage here.')
                  : t('No token usage has been reported in the last 30 days.')}
              </p>
            </div>
          ) : null}

          <div className="mt-5 min-w-0 pb-2" data-slot="token-usage-bars">
            <div
              data-slot="token-usage-30-day-total"
              className="mb-3 flex items-baseline gap-2 text-sm"
            >
              <span className="font-medium text-foreground">{t('Total tokens')}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatNumber(last30DaysTotal)}
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3">
              <div
                data-slot="token-usage-axis"
                aria-hidden="true"
                className="grid h-40 min-w-8 grid-rows-[auto_1fr_auto] text-right text-[10px] tabular-nums text-muted-foreground"
              >
                <span className="-translate-y-1/2">{formatTokenAxisValue(chartScaleMaximum)}</span>
                <span className="self-center">{formatTokenAxisValue(chartScaleMaximum / 2)}</span>
                <span className="translate-y-1/2">0</span>
              </div>
              <div className="relative h-40 min-w-0">
                {[0, 50, 100].map((percentage) => (
                  <span
                    key={percentage}
                    aria-hidden="true"
                    className="absolute inset-x-0 border-t border-border"
                    style={{ bottom: `${percentage}%` }}
                  />
                ))}
                <div
                  role="group"
                  aria-label={t('Stacked daily token usage for the last 30 days')}
                  className="relative z-10 grid h-full grid-cols-[repeat(30,minmax(0,1fr))] items-end gap-1"
                >
                  {analytics.last30Days.map((point) => {
                    const totalHeight =
                      chartScaleMaximum === 0
                        ? 0
                        : Math.max(1.5, (point.totalTokens / chartScaleMaximum) * 100)
                    const inputHeight =
                      point.totalTokens === 0 ? 0 : (point.inputTokens / point.totalTokens) * 100
                    const cacheHeight =
                      point.totalTokens === 0 ? 0 : (point.cacheTokens / point.totalTokens) * 100
                    const outputHeight =
                      point.totalTokens === 0 ? 0 : (point.outputTokens / point.totalTokens) * 100

                    return (
                      <div key={point.dateKey} className="flex min-w-0 flex-col items-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={stackedBarLabel(point)}
                              className="group flex h-40 w-full min-w-0 items-end justify-center rounded-md outline-none transition-[background-color,box-shadow] duration-150 hover:bg-muted hover:shadow-sm focus-visible:bg-muted focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:bg-muted motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
                            >
                              {point.totalTokens === 0 ? (
                                <span className="mb-px h-px w-4 bg-border" aria-hidden="true" />
                              ) : (
                                <span
                                  className="flex w-[clamp(0.25rem,55%,0.75rem)] flex-col-reverse overflow-hidden rounded-t-sm bg-muted"
                                  style={{ height: `${totalHeight}%` }}
                                  aria-hidden="true"
                                >
                                  <span
                                    className="w-full bg-chart-1"
                                    style={{ height: `${inputHeight}%` }}
                                  />
                                  <span
                                    className="w-full bg-chart-2"
                                    style={{ height: `${cacheHeight}%` }}
                                  />
                                  <span
                                    className="w-full bg-chart-3"
                                    style={{ height: `${outputHeight}%` }}
                                  />
                                </span>
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            sideOffset={10}
                            collisionPadding={16}
                            className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
                          >
                            <div className="flex items-baseline justify-between gap-5">
                              <span className="font-semibold tabular-nums">{point.dateKey}</span>
                              <span className="font-semibold tabular-nums">
                                {formatNumber(point.totalTokens)}
                              </span>
                            </div>
                            <div className="mt-3 grid gap-2">
                              {[
                                {
                                  label: 'Input (cached)',
                                  value: point.cacheTokens,
                                  className: 'bg-chart-2'
                                },
                                {
                                  label: 'Input (uncached)',
                                  value: point.inputTokens,
                                  className: 'bg-chart-1'
                                },
                                {
                                  label: 'Output',
                                  value: point.outputTokens,
                                  className: 'bg-chart-3'
                                }
                              ].map((row) => (
                                <div
                                  key={row.label}
                                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5"
                                >
                                  <span
                                    className={cn('size-2.5 rounded-[3px]', row.className)}
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 text-muted-foreground">
                                    {t(row.label)}
                                  </span>
                                  <span className="tabular-nums text-foreground">
                                    {formatNumber(row.value)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )
                  })}
                </div>
              </div>
              <span aria-hidden="true" />
              <div
                aria-hidden="true"
                className="mt-2 grid grid-cols-5 text-[10px] tabular-nums text-muted-foreground"
              >
                {[0, 7, 14, 21, 29].map((index) => (
                  <span
                    key={analytics.last30Days[index].dateKey}
                    className={cn(
                      index === 0 && 'text-left',
                      index > 0 && index < 29 && 'text-center',
                      index === 29 && 'text-right'
                    )}
                  >
                    {shortDateFormatter.format(analytics.last30Days[index].dayStart)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </TooltipProvider>
  )
}

export { TokenUsagePanel }
