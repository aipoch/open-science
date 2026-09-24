import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Pause,
  Square,
  X,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  type WebEventConnectionState
} from '../../../../shared/web-event-connection'
import type { SmartCollectionState } from './smart-collection-state'
import type {
  SmartCollectionView,
  SmartRunProgress,
  SmartRunProgressRow
} from '../../../../shared/literature-smart-collections'

type PaperOrigin = { x: number; y: number; width: number }

const PaperContent = memo(
  function PaperContent({ row }: { row: SmartRunProgressRow }): React.JSX.Element {
    const { t } = useTranslation()
    const sourceLabel = row.override
      ? row.override === 'include'
        ? t('Manually included')
        : t('Manually excluded')
      : t('Reference')
    return (
      <div
        className={`relative h-[118px] rounded-lg border bg-card p-5 text-card-foreground shadow-sm ${
          row.verdict === 'match' ? 'border-primary/25' : 'border-border/70'
        }`}
      >
        <div className="mb-3 flex h-4 items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2" title={sourceLabel}>
            <FileText className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{sourceLabel}</span>
          </span>
        </div>
        <p
          className="min-h-12 min-w-0 line-clamp-2 break-words text-sm font-medium leading-6"
          title={row.title ?? undefined}
        >
          {row.title ?? t('Reference unavailable')}
        </p>
      </div>
    )
  },
  (previous, next) =>
    previous.row.title === next.row.title &&
    previous.row.verdict === next.row.verdict &&
    previous.row.override === next.row.override
)

