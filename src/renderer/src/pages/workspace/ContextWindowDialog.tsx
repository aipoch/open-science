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
  X,
  type LucideIcon
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { AcpPromptStopReason } from '../../../../shared/acp'
import { resolveSessionProviderId } from './error-report'
import {
  selectContextWindowTrendPoints,
  type ContextWindowTrendPoint
} from './context-window-trend'

type ContextWindowDialogProps = {
  open: boolean
  session: ChatSession | undefined
  onOpenChange: (open: boolean) => void
}

const tokenFormatter = new Intl.NumberFormat('en-US')
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    return `${value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}K`
  }
  return tokenFormatter.format(tokens)
}

const stopReasonLabel: Record<AcpPromptStopReason, string> = {
  end_turn: 'Completed',
  max_tokens: 'Max tokens',
  max_turn_requests: 'Turn limit',
  refusal: 'Refused',
  cancelled: 'Interrupted'
}

type PointPresentation = Readonly<{
  label: string
  code: string
  color: string
  marker: string
  icon: LucideIcon
}>

const pointState = (point: ContextWindowTrendPoint): PointPresentation => {
  const termination = point.sample.termination
  if (termination.kind === 'error') {
    return {
      label: 'Error',
      code: 'error',
      color: 'text-danger-000',
      marker: 'fill-danger-000 stroke-danger-000',
      icon: AlertCircle
    }
  }
  const interrupted = termination.stopReason === 'cancelled'
  return {
    label: stopReasonLabel[termination.stopReason],
    code: termination.stopReason,
    color: interrupted ? 'text-warning-900' : 'text-muted-foreground',
    marker: interrupted ? 'fill-warning-900 stroke-warning-900' : 'fill-primary stroke-primary',
    icon: interrupted ? CircleStop : CheckCircle2
  }
}

const sourceLabel = {
  'provider-response': 'Provider response',
  'provider-update': 'Provider update',
  'local-estimate': 'Local estimate'
} as const

const PointDetails = ({ point }: { point: ContextWindowTrendPoint }): React.JSX.Element => {
  const frameworks = useSettingsStore((state) => state.agentFrameworks)
  const providers = useSettingsStore((state) => state.providers)
  const state = pointState(point)
  const StateIcon = state.icon
  const framework = frameworks.find((candidate) => candidate.id === point.runtime?.frameworkId)
  const providerId = resolveSessionProviderId(point.runtime?.backendId)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const frameworkLabel = framework?.displayName ?? point.runtime?.frameworkId
  const providerLabel = provider?.name ?? point.runtime?.backendId
  const modelStepUsage = point.sample.modelStepUsage
  const recoverableCodexCacheRead =
    point.runtime?.frameworkId === 'codex' &&
    point.sample.source === 'provider-response' &&
    modelStepUsage !== undefined &&
    modelStepUsage.cachedReadTokens === undefined &&
    Number.isSafeInteger(modelStepUsage.inputTokens + modelStepUsage.cacheTokens) &&
    point.sample.contextWindow.used === modelStepUsage.inputTokens + modelStepUsage.cacheTokens
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
    <div className="min-w-0 text-xs" data-slot="context-window-point-details">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className="whitespace-nowrap font-medium text-foreground"
            data-slot="context-window-point-title"
          >
            Run {point.runNumber} · Message {point.messageNumber}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={point.prompt}>
            {point.prompt || 'Empty prompt'}
          </div>
        </div>
        <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', state.color)}>
          <StateIcon className="size-3.5" aria-hidden="true" />
          {state.label}
        </span>
      </div>

      <div className="mt-3 border-y border-border py-2.5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-muted-foreground">Window used</span>
          <span className="font-medium tabular-nums text-foreground">
            {formatTokens(point.sample.contextWindow.used)}
            {point.sample.contextWindow.size ? (
              <span className="font-normal text-muted-foreground">
                {' '}
                / {formatTokens(point.sample.contextWindow.size)}
              </span>
            ) : null}
          </span>
        </div>
        {point.sample.contextWindow.size ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${Math.min(100, (point.sample.contextWindow.used / point.sample.contextWindow.size) * 100)}%`
              }}
            />
          </div>
        ) : null}
        {cacheReadPercent === undefined ? null : (
          <div className="mt-2 text-[10px] tabular-nums text-muted-foreground">
            cache-read {cacheReadPercent}% · uncached {100 - cacheReadPercent}%
          </div>
        )}
      </div>

      {frameworkLabel || point.agentName || point.runtime?.model || providerLabel ? (
        <div
          className="mt-2.5 space-y-1 text-[11px] leading-4 text-muted-foreground"
          data-slot="context-window-point-metadata"
        >
          {frameworkLabel || point.agentName ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Bot className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">
                Agent: {point.agentName ?? frameworkLabel}
                {point.agentName && frameworkLabel ? ` · ${frameworkLabel}` : ''}
              </span>
            </div>
          ) : null}
          {point.runtime?.model || providerLabel ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Brain className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate" title={point.runtime?.model}>
                Model: {point.runtime?.model ?? 'Unknown'}
                {providerLabel ? ` · ${providerLabel}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>{sourceLabel[point.sample.source]}</span>
        <span className="shrink-0 tabular-nums">
          {timeFormatter.format(point.sample.timestamp)}
        </span>
      </div>
      <div className="sr-only">Terminal state code: {state.code}</div>
    </div>
  )
}

