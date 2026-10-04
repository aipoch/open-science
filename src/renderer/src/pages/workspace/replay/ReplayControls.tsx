import { Slider } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import {
  formatReplayTime,
  replayChapterBreaks,
  replayStepAtTime,
  replayStepExcerpt,
  replayStepFailure
} from './replay-navigation'
import { cn } from '@/lib/utils'
import { matchNotebookRunTool, resolveNotebookRunToolName } from '../notebook-tool-names'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  SkipBack,
  SkipForward,
  ChevronRight,
  Pause,
  Play,
  MessageSquare,
  ListOrdered,
  BookOpen,
  File,
  Wrench,
  UserRound,
  Bot,
  ShieldCheck,
  Info,
  X,
  TriangleAlert,
  CircleX,
  ChevronDown,
  FileSearch,
  RotateCcw
} from 'lucide-react'
import {
  REPLAY_SPEEDS,
  type ReplaySpeed,
  type ReplayStep,
  type ReplayResource
} from '../../../../../shared/replay'

export type ReplayControlsProps = {
  playing: boolean
  ready: boolean
  positionMs: number
  durationMs: number
  stepIndex: number
  steps: readonly ReplayStep[]
  resources?: readonly ReplayResource[]
  onPause: () => void
  onOpenEvidence: (step: ReplayStep) => void
  speed: ReplaySpeed
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (positionMs: number) => void
  onSpeed: (speed: ReplaySpeed) => void
  onAsk: () => void
  discussionPending?: boolean
}

const PAGE_SIZE = 40
const STEP_ICONS = {
  review: ShieldCheck,
  notebook: BookOpen,
  artifact: File,
  activity: Wrench,
  message: Bot
}
const StepIcon = ({ step }: { step?: ReplayStep }): React.JSX.Element => {
  const Icon = !step
    ? ListOrdered
    : step.message?.role === 'user'
      ? UserRound
      : STEP_ICONS[step.kind]
  return <Icon size={14} aria-hidden="true" />
}

const controlClass = 'h-8 max-w-full gap-1 px-2 text-xs'