function Paper({
  row,
  animate,
  duration,
  epoch,
  position,
  layer,
  entryFrom,
  inFlight = false,
  onLanded
}: {
  row: SmartRunProgressRow
  animate: boolean
  duration: number
  epoch: string
  position?: number
  layer?: number
  entryFrom?: PaperOrigin
  inFlight?: boolean
  onLanded?: () => void
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null)
  const entry = useRef({ origin: entryFrom, duration })
  const landed = useRef(onLanded)
  useLayoutEffect(() => {
    landed.current = onLanded
  }, [onLanded])
  const [arriving, setArriving] = useState(Boolean(animate && entryFrom))
  useLayoutEffect(() => {
    if (!arriving) return
    const node = element.current
    const origin = entry.current.origin
    if (!animate || !node || !origin) {
      setArriving(false)
      landed.current?.()
      return
    }
    // A concurrent batch can finish papers outside the four visible candidates.
    // Give those real results the same left-hand origin without queueing a replay.
    const target = node.getBoundingClientRect()
    const dx = origin.x - target.x
    const dy = origin.y - target.y
    const flight = node.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0)`, width: `${origin.width}px` },
        {
          offset: 0.7,
          transform: `translate3d(${dx * 0.2}px, ${dy * 0.2 - 10}px, 0)`,
          width: `${target.width + (origin.width - target.width) * 0.2}px`
        },
        { transform: 'translate3d(0, 0, 0)', width: `${target.width}px` }
      ],
      { duration: entry.current.duration * 1000, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' }
    )
    flight.onfinish = () => {
      setArriving(false)
      landed.current?.()
    }
    return () => flight.cancel()
  }, [animate, arriving])
  return (
    <motion.article
      ref={element}
      layout={animate && !arriving ? 'position' : undefined}
      layoutId={animate && !arriving ? `${epoch}:${row.id}` : undefined}
      initial={false}
      onLayoutAnimationComplete={onLanded}
      transition={{ layout: { duration: Math.min(duration, 0.24), ease: [0.2, 0, 0.2, 1] } }}
      data-paper-id={row.id}
      data-flight={inFlight || undefined}
      aria-hidden={inFlight || undefined}
      className="relative isolate min-w-0"
      style={{
        position: inFlight ? 'absolute' : undefined,
        top: inFlight ? 0 : undefined,
        left: inFlight ? 0 : undefined,
        width: inFlight ? '100%' : undefined,
        pointerEvents: inFlight ? 'none' : undefined,
        zIndex: layer ?? (row.verdict === 'match' ? 20 : 10),
        gridColumn: position === undefined ? undefined : 1,
        gridRow: position === undefined ? undefined : position + 1
      }}
    >
      <PaperContent row={row} />
    </motion.article>
  )
}

type PilePaper = { row: SmartRunProgressRow; order: number; origin?: PaperOrigin }
type PileDisplay = {
  epoch: string
  expanded: boolean
  received: SmartRunProgressRow[]
  settled: PilePaper[]
  flights: PilePaper[]
  pending: PilePaper | undefined
  order: number
}
const maxPileFlights = 8

const ResultPile = memo(
  function ResultPile({
    label,
    description = label,
    count,
    rows,
    slot,
    icon: Icon,
    iconClassName,
    animate,
    duration,
    epoch,
    entryOrigins
  }: {
    label: string
    description?: string
    count: number
    rows: SmartRunProgressRow[]
    slot: string
    icon: LucideIcon
    iconClassName: string
    animate: boolean
    duration: number
    epoch: string
    entryOrigins: Map<string, PaperOrigin>
  }): React.JSX.Element {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const hydrate = (): PileDisplay => ({
      epoch,
      expanded,
      received: rows,
      settled: rows.map((row, index): PilePaper => ({ row, order: -index })),
      flights: [],
      pending: undefined,
      order: 0
    })
    const [display, setDisplay] = useState(hydrate)
    if (display.epoch !== epoch || display.expanded !== expanded || !animate) {
      if (
        display.received !== rows ||
        display.epoch !== epoch ||
        display.expanded !== expanded ||
        display.flights.length
      )
        setDisplay(hydrate())
    } else if (display.received !== rows) {
      const known = new Set(display.received.map((row) => row.id))
      const arrivals = rows
        .filter((row) => !known.has(row.id) && entryOrigins.has(row.id))
        .reverse()
        .map((row, index): PilePaper => ({
          row,
          origin: entryOrigins.get(row.id),
          order: display.order + index + 1
        }))
      if (!arrivals.length && !display.flights.length) {
        setDisplay(hydrate())
      } else {
        const capacity = maxPileFlights - display.flights.length
        // Keep started flights intact. A burst beyond the cap retains only its latest overflow.
        const admitted = capacity ? arrivals.slice(-capacity) : []
        const pending = arrivals.length > capacity ? arrivals.at(-1) : display.pending
        setDisplay({
          ...display,
          received: rows,
          order: display.order + arrivals.length,
          flights: [...display.flights, ...admitted],
          pending: admitted.some((paper) => paper.row.id === pending?.row.id) ? undefined : pending
        })
      }
    }
    const visible = display.settled.slice(0, expanded ? 4 : 1).map((paper) => paper.row)
    const bottom = visible[visible.length - 1]
    const [cover, setCover] = useState({ epoch, expanded, row: bottom })
    if (
      cover.epoch !== epoch ||
      cover.expanded !== expanded ||
      ((!animate || !expanded || !cover.row) && cover.row !== bottom)
    ) {
      setCover({ epoch, expanded, row: bottom })
    }
    const stackDepth = Math.min(3, Math.max(0, count - visible.length))
    return (
      <section className="min-w-0" aria-label={label} data-flying={display.flights.length > 0}>
        <h4 className="mb-3">
          <button
            type="button"
            aria-label={label}
            title={description}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-full items-center gap-2 rounded-md text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className={iconClassName} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted-foreground ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        </h4>
        <div className="relative pb-6">
          <div className="relative grid grid-cols-1 gap-3" data-slot={slot}>
            {stackDepth > 0 && visible.length > 0 && cover.row && (
              <div
                aria-hidden="true"
                data-slot="screening-result-pile"
                className="pointer-events-none relative z-0 h-[118px] min-w-0"
                style={{ gridColumn: 1, gridRow: visible.length }}
              >
                <div
                  data-slot="screening-result-stack"
                  className="absolute inset-x-0 bottom-0 h-12"
                >
                  {Array.from({ length: stackDepth }, (_, index) => stackDepth - index).map(
                    (depth) => (
                      <span
                        key={depth}
                        className="absolute h-12 rounded-lg border border-border bg-card"
                        style={{ left: depth * 6, right: depth * 6, bottom: -depth * 6 }}
                      />
                    )
                  )}
                </div>
                {/* Keep the older paper under the arriving card; the receiving pile stays put. */}
                <div data-slot="screening-pile-cover" className="relative h-full">
                  {cover.row && <PaperContent row={cover.row} />}
                </div>
              </div>
            )}
            {visible.map((row, index) => (
              <Paper
                key={`${row.id}:${epoch}`}
                row={row}
                epoch={epoch}
                animate={animate}
                duration={duration}
                layer={40 - index}
                position={index}
                onLanded={() => {
                  if (index === visible.length - 1) setCover({ epoch, expanded, row })
                }}
              />
            ))}
            {display.flights.map((paper) => (
              <Paper
                key={`flight:${epoch}:${paper.row.id}`}
                row={paper.row}
                epoch={epoch}
                animate={animate}
                duration={duration}
                layer={100 + paper.order}
                inFlight
                entryFrom={paper.origin}
                onLanded={() =>
                  setDisplay((current) => {
                    if (!current.flights.some((flight) => flight.row.id === paper.row.id))
                      return current
                    const flights = current.flights.filter(
                      (flight) => flight.row.id !== paper.row.id
                    )
                    if (current.pending) flights.push(current.pending)
                    return {
                      ...current,
                      flights,
                      pending: undefined,
                      settled: [
                        paper,
                        ...current.settled.filter((entry) => entry.row.id !== paper.row.id)
                      ]
                        .sort((a, b) => b.order - a.order)
                        .slice(0, 6)
                    }
                  })
                }
              />
            ))}
            {!visible.length && (
              <p className="flex h-[118px] items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 p-5 text-center text-xs leading-6 text-muted-foreground">
                {t('No recent results.')}
              </p>
            )}
          </div>
        </div>
      </section>
    )
  },
  (previous, next) =>
    previous.label === next.label &&
    previous.description === next.description &&
    previous.count === next.count &&
    previous.slot === next.slot &&
    previous.icon === next.icon &&
    previous.iconClassName === next.iconClassName &&
    previous.animate === next.animate &&
    previous.duration === next.duration &&
    previous.epoch === next.epoch &&
    previous.rows.length === next.rows.length &&
    previous.rows.every((row, index) => {
      const other = next.rows[index]!
      return (
        row.id === other.id &&
        row.title === other.title &&
        row.state === other.state &&
        row.verdict === other.verdict &&
        row.override === other.override &&
        row.evaluatedAt === other.evaluatedAt &&
        previous.entryOrigins.get(row.id) === next.entryOrigins.get(row.id)
      )
    })
)

function RunProcess({
  collectionId,
  view
}: {
  collectionId: string
  view: SmartCollectionView & { run: NonNullable<SmartCollectionView['run']> }
}): React.JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<SmartRunProgress>()
  const surface = useRef<HTMLElement>(null)
  const lastSnapshot = useRef<SmartRunProgress>(undefined)
  const [entryOrigins, setEntryOrigins] = useState(new Map<string, PaperOrigin>())
  const duration = 0.65
  const lastProgress = useRef<{ revision: number; done: number } | undefined>(undefined)
  const [error, setError] = useState(false)
  const [snapshotRevision, setSnapshotRevision] = useState(-1)
  const [revision, setRevision] = useState(0)
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const [connected, setConnected] = useState(true)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const wide = useMediaQuery('(min-width: 1024px)')
  useEffect(() => {
    const reconcile = (): void => {
      setVisible(document.visibilityState !== 'hidden')
      // Focus/reconnect presents the current snapshot without replaying a missed animation.
      setRevision((value) => value + 1)
    }
    const connectionChanged = (event: Event): void => {
      setConnected((event as CustomEvent<WebEventConnectionState>).detail.phase === 'live')
      setRevision((value) => value + 1)
    }
    window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, connectionChanged)
    document.addEventListener('visibilitychange', reconcile)
    window.addEventListener('focus', reconcile)
    window.addEventListener('open-science:web-events-open', reconcile)
    return () => {
      window.removeEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, connectionChanged)
      document.removeEventListener('visibilitychange', reconcile)
      window.removeEventListener('focus', reconcile)
      window.removeEventListener('open-science:web-events-open', reconcile)
    }
  }, [])
  useEffect(() => {
    if (!visible || !connected) return
    let current = true
    void window.api.literature
      .transact({ kind: 'read-smart-run-progress', collectionId, runId: view.run.id })
      .then(
        (receipt) => {
          if (!current) return
          if (receipt.smartRunProgress?.runId !== view.run.id) {
            setError(true)
            return
          }
          const next = receipt.smartRunProgress
          const previous = lastProgress.current
          const origins = new Map<string, PaperOrigin>()
          if (
            previous?.revision === revision &&
            next.done > previous.done &&
            wide &&
            !reducedMotion
          ) {
            const candidates = surface.current?.querySelector('[data-slot="screening-candidates"]')
            const known = new Set(lastSnapshot.current?.outcomes.map((row) => row.id))
            const arrivals = next.outcomes.filter((row) => !known.has(row.id))
            if (candidates && arrivals.length) {
              // Only measure visible candidates actually departing. Reading every settled and
              // in-flight card forces extra layout work and can select a destination as origin.
              const mounted = new Map(
                [...candidates.querySelectorAll('[data-paper-id]')].map((node) => [
                  node.getAttribute('data-paper-id'),
                  node
                ])
              )
              let fallback: DOMRect | undefined
              for (const row of arrivals) {
                const source = mounted.get(row.id)
                const from =
                  source?.getBoundingClientRect() ??
                  (fallback ??= candidates.getBoundingClientRect())
                origins.set(row.id, { x: from.x, y: from.y, width: from.width })
              }
            }
          }
          // Repeated reads can arrive while a slower flight is still landing. Keep the
          // measured origins for the bounded current results until their pile accepts them.
          setEntryOrigins((current) => {
            const retained = new Map<string, PaperOrigin>()
            for (const row of next.outcomes) {
              const origin =
                origins.get(row.id) ??
                (previous?.revision === revision ? current.get(row.id) : undefined)
              if (origin) retained.set(row.id, origin)
            }
            return retained
          })
          lastSnapshot.current = next
          // A readable flight duration is independent of inference concurrency/throughput.
          // Each pile bounds concurrent flights and retains only the latest overflow.
          lastProgress.current = { revision, done: next.done }
          setSnapshotRevision(revision)
          setSnapshot(next)
          setError(false)
        },
        () => {
          if (current) setError(true)
        }
      )
    return () => {
      current = false
    }
  }, [collectionId, view, visible, connected, revision, wide, reducedMotion])

  const animate = !reducedMotion && wide && visible && connected && !error
  const active = snapshot?.state === 'running' || snapshot?.state === 'queued'
  const paused = snapshot?.state === 'cancelled' || snapshot?.state === 'interrupted'
  const indicatorMotion = !reducedMotion && wide && visible && connected && !error
  const processing = Boolean(active && connected && !error)
  const matches = snapshot?.outcomes.filter((row) => row.verdict === 'match') ?? []
  const review = snapshot?.outcomes.filter((row) => row.verdict === 'uncertain') ?? []
  const unmatched = snapshot?.outcomes.filter((row) => row.verdict === 'no-match') ?? []
  const unavailable = snapshot?.outcomes.filter((row) => !row.verdict) ?? []
  return (
    <section
      ref={surface}
      aria-label={t('Screening process')}
      data-slot="smart-screening-process"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto py-6"
    >
      <div className="mb-6 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <h3 className="shrink-0 whitespace-nowrap font-medium">{t('This run')}</h3>
        <p
          className="min-w-0 truncate"
          title={t('Live AI outcomes. Manual decisions still determine collection membership.')}
        >
          {t('Live AI outcomes. Manual decisions still determine collection membership.')}
        </p>
      </div>
      {error && (
        <ErrorNotice
          inline
          tone="amber"
          description={t(
            'Run details could not be refreshed. Displayed results may be out of date.'
          )}
          primaryButton={{
            label: t('Retry'),
            onClick: () => setRevision((value) => value + 1)
          }}
        />
      )}
      {!snapshot ? (
        !error && (
          <p role="status" className="py-10 text-sm text-muted-foreground">
            {t('Loading…')}
          </p>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-5 pb-5 sm:grid-cols-4">
            {[
              [t('Processed'), `${snapshot.done} / ${snapshot.total}`],
              [t('AI matches'), snapshot.counts.match],
              [t('Needs review'), snapshot.counts.review],
              [t('Not matched'), snapshot.counts.noMatch]
            ].map(([label, count]) => (
              <div key={label}>
                <p className="text-3xl font-normal tabular-nums tracking-tight">{count}</p>
                <p className="mt-1 text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          <div className="mb-4 h-px overflow-hidden bg-border" aria-hidden="true">
            <div
              className="h-full bg-primary"
              style={{ width: `${snapshot.total ? (snapshot.done / snapshot.total) * 100 : 0}%` }}
            />
          </div>
          <p role="status" className="mb-7 text-xs text-muted-foreground">
            {active
              ? t('Running…')
              : snapshot.state === 'completed'
                ? t('Completed')
                : snapshot.state === 'failed'
                  ? t('Analysis failed')
                  : t('Paused')}
            {' · '}
            {t('Pending: {{total}}', { total: snapshot.counts.pending })}
            {' · '}
            {t('Failed: {{total}}', { total: snapshot.counts.error })}
          </p>
          <LayoutGroup id={`smart-process-${collectionId}-${view.run.id}`}>
            <div className="relative isolate grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_128px_minmax(0,1fr)] lg:gap-0 xl:grid-cols-[minmax(0,1fr)_176px_minmax(0,1fr)]">
              <div>
                <h4 className="mb-5 flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
                  {t('Pending candidates')}
                  <span className="tabular-nums text-muted-foreground">
                    {snapshot.counts.pending}
                  </span>
                </h4>
                <div className="relative space-y-3" data-slot="screening-candidates">
                  {snapshot.candidates.map((row) => (
                    <Paper
                      key={`${row.id}:${revision}:${snapshotRevision}`}
                      row={row}
                      epoch={`${revision}:${snapshotRevision}`}
                      animate={animate}
                      duration={duration}
                    />
                  ))}
                  {!snapshot.candidates.length && (
                    <p className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 p-6 text-center text-xs leading-6 text-muted-foreground">
                      {t('No pending candidates.')}
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {t('A preview of pending papers. Several papers can be analyzed at once.')}
                </p>
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none relative hidden h-44 items-center justify-center text-muted-foreground lg:flex"
              >
                <div
                  className="absolute inset-x-3 top-24 border-t border-dashed border-primary/20"
                  data-slot="screening-flow-indicator"
                  data-processing={processing}
                  data-paused={paused}
                >
                  {processing && indicatorMotion && (
                    <motion.span
                      className="absolute -top-0.5 left-0 h-1 w-full"
                      animate={{ x: ['0%', '90%'], opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 0.65, repeat: Infinity, ease: 'linear' }}
                    >
                      <span className="block h-1 w-3 rounded-full bg-primary/60" />
                    </motion.span>
                  )}
                </div>
                <motion.div
                  key={paused ? 'paused' : processing ? 'processing' : 'idle'}
                  data-slot="screening-indicator-core"
                  className="relative mt-4 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-background text-primary shadow-sm"
                  animate={
                    paused && indicatorMotion ? { opacity: [0.55, 1, 0.55] } : { opacity: 1 }
                  }
                  transition={
                    paused && indicatorMotion
                      ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
                      : { duration: 0 }
                  }
                >
                  {paused ? (
                    <Pause className="size-6" />
                  ) : error || snapshot.state === 'failed' ? (
                    <CircleAlert className="size-6" />
                  ) : processing ? (
                    <svg
                      data-slot="screening-robot"
                      viewBox="0 0 40 40"
                      className="size-10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <motion.g
                        data-slot="screening-robot-head"
                        style={{ transformOrigin: '20px 20px' }}
                        animate={
                          indicatorMotion
                            ? { y: [0, -1.2, 0], rotate: [0, -3, 0, 3, 0] }
                            : { y: 0, rotate: 0 }
                        }
                        transition={{
                          duration: indicatorMotion ? 2.4 : 0,
                          repeat: indicatorMotion ? Infinity : 0,
                          ease: 'easeInOut'
                        }}
                      >
                        <path d="M20 11V7M4 17v7M36 17v7" />
                        <circle cx="20" cy="5" r="1.8" fill="currentColor" stroke="none" />
                        <rect x="8" y="11" width="24" height="19" rx="6" />
                        <motion.g
                          data-slot="screening-robot-eyes"
                          style={{ transformOrigin: '20px 19px' }}
                          animate={
                            indicatorMotion
                              ? { x: [-1.2, 1.2, -1.2], scaleY: [1, 1, 0.15, 1, 1] }
                              : { x: 0, scaleY: 1 }
                          }
                          transition={
                            indicatorMotion
                              ? {
                                  x: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
                                  scaleY: {
                                    duration: 2.6,
                                    times: [0, 0.44, 0.48, 0.52, 1],
                                    repeat: Infinity
                                  }
                                }
                              : { duration: 0 }
                          }
                        >
                          <rect
                            x="13"
                            y="16.5"
                            width="3.5"
                            height="5"
                            rx="1.75"
                            fill="currentColor"
                            stroke="none"
                          />
                          <rect
                            x="23.5"
                            y="16.5"
                            width="3.5"
                            height="5"
                            rx="1.75"
                            fill="currentColor"
                            stroke="none"
                          />
                        </motion.g>
                        <path d="M17 25h6" opacity="0.5" />
                      </motion.g>
                      {[15, 20, 25].map((x, index) => (
                        <motion.circle
                          key={x}
                          data-slot="screening-robot-activity"
                          cx={x}
                          cy="36"
                          r="1.3"
                          fill="currentColor"
                          stroke="none"
                          animate={
                            indicatorMotion
                              ? { opacity: [0.25, 1, 0.25], y: [0, -1, 0] }
                              : { opacity: 0.6, y: 0 }
                          }
                          transition={{
                            duration: indicatorMotion ? 0.9 : 0,
                            delay: indicatorMotion ? index * 0.15 : 0,
                            repeat: indicatorMotion ? Infinity : 0,
                            ease: 'easeInOut'
                          }}
                        />
                      ))}
                    </svg>
                  ) : snapshot.state === 'completed' ? (
                    <Check className="size-6" />
                  ) : (
                    <Square className="size-5" />
                  )}
                </motion.div>
                <ArrowRight className="absolute right-2 top-[89px] size-4 text-primary/40" />
              </div>
              <div
                className="grid min-w-0 grid-cols-1 items-start gap-x-5 gap-y-3 sm:grid-cols-2"
                data-slot="screening-result-groups"
              >
                {[
                  {
                    label: t('AI matches'),
                    count: snapshot.counts.match,
                    rows: matches,
                    slot: 'screening-matches',
                    icon: Check,
                    iconClassName: 'size-4 shrink-0 text-primary'
                  },
                  {
                    label: t('Not matched'),
                    count: snapshot.counts.noMatch,
                    rows: unmatched,
                    slot: 'screening-unmatched',
                    icon: X,
                    iconClassName: 'size-4 shrink-0 text-muted-foreground'
                  },
                  {
                    label: t('Needs review'),
                    count: snapshot.counts.review,
                    rows: review,
                    slot: 'screening-review',
                    icon: CircleAlert,
                    iconClassName: 'size-4 shrink-0 text-status-warning-foreground'
                  },
                  {
                    label: t('Failed / unavailable'),
                    description: t('Details unavailable or failed'),
                    count: snapshot.counts.unavailable + snapshot.counts.error,
                    rows: unavailable,
                    slot: 'screening-unavailable',
                    icon: CircleAlert,
                    iconClassName: 'size-4 shrink-0 text-muted-foreground'
                  }
                ].map((group) => (
                  <ResultPile
                    key={group.slot}
                    {...group}
                    animate={animate}
                    duration={duration}
                    epoch={`${revision}:${snapshotRevision}`}
                    entryOrigins={entryOrigins}
                  />
                ))}
              </div>
            </div>
          </LayoutGroup>
        </>
      )}
    </section>
  )
}

export function SmartCollectionProcess({
  collectionId,
  state,
  starting = false
}: {
  collectionId: string
  state: SmartCollectionState
  starting?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot)
  return starting ? (
    <section
      aria-label={t('Screening process')}
      data-slot="smart-screening-process"
      className="py-12 text-center text-sm text-muted-foreground"
    >
      <p role="status">{t('Loading…')}</p>
    </section>
  ) : view?.run ? (
    <RunProcess
      key={`${collectionId}:${view.run.id}`}
      collectionId={collectionId}
      view={{ ...view, run: view.run }}
    />
  ) : (
    <p className="py-12 text-center text-sm text-muted-foreground">
      {t('Start an update to see the screening process.')}
    </p>
  )
}