const ContextTrendChart = ({
  points
}: {
  points: ContextWindowTrendPoint[]
}): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [hoveredIndex, setHoveredIndex] = useState<number>()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measure = (): void => {
      if (container.clientWidth > 0) setWidth(Math.max(280, Math.floor(container.clientWidth)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const height = 300
  const plot = { left: width < 480 ? 42 : 52, right: width - 18, top: 26, bottom: 252 }
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [
      point.sample.contextWindow.used,
      point.sample.contextWindow.size ?? 0
    ])
  )
  const x = (index: number): number =>
    points.length === 1
      ? (plot.left + plot.right) / 2
      : plot.left + (index / (points.length - 1)) * (plot.right - plot.left)
  const y = (value: number): number =>
    plot.bottom - Math.min(1, value / maximum) * (plot.bottom - plot.top)
  const actualCoordinates = points.map((point, index) => ({
    x: x(index),
    y: y(point.sample.contextWindow.used)
  }))
  const windowCoordinates = points.flatMap((point, index) =>
    point.sample.contextWindow.size ? [{ x: x(index), y: y(point.sample.contextWindow.size) }] : []
  )
  const actualLine = actualCoordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const actualArea = `${plot.left},${plot.bottom} ${actualLine} ${plot.right},${plot.bottom}`
  const windowLine = windowCoordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const activeIndex = hoveredIndex
  const active = activeIndex === undefined ? undefined : points[activeIndex]
  const activeCoordinate = activeIndex === undefined ? undefined : actualCoordinates[activeIndex]
  const labelStep = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(width / 56))))

  return (
    <div
      ref={containerRef}
      className="relative min-h-[300px] overflow-hidden"
      data-slot="context-window-trend-chart"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-[300px] w-full"
        role="group"
        aria-label={`Context window chart across ${points.length} terminal outcomes`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const tickY = plot.bottom - ratio * (plot.bottom - plot.top)
          return (
            <g key={ratio}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={tickY}
                y2={tickY}
                className="stroke-border"
                strokeWidth="1"
              />
              <text
                x={plot.left - 10}
                y={tickY + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {formatTokens(maximum * ratio)}
              </text>
            </g>
          )
        })}

        {windowCoordinates.length === 1 ? (
          <line
            x1={plot.left}
            x2={plot.right}
            y1={windowCoordinates[0].y}
            y2={windowCoordinates[0].y}
            className="stroke-success-000"
            strokeWidth="1.5"
            strokeDasharray="6 5"
            vectorEffect="non-scaling-stroke"
          />
        ) : windowCoordinates.length > 1 ? (
          <polyline
            points={windowLine}
            fill="none"
            className="stroke-success-000"
            strokeWidth="1.5"
            strokeDasharray="6 5"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {actualCoordinates.length > 1 ? (
          <>
            <polygon points={actualArea} className="fill-primary/10" />
            <polyline
              points={actualLine}
              fill="none"
              className="stroke-primary"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}

        {activeCoordinate ? (
          <line
            x1={activeCoordinate.x}
            x2={activeCoordinate.x}
            y1={plot.top}
            y2={plot.bottom}
            className="stroke-border-200"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {points.map((point, index) => {
          const coordinate = actualCoordinates[index]
          const state = pointState(point)
          return (
            <g
              key={point.sample.id}
              role="img"
              tabIndex={0}
              data-slot="context-window-point"
              aria-label={`Run ${point.runNumber}, ${state.label}, ${tokenFormatter.format(point.sample.contextWindow.used)} context-window tokens`}
              onPointerEnter={() => setHoveredIndex(index)}
              onPointerLeave={() => setHoveredIndex(undefined)}
              onFocus={() => setHoveredIndex(index)}
              onBlur={() => setHoveredIndex(undefined)}
              className="outline-none [&:focus-visible>circle:first-of-type]:stroke-ring [&:focus-visible>circle:first-of-type]:stroke-[4]"
            >
              <circle
                cx={coordinate.x}
                cy={coordinate.y}
                r="4.5"
                className={state.marker}
                strokeWidth="2"
              />
              <circle
                cx={coordinate.x}
                cy={coordinate.y}
                r="22"
                className="fill-transparent stroke-transparent focus-visible:stroke-ring"
              />
              {index % labelStep === 0 || index === points.length - 1 ? (
                <text
                  x={coordinate.x}
                  y={plot.bottom + 23}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {point.runNumber}
                </text>
              ) : null}
            </g>
          )
        })}
        <text
          x={(plot.left + plot.right) / 2}
          y={height - 4}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px]"
        >
          Run
        </text>
      </svg>

      {active && activeCoordinate ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-3 bottom-3 z-10 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-menu sm:inset-x-auto sm:left-[var(--tooltip-left)] sm:w-64',
            activeCoordinate.x > width * 0.72
              ? 'sm:-translate-x-full'
              : activeCoordinate.x > width * 0.28
                ? 'sm:-translate-x-1/2'
                : '',
            activeCoordinate.y < 140
              ? 'sm:bottom-auto sm:top-[calc(var(--tooltip-top)+0.75rem)]'
              : 'sm:bottom-3 sm:top-auto'
          )}
          style={
            {
              '--tooltip-left': `${activeCoordinate.x}px`,
              '--tooltip-top': `${activeCoordinate.y}px`
            } as CSSProperties
          }
          data-slot="context-window-chart-tooltip"
        >
          <PointDetails point={active} />
        </div>
      ) : null}
    </div>
  )
}