export const ReplayControls = (props: ReplayControlsProps): React.JSX.Element => {
  const { t } = useTranslation()
  const count = props.steps.length
  const empty = count === 0
  const [navigation, setNavigation] = useState<{
    positionMs: number
    steps: readonly ReplayStep[]
  } | null>(null)
  const open = navigation !== null
  const setOpen = (value: boolean): void =>
    setNavigation(value ? { positionMs: props.positionMs, steps: props.steps } : null)
  if (
    navigation &&
    (navigation.positionMs !== props.positionMs || navigation.steps !== props.steps)
  ) {
    setNavigation(null)
  }
  const [page, setPage] = useState(0)
  const [detail, setDetail] = useState<number | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const detailTrigger = useRef<number | null>(null)
  const restoringDetailFocus = useRef(false)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = track.current
    if (!node) return
    const measure = (): void => setWidth(node.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!open || detail !== null) return
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, page, detail])
  const breaks = useMemo(
    () => replayChapterBreaks(props.steps, props.durationMs, width),
    [props.steps, props.durationMs, width]
  )
  const typeLabel = (step: ReplayStep): string =>
    step.kind === 'review'
      ? t('Session Reviewer')
      : step.kind === 'notebook'
        ? t('Notebook')
        : step.kind === 'artifact'
          ? t('Files')
          : step.kind === 'activity'
            ? t('Tool activity')
            : step.message?.role === 'user'
              ? t('User')
              : t('Agent')
  const resourcesById = useMemo(
    () => new Map(props.resources?.map((resource) => [resource.id, resource])),
    [props.resources]
  )
  const label = (step: ReplayStep): string => {
    if (step.kind === 'artifact') {
      const files = step.resourceIds.flatMap((id) => {
        const resource = resourcesById.get(id)
        if (!resource) return []
        return resource.versionNumber === undefined
          ? [resource.name]
          : [`${resource.name} · ${t('Version {{version}}', { version: resource.versionNumber })}`]
      })
      if (files.length) return files.join(', ')
    }
    const toolName = resolveNotebookRunToolName(
      step.title,
      ...step.activities
        .slice(0, 8)
        .flatMap((activity) => [activity.providerToolName, activity.title])
    )
    if (toolName && (!step.title || resolveNotebookRunToolName(step.title))) {
      const kernels = [...new Set(step.runs.map((run) => run.kernelKind))].join(', ')
      const tool = matchNotebookRunTool(toolName)
      const title =
        tool === 'repl_execute'
          ? t('Agent SDK')
          : tool === 'bash_execute'
            ? t('Shell')
            : t('Notebook run')
      return kernels ? `${title} · ${kernels}` : title
    }
    return (
      replayStepExcerpt(step) ||
      (step.runs.length
        ? `${t('Notebook')} · ${[...new Set(step.runs.map((run) => run.kernelKind))].join(', ')}`
        : typeLabel(step))
    )
  }
  const failureLabel = (step: ReplayStep): string =>
    t('Recorded status: {{status}}', { status: replayStepFailure(step) })
  const current = props.steps[props.stepIndex]
  const last = Math.max(0, count - 1)
  const lastPage = Math.max(0, Math.ceil((last + 1) / PAGE_SIZE) - 1)
  const pageStart = page * PAGE_SIZE
  const selected = detail === null ? undefined : props.steps[detail]
  const changeOpen = (value: boolean): void => {
    if (value) {
      props.onPause()
      setPage(Math.floor(Math.max(0, props.stepIndex) / PAGE_SIZE))
      setDetail(null)
      detailTrigger.current = null
    }
    setOpen(value)
  }
  const jump = (index: number): void => {
    setOpen(false)
    props.onSeek(props.steps[index].startMs)
  }
  const returnToList = (): void => {
    const index = detailTrigger.current
    detailTrigger.current = null
    setDetail(null)
    requestAnimationFrame(() => {
      const button = list.current?.querySelector<HTMLButtonElement>(
        `[data-step-details="${index}"]`
      )
      // Restoring detail focus is navigation, not a request to open its tooltip.
      restoringDetailFocus.current = true
      button?.focus()
      restoringDetailFocus.current = false
    })
  }
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const hoveredStep =
    hoverTime === null ? undefined : props.steps[replayStepAtTime(props.steps, hoverTime)]
  const ended = !empty && props.positionMs >= props.durationMs
  const playLabel = ended ? t('Watch again') : props.playing ? t('Pause replay') : t('Play replay')
  return (
    <div
      className="shrink-0 space-y-1 border-t border-border-200 bg-bg-000 px-3 py-2"
      data-testid="replay-controls"
    >
      <Popover open={open} onOpenChange={changeOpen}>
        <div className="flex min-w-0 items-center gap-1" data-testid="replay-step-actions">
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="h-8 min-w-0 max-w-xl flex-1 justify-start gap-2 px-1 text-xs"
              disabled={empty}
              data-replay-browse-steps
              aria-label={t('Browse steps')}
              title={current ? label(current) : t('No steps')}
            >
              <StepIcon step={current} />
              <span className="min-w-0 truncate">{current ? label(current) : t('No steps')}</span>
              {!empty ? (
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {props.stepIndex + 1} / {count}
                </span>
              ) : null}
              <ChevronDown size={12} aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <div role="group" aria-label={t('Step actions')} className="ml-auto shrink-0">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <Button
                    variant="ghost"
                    type="button"
                    className={controlClass}
                    onClick={props.onAsk}
                    disabled={empty || props.discussionPending}
                    aria-label={t('Ask about this step')}
                  >
                    <MessageSquare size={14} />
                    <span className={width < 560 ? 'sr-only' : 'min-w-0 truncate'}>
                      {t('Ask about this step')}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Ask about this step')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <div
          ref={track}
          className="group/timeline relative flex h-6 items-center"
          data-testid="replay-timeline"
          onPointerMove={(event) => {
            if (empty) return
            const rect = event.currentTarget.getBoundingClientRect()
            setHoverTime(
              Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * props.durationMs
            )
          }}
          onPointerLeave={() => setHoverTime(null)}
          onPointerUp={(event) => {
            if (event.pointerType === 'touch') setHoverTime(null)
          }}
        >
          <Slider.Root
            data-testid="replay-progress-track"
            min={0}
            max={Math.max(1, props.durationMs)}
            step={1}
            onKeyDown={(event) => {
              const direction = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)
                ? 1
                : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)
                  ? -1
                  : 0
              if (!direction || empty) return
              event.preventDefault()
              props.onSeek(
                Math.max(
                  0,
                  Math.min(
                    props.durationMs,
                    props.positionMs + direction * (event.key.startsWith('Page') ? 10000 : 5000)
                  )
                )
              )
            }}
            value={[props.positionMs]}
            onValueChange={([value]) => props.onSeek(value)}
            disabled={empty}
            className="relative flex h-6 w-full touch-none select-none items-center data-[disabled]:opacity-40"
          >
            <Slider.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted transition-[height] group-hover/timeline:h-1.5 group-focus-within/timeline:h-1.5 motion-reduce:transition-none">
              <Slider.Range className="absolute h-full bg-primary" />
              {breaks.map((percent) => (
                <span
                  key={percent}
                  aria-hidden="true"
                  data-replay-chapter-break
                  className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-bg-000"
                  style={{ left: `${percent}%` }}
                />
              ))}
            </Slider.Track>
            <Slider.Thumb
              aria-label={t('Replay progress')}
              aria-valuetext={`${t('{{current}} of {{duration}}', { current: formatReplayTime(props.positionMs), duration: formatReplayTime(props.durationMs) })}${current ? ` · ${label(current)}` : ''}`}
              className="relative z-10 block size-3 rounded-full bg-primary opacity-0 transition-opacity hover:opacity-100 group-hover/timeline:opacity-100 group-focus-within/timeline:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:keyboard-focus motion-reduce:transition-none"
            />
          </Slider.Root>
          <TooltipProvider>
            <Tooltip open={hoveredStep !== undefined && !open}>
              <TooltipTrigger asChild>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 h-px w-px"
                  style={{ left: `${((hoverTime ?? 0) / Math.max(1, props.durationMs)) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                className="max-w-64"
                data-testid="replay-seek-preview"
              >
                {hoveredStep ? (
                  <div className="flex items-center gap-2">
                    <StepIcon step={hoveredStep} />
                    <span className="truncate">{label(hoveredStep)}</span>
                  </div>
                ) : null}
                <p className="mt-1 font-mono text-xs">{formatReplayTime(hoverTime ?? 0)}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden border border-border bg-popover p-2 text-popover-foreground shadow-lg"
          aria-label={t('Browse steps')}
          onEscapeKeyDown={(event) => {
            if (detailTrigger.current !== null) {
              event.preventDefault()
              returnToList()
            }
          }}
        >
          <div className="mb-1 flex shrink-0 items-center gap-2 px-1">
            {selected ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('Browse steps')}
                onClick={returnToList}
              >
                <ChevronLeft size={14} />
              </Button>
            ) : null}
            <h3 className="min-w-0 flex-1 truncate text-xs font-medium">
              {selected ? label(selected) : t('Browse steps')}
            </h3>
            <PopoverClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('Close step list')}>
                <X size={14} />
              </Button>
            </PopoverClose>
          </div>
          {selected ? (
            <div className="min-h-0 space-y-3 overflow-auto p-2 text-xs">
              <p className="text-muted-foreground">
                {t('Recorded time: {{time}}', {
                  time:
                    selected.recordedAt === undefined
                      ? t('Time not recorded')
                      : new Date(selected.recordedAt).toLocaleString()
                })}
              </p>
              {selected.recordedEndAt !== undefined &&
              selected.recordedAt !== undefined &&
              Number.isFinite(selected.recordedEndAt) ? (
                <p>
                  {t('Recorded duration: {{seconds}} s', {
                    seconds: ((selected.recordedEndAt - selected.recordedAt) / 1000).toFixed(1)
                  })}
                </p>
              ) : null}
              {replayStepFailure(selected) ? (
                <p className="flex gap-2">
                  <CircleX className="size-4 shrink-0 text-status-failure-foreground" />
                  {failureLabel(selected)}
                </p>
              ) : null}
              {selected.issues.length ? (
                <p className="flex gap-2">
                  <TriangleAlert className="size-4 shrink-0 text-status-warning-foreground" />
                  {t('Some source material is incomplete or unavailable.')}
                </p>
              ) : null}
              <Button
                variant="outline"
                className="h-8 max-w-full gap-2 px-2 text-xs"
                title={t('Open original evidence')}
                onClick={() => {
                  props.onPause()
                  setOpen(false)
                  props.onOpenEvidence(selected)
                }}
              >
                <FileSearch size={14} />
                <span className="truncate">{t('Open original evidence')}</span>
              </Button>
            </div>
          ) : (
            <ol
              ref={list}
              className="scrollbar-auto-hide min-h-0 space-y-0.5 overflow-y-auto pr-3 [scrollbar-gutter:stable]"
              start={pageStart + 1}
            >
              {props.steps
                .slice(pageStart, Math.min(last + 1, pageStart + PAGE_SIZE))
                .map((step, offset) => {
                  const index = pageStart + offset
                  const name = label(step)
                  return (
                    <li key={step.id} className="flex min-w-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        className={cn(
                          'h-10 min-w-0 flex-1 justify-start gap-2 px-2 text-xs',
                          index === props.stepIndex && 'bg-muted'
                        )}
                        title={name}
                        aria-current={index === props.stepIndex ? 'step' : undefined}
                        aria-label={t('Go to step {{step}}: {{title}}', {
                          step: index + 1,
                          title: name
                        })}
                        onClick={() => jump(index)}
                      >
                        <span className="w-10 shrink-0 font-mono tabular-nums text-muted-foreground">
                          {formatReplayTime(step.startMs)}
                        </span>
                        <StepIcon step={step} />
                        <span className="min-w-0 truncate">{name}</span>
                      </Button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            asChild
                            onFocus={(event) => {
                              if (
                                restoringDetailFocus.current ||
                                !event.currentTarget.matches(':focus-visible')
                              )
                                event.preventDefault()
                            }}
                          >
                            <Button
                              variant="outline"
                              size="icon-sm"
                              className="mr-1 shrink-0 cursor-pointer shadow-none"
                              aria-label={
                                replayStepFailure(step) || step.issues.length
                                  ? t('Details for step {{step}}', { step: index + 1 })
                                  : t('Open original evidence for step {{step}}', {
                                      step: index + 1
                                    })
                              }
                              data-step-details={index}
                              onClick={() => {
                                if (replayStepFailure(step) || step.issues.length) {
                                  detailTrigger.current = index
                                  setDetail(index)
                                } else {
                                  props.onPause()
                                  setOpen(false)
                                  props.onOpenEvidence(step)
                                }
                              }}
                            >
                              {replayStepFailure(step) ? (
                                <CircleX size={14} className="text-status-failure-foreground" />
                              ) : step.issues.length ? (
                                <TriangleAlert
                                  size={14}
                                  className="text-status-warning-foreground"
                                />
                              ) : (
                                <Info size={14} />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {replayStepFailure(step) || step.issues.length
                              ? t('View details')
                              : t('Open original evidence')}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </li>
                  )
                })}
            </ol>
          )}
          {!selected && lastPage > 0 ? (
            <nav
              className="mt-2 flex shrink-0 items-center justify-between border-t border-border pt-2"
              aria-label={t('Browse steps')}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Previous page')}
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('Page {{current}} of {{total}}', { current: page + 1, total: lastPage + 1 })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Next page')}
                disabled={page >= lastPage}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight size={14} />
              </Button>
            </nav>
          ) : null}
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-1" role="group" aria-label={t('Playback controls')}>
        <Button
          variant="ghost"
          type="button"
          className={controlClass}
          onClick={props.onPrevious}
          disabled={empty || props.stepIndex <= 0}
          title={t('Previous step')}
          aria-label={t('Previous step')}
        >
          <SkipBack size={16} />
        </Button>
        <Button
          variant="secondary"
          type="button"
          className={controlClass}
          onClick={props.onToggle}
          disabled={empty}
          aria-label={playLabel}
        >
          {ended ? (
            <RotateCcw size={16} />
          ) : props.playing ? (
            <Pause size={16} />
          ) : (
            <Play size={16} />
          )}
          <span className="sr-only">{playLabel}</span>
          <span role="status" className="sr-only">
            {props.playing && !props.ready ? t('Preparing recorded material…') : null}
          </span>
        </Button>
        <Button
          variant="ghost"
          type="button"
          className={controlClass}
          onClick={props.onNext}
          disabled={empty || props.stepIndex >= count - 1}
          title={t('Next step')}
          aria-label={t('Next step')}
        >
          <SkipForward size={16} />
        </Button>
        <div className="ml-auto flex min-w-0 flex-1 justify-end">
          <span className="truncate px-1 text-xs text-muted-foreground">
            {empty ? (
              t('No steps')
            ) : ended ? (
              t('Completed')
            ) : (
              <span className="font-mono tabular-nums">
                {formatReplayTime(props.positionMs)}
                {' / '}
                {formatReplayTime(props.durationMs)}
              </span>
            )}
          </span>
        </div>
        <Select
          value={String(props.speed)}
          onValueChange={(value) => props.onSpeed(Number(value) as ReplaySpeed)}
          disabled={empty}
        >
          <SelectTrigger aria-label={t('Playback speed')} className="h-8 w-16 shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPLAY_SPEEDS.map((speed) => (
              <SelectItem key={speed} value={String(speed)}>{`${speed}×`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
