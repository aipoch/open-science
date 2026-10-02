import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useOverlayLayer } from '@/components/ui/overlay-layer'
import { cn } from '@/lib/utils'
import type { TokenUsageDailyPoint } from './token-usage-analytics'

type TokenUsageBarsProps = {
  points: readonly TokenUsageDailyPoint[]
  scaleMaximum: number
  formatNumber: (value: number) => string
  barLabel: (point: TokenUsageDailyPoint) => string
}

// This chart owns inspection only; analytics and projection loading stay in the panel.
export function TokenUsageBars({
  points,
  scaleMaximum,
  formatNumber,
  barLabel
}: TokenUsageBarsProps): React.JSX.Element {
  const { t } = useTranslation()
  const layer = useOverlayLayer()
  const tooltipId = useId()
  const plotRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const positionRef = useRef({ x: 0, y: 0, animate: false, persistent: false })
  const dismissedDateRef = useRef<string | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusFrameRef = useRef<number | undefined>(undefined)
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const point = points.find((candidate) => candidate.dateKey === activeDate)

  const cancelClose = (): void => {
    clearTimeout(closeTimerRef.current)
  }
  const dismiss = (): void => {
    cancelClose()
    if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current)
    dismissedDateRef.current = activeDate
    setActiveDate(null)
  }
  const closeAfterLeave = (): void => {
    cancelClose()
    if (!positionRef.current.persistent) {
      closeTimerRef.current = setTimeout(() => setActiveDate(null), 120)
    }
  }

  const positionTooltip = (): void => {
    const tooltip = tooltipRef.current
    if (!tooltip) return
    const { x, y, animate } = positionRef.current
    const { width, height } = tooltip.getBoundingClientRect()
    const margin = 16
    const offset = 16
    const left = Math.max(
      margin,
      Math.min(
        x + offset + width <= window.innerWidth - margin ? x + offset : x - width - offset,
        window.innerWidth - width - margin
      )
    )
    const top = Math.max(
      margin,
      Math.min(y - height - offset, window.innerHeight - height - margin)
    )
    tooltip.style.transitionDuration = animate ? '' : '0s'
    tooltip.style.transform = `translate(${left}px, ${top}px)`
    tooltip.style.visibility = 'visible'
  }

  const inspect = (date: string, x: number, y: number, animate: boolean): void => {
    cancelClose()
    positionRef.current = {
      x,
      y,
      animate: animate && tooltipRef.current !== null,
      persistent: !animate
    }
    setActiveDate(date)
    // Pixel movement never rerenders the panel or rebuilds its analytics.
    positionTooltip()
  }

  useLayoutEffect(() => {
    positionTooltip()
  })

  useEffect(() => {
    if (!point) return
    const dismissInspection = (): void => {
      clearTimeout(closeTimerRef.current)
      dismissedDateRef.current = point.dateKey
      setActiveDate(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismissInspection()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !plotRef.current?.contains(event.target) &&
        !tooltipRef.current?.contains(event.target)
      ) {
        dismissInspection()
      }
    }
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && tooltipRef.current?.contains(event.target)) return
      dismissInspection()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismissInspection)
    window.addEventListener('blur', dismissInspection)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', dismissInspection)
      window.removeEventListener('blur', dismissInspection)
    }
  }, [point])

  useEffect(
    () => () => {
      clearTimeout(closeTimerRef.current)
      if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current)
    },
    []
  )

  return (
    <>
      <div
        ref={plotRef}
        role="group"
        aria-label={t('Stacked daily token usage for the last 30 days')}
        className="relative z-10 grid h-full grid-cols-[repeat(30,minmax(0,1fr))] items-end"
        onPointerEnter={() => {
          dismissedDateRef.current = null
          cancelClose()
        }}
        onPointerMove={(event) => {
          if (event.pointerType === 'touch') return
          const bounds = event.currentTarget.getBoundingClientRect()
          const index = Math.max(
            0,
            Math.min(
              points.length - 1,
              Math.floor(((event.clientX - bounds.left) / bounds.width) * points.length)
            )
          )
          const date = points[index]?.dateKey
          if (!date || date === dismissedDateRef.current) return
          inspect(date, event.clientX, event.clientY, true)
        }}
        onPointerLeave={closeAfterLeave}
        onPointerCancel={dismiss}
      >
        {points.map((day) => (
          <button
            key={day.dateKey}
            type="button"
            aria-label={barLabel(day)}
            aria-describedby={day.dateKey === activeDate && point ? tooltipId : undefined}
            data-inspected={day.dateKey === activeDate && point ? '' : undefined}
            className="flex h-40 w-full min-w-0 items-end justify-center rounded-md outline-none data-[inspected]:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            onFocus={(event) => {
              dismissedDateRef.current = null
              const target = event.currentTarget
              // Focus can scroll an offscreen day into view. Anchor after that scroll,
              // so its event cannot immediately dismiss the newly opened inspection.
              if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current)
              focusFrameRef.current = requestAnimationFrame(() => {
                focusFrameRef.current = undefined
                if (document.activeElement !== target) return
                const bounds = target.getBoundingClientRect()
                inspect(day.dateKey, bounds.left + bounds.width / 2, bounds.top, false)
              })
            }}
            onBlur={dismiss}
            onClick={(event) => {
              dismissedDateRef.current = null
              const bounds = event.currentTarget.getBoundingClientRect()
              inspect(day.dateKey, bounds.left + bounds.width / 2, bounds.top, false)
            }}
          >
            {day.totalTokens === 0 ? (
              <span className="mb-px h-px w-full max-w-4 bg-border" aria-hidden="true" />
            ) : (
              <span
                className="flex w-[clamp(0.25rem,55%,0.75rem)] flex-col-reverse overflow-hidden rounded-t-sm bg-muted"
                style={{
                  height: `${scaleMaximum === 0 ? 0 : Math.max(1.5, (day.totalTokens / scaleMaximum) * 100)}%`
                }}
                aria-hidden="true"
              >
                <span
                  className="w-full bg-chart-1"
                  style={{ height: `${(day.inputTokens / day.totalTokens) * 100}%` }}
                />
                <span
                  className="w-full bg-chart-2"
                  style={{ height: `${(day.cacheTokens / day.totalTokens) * 100}%` }}
                />
                <span
                  className="w-full bg-chart-3"
                  style={{ height: `${(day.outputTokens / day.totalTokens) * 100}%` }}
                />
              </span>
            )}
          </button>
        ))}
      </div>
      {point &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            data-slot="token-usage-inspection"
            className="fixed left-0 top-0 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg transition-transform duration-120 ease-out motion-reduce:transition-none"
            style={{ zIndex: layer + 10, visibility: 'hidden' }}
            onPointerEnter={cancelClose}
            onPointerLeave={closeAfterLeave}
          >
            <div className="flex items-baseline justify-between gap-5">
              <span className="font-semibold tabular-nums">{point.dateKey}</span>
              <span className="min-w-0 break-all text-right font-semibold tabular-nums">
                {formatNumber(point.totalTokens)}
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              {[
                { label: 'Input (cached)', value: point.cacheTokens, className: 'bg-chart-2' },
                { label: 'Input (uncached)', value: point.inputTokens, className: 'bg-chart-1' },
                { label: 'Output', value: point.outputTokens, className: 'bg-chart-3' }
              ].map((row) => (
                <div
                  key={row.label}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5"
                >
                  <span
                    className={cn('size-2.5 rounded-[3px]', row.className)}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 text-muted-foreground">{t(row.label)}</span>
                  <span className="tabular-nums text-foreground">{formatNumber(row.value)}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