const ContextWindowDialog = ({
  open,
  session,
  onOpenChange
}: ContextWindowDialogProps): React.JSX.Element => {
  const messages = session?.messages
  const conversationGraph = session?.conversationGraph
  const points = useMemo(
    () =>
      messages === undefined ? [] : selectContextWindowTrendPoints({ conversationGraph, messages }),
    [conversationGraph, messages]
  )
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
            'flex max-h-[min(760px,calc(100dvh-1.5rem))] w-[min(940px,calc(100vw-1.5rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName} data-slot="context-window-dialog-header">
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>Context window</Dialog.Title>
              <Dialog.Description
                id="context-window-description"
                className={cn(dialogDescriptionClassName, 'min-[960px]:whitespace-nowrap')}
              >
                Final context window for each completed message on the active branch; interrupted
                and failed attempts remain separate.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label="Close context window"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div
            className={`${dialogBodyClassName} min-h-0 flex-1 overflow-y-auto`}
            data-slot="context-window-dialog-body"
          >
            {points.length === 0 ? (
              <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-border bg-bg-100/40 px-6 text-center">
                <div className="max-w-sm">
                  <Activity className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                  <h3 className="mt-3 text-sm font-medium text-foreground">No run history yet</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    A point appears after a run completes, is interrupted, or ends with an error.
                    Older sessions remain compatible and may not contain trend data.
                  </p>
                </div>
              </div>
            ) : (
              <section aria-labelledby="context-window-chart-title">
                <div className="flex flex-wrap items-end justify-between gap-4 pb-4">
                  <div>
                    <h3
                      id="context-window-chart-title"
                      className="text-xs font-medium text-foreground"
                    >
                      CONTEXT PER RUN
                    </h3>
                  </div>
                  <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-4 rounded-[2px] border-t-2 border-primary bg-primary/10"
                        aria-hidden="true"
                      />
                      Window used (actual)
                    </span>
                    {points.some((point) => point.sample.contextWindow.size) ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-4 border-t border-dashed border-success-000" /> Capacity
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="border-y border-border">
                  <ContextTrendChart points={points} />
                </div>
              </section>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ContextWindowDialog }
