import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Files,
  GitBranch,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageSquarePlus,
  Library,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp
} from 'lucide-react'
import type {
  ReplayDocument,
  ReplayNotebookRunDetails,
  ReplayResource,
  ReplayRunIndex,
  ReplaySpeed,
  ReplayStep
} from '../../../../../shared/replay'
import type { ReplayViewState } from '../../../../../shared/session-replay'
import {
  projectReplayScene,
  normalizeReplaySpeed,
  ReplayNotebookRunCache,
  readReplayNotebookRun,
  REPLAY_MATERIAL_RUN_LIMIT,
  REPLAY_MATERIAL_RESOURCE_LIMIT,
  type ReplayNotebookRunReader
} from '@/lib/replay'
import { createReplayPresentation } from './replay-presentation'
import { ReplayStage } from './ReplayStage'
import { ReplayControls } from './ReplayControls'
import { ReplaySourceDetails } from './ReplaySourceDetails'
import {
  captureDiscussionStep,
  captureDiscussionSession,
  subscribeReplaySeek,
  consumeReplaySeek,
  type ReplaySeekTarget,
  type SessionDiscussionCapture
} from './replay-context'
import {
  ReplayResourceCache,
  type ReplayResourceMap,
  type ReplayResourceReader
} from './replay-resources'

export type ReplayPanelProps = {
  document: ReplayDocument
  initialView?: ReplayViewState
  active?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
  onViewChange?: (state: ReplayViewState) => void
  onAskStep: (context: SessionDiscussionCapture) => void
  onChooseConversation?: (context: SessionDiscussionCapture) => void
  discussionPending?: boolean
  onOpenEvidence: (resource: ReplayResource | undefined, step: ReplayStep) => void
  readResource?: ReplayResourceReader
  readNotebookRun?: ReplayNotebookRunReader
}

const restoredPosition = (
  document: ReplayDocument,
  view?: ReplayViewState
): { branchId: string; positionMs: number; speed: ReplaySpeed; relocated: boolean } => {
  const branch =
    document.branches.find((item) => item.id === view?.branchId) ??
    document.branches.find((item) => item.id === document.defaultBranchId) ??
    document.branches[0]
  const exact =
    view?.fingerprint === document.source.fingerprint &&
    view.generatorVersion === document.generatorVersion &&
    (view.presentationVersion === undefined ||
      view.presentationVersion === document.presentationVersion)
  const step = branch?.steps.find(
    (item) =>
      item.id === view?.stepId ||
      (view?.anchor &&
        item.evidence.some(
          (evidence) => evidence.kind === view.anchor?.kind && evidence.id === view.anchor.id
        ))
  )
  const fallback = step ? step.startMs + Math.min(step.durationMs, view?.stepOffsetMs ?? 0) : 0
  return {
    branchId: branch?.id ?? document.defaultBranchId,
    // Review records can arrive independently of the Session revision. Prefer the stable
    // step offset even when the Session fingerprint still matches.
    positionMs: Math.min(
      branch?.durationMs ?? 0,
      step && view?.stepOffsetMs !== undefined ? fallback : exact ? (view?.timeMs ?? 0) : fallback
    ),
    speed: normalizeReplaySpeed(view?.rate ?? 2),
    relocated: Boolean(view && !exact && !step)
  }
}

const buttonClass = 'h-auto min-h-8 max-w-full px-3 py-1.5 text-xs'
const DRAWER_PAGE_SIZE = 40
const EMPTY_STEPS: readonly ReplayStep[] = []

const defaultNotebookReader: ReplayNotebookRunReader = (source, index, options) =>
  readReplayNotebookRun(window.api.notebook, source, index, options)

const ReplayPanelContent = ({
  document: replayDocument,
  initialView,
  active = true,
  expanded = false,
  onToggleExpanded,
  onViewChange,
  onAskStep,
  onChooseConversation,
  discussionPending = false,
  onOpenEvidence,
  readResource,
  readNotebookRun = defaultNotebookReader
}: ReplayPanelProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [presentation] = useState(() =>
    createReplayPresentation(
      i18n.resolvedLanguage ?? i18n.language ?? 'en',
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  )
  const initial = useMemo(
    () => restoredPosition(replayDocument, initialView),
    [replayDocument, initialView]
  )
  const [branchPositions] = useState(
    () =>
      new Map(
        initialView?.branchPositions?.flatMap((position) => {
          if (!replayDocument.branches.some((branch) => branch.id === position.branchId)) return []
          const restored = restoredPosition(replayDocument, {
            ...initialView,
            ...position,
            anchor: undefined
          })
          return [[position.branchId, { ...position, timeMs: restored.positionMs }]]
        })
      )
  )
  const [branchId, setBranchId] = useState(initial.branchId)
  const [selectedResourceId, setSelectedResourceId] = useState<string>()
  const [positionMs, setPositionMs] = useState(initial.positionMs)
  const [speed, setSpeed] = useState<ReplaySpeed>(initial.speed)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [wide, setWide] = useState(false)
  const [materialsOverride, setMaterialsOverride] = useState<boolean>()
  const materialsOpen = materialsOverride ?? (expanded || wide)
  const [filesOverride, setFilesOverride] = useState<boolean>()
  const filesOpen = filesOverride ?? (expanded || wide)
  const [previousExpanded, setPreviousExpanded] = useState(expanded)
  if (expanded !== previousExpanded) {
    setPreviousExpanded(expanded)
    if (expanded) {
      setMaterialsOverride(undefined)
      setFilesOverride(undefined)
    }
  }
  const filesId = useId()
  const filesTrigger = useRef<HTMLButtonElement>(null)
  const beforeFile = useRef<boolean | undefined>(undefined)
  const materialsId = useId()
  const materialsTrigger = useRef<HTMLButtonElement>(null)
  const [notebookLimit, setNotebookLimit] = useState<number>()
  const [notebookFollowing, setNotebookFollowing] = useState(true)
  const [conversationFocusRequest, setConversationFocusRequest] = useState(0)
  const [filePage, setFilePage] = useState(0)
  const informationTitleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [tooltipBoundary, setTooltipBoundary] = useState<HTMLDivElement | null>(null)
  const [seekMissing, setSeekMissing] = useState(false)
  const [resources, setResources] = useState<ReplayResourceMap>({})
  const [preparationId, setPreparationId] = useState(0)
  const [degraded, setDegraded] = useState(false)
  const [retryable, setRetryable] = useState(false)
  const [runDetails, setRunDetails] = useState<Readonly<Record<string, ReplayNotebookRunDetails>>>(
    {}
  )
  const scene = useMemo(
    () => projectReplayScene(replayDocument, branchId, positionMs),
    [replayDocument, branchId, positionMs]
  )
  const branch = replayDocument.branches.find((item) => item.id === scene.branchId)
  const materialCatalog = useMemo(() => {
    const steps = branch?.steps.slice(0, scene.stepIndex + 1) ?? []
    const runs = new Map<string, ReplayRunIndex>()
    const ids = new Set<string>()
    for (const step of steps) {
      for (const run of step.runs) runs.set(run.runId, run)
      if (step.id !== scene.step?.id || scene.showResults)
        for (const id of step.resourceIds) ids.add(id)
    }
    return {
      runs: [...runs.values()],
      files: replayDocument.resources.filter((resource) => ids.has(resource.id))
    }
  }, [branch, scene.stepIndex, scene.step?.id, scene.showResults, replayDocument.resources])
  const notebookStart = Math.max(
    0,
    materialCatalog.runs.length - (notebookLimit ?? REPLAY_MATERIAL_RUN_LIMIT)
  )
  const lastFilePage = Math.max(0, Math.ceil(materialCatalog.files.length / DRAWER_PAGE_SIZE) - 1)
  const currentFilePage = Math.min(filePage, lastFilePage)
  const pageRuns = materialsOpen
    ? materialCatalog.runs.slice(notebookStart)
    : scene.visibleSteps
        .flatMap((step) => step.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT))
        .slice(-REPLAY_MATERIAL_RUN_LIMIT)
  const pageFiles = materialCatalog.files.slice(
    currentFilePage * DRAWER_PAGE_SIZE,
    (currentFilePage + 1) * DRAWER_PAGE_SIZE
  )
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    setTooltipBoundary(element)
    // Modal entrance transforms change visual bounds without triggering another resize.
    const measure = (): void => setWide(element.clientWidth >= 1120)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // An explicit retry creates a new preparation batch, including fresh IO decisions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cache = useMemo(() => new ReplayResourceCache(readResource), [readResource, preparationId])
  const runCache = useMemo(
    () => new ReplayNotebookRunCache(readNotebookRun),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readNotebookRun, preparationId]
  )
  const onViewChangeRef = useRef(onViewChange)
  useLayoutEffect(() => {
    onViewChangeRef.current = onViewChange
  }, [onViewChange])
  const viewRef = useRef<ReplayViewState | undefined>(undefined)
  const viewSnapshot: ReplayViewState = {
    fingerprint: replayDocument.source.fingerprint,
    generatorVersion: replayDocument.generatorVersion,
    presentationVersion: replayDocument.presentationVersion,
    branchId: scene.branchId,
    stepId: scene.step?.id,
    stepOffsetMs: scene.step ? scene.positionMs - scene.step.startMs : 0,
    anchor: scene.step?.evidence[0]
      ? { kind: scene.step.evidence[0].kind, id: scene.step.evidence[0].id }
      : undefined,
    timeMs: scene.positionMs,
    rate: speed,
    branchPositions: [...branchPositions.values()]
      .filter((position) => position.branchId !== scene.branchId)
      .slice(-511)
      .concat({
        branchId: scene.branchId,
        stepId: scene.step?.id,
        stepOffsetMs: scene.step ? scene.positionMs - scene.step.startMs : 0,
        timeMs: scene.positionMs
      })
  }
  useLayoutEffect(() => {
    viewRef.current = viewSnapshot
    for (const position of viewSnapshot.branchPositions ?? [])
      branchPositions.set(position.branchId, position)
  })
  const checkpoint = useCallback(() => {
    if (viewRef.current) onViewChangeRef.current?.(structuredClone(viewRef.current))
  }, [])

  useEffect(() => {
    if (!active) {
      checkpoint()
    }
    const hide = (): void => {
      if (document.hidden) {
        setPlaying(false)
        checkpoint()
      }
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [active, checkpoint])

  useEffect(() => () => checkpoint(), [checkpoint])

  useEffect(() => {
    if (!playing || !active) return
    const timer = setInterval(checkpoint, 5000)
    return () => clearInterval(timer)
  }, [playing, active, checkpoint])

  useEffect(() => {
    if (playing) return
    const timer = setTimeout(checkpoint, 250)
    return () => clearTimeout(timer)
  }, [playing, positionMs, branchId, speed, checkpoint])

  useEffect(() => {
    if (!playing || !active || !ready || scene.ended) return
    let frame = 0
    let previous: number | undefined
    const advance = (time: number): void => {
      if (previous !== undefined)
        setPositionMs((position) =>
          Math.min(scene.durationMs, position + Math.min(250, time - previous!) * speed)
        )
      previous = time
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [playing, active, ready, speed, scene.durationMs, scene.ended])

  if (playing && (!active || scene.ended)) setPlaying(false)

  const materialStep = [...scene.visibleSteps]
    .reverse()
    .find((step) => step.runs.length || step.resourceIds.length)
  const selectedResource = materialCatalog.files.find(
    (resource) => resource.id === selectedResourceId
  )
  const prepareIds = [
    ...new Set([
      ...(selectedResource ? [selectedResource.id] : []),
      ...scene.visibleResourceIds.slice(-REPLAY_MATERIAL_RESOURCE_LIMIT),
      ...(materialStep?.resourceIds.slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT) ?? []),
      ...(branch?.steps[scene.stepIndex + 1]?.resourceIds.slice(
        0,
        REPLAY_MATERIAL_RESOURCE_LIMIT
      ) ?? [])
    ])
  ].slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT * 2)
  const preparationKey = JSON.stringify(prepareIds)
  useEffect(() => {
    let current = true
    const wanted = replayDocument.resources.filter((resource) => prepareIds.includes(resource.id))
    wanted.forEach((resource) => {
      void cache.prepare(resource).then((value) => {
        if (current)
          setResources((existing) => ({
            ...Object.fromEntries(
              Object.entries(existing).filter(([id]) => prepareIds.includes(id))
            ),
            [resource.id]: value
          }))
      })
    })
    return () => {
      current = false
    }
    // Resource identity includes exact versions and the cache is reset with the source fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparationKey, cache])

  const prepareRuns = [
    ...new Map(
      [
        ...pageRuns,
        ...scene.visibleSteps
          .flatMap((step) => step.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT))
          .slice(-REPLAY_MATERIAL_RUN_LIMIT),
        ...(branch?.steps[scene.stepIndex + 1]?.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT) ?? [])
      ].map((run) => [run.runId, run] as const)
    ).values()
  ]
  const runKey = JSON.stringify(prepareRuns.map((run) => run.runId))
  useEffect(() => {
    let current = true
    prepareRuns.forEach((index) => {
      void runCache.load(replayDocument.source, index).then(
        (value) => {
          if (current)
            setRunDetails((existing) => ({
              ...Object.fromEntries(
                Object.entries(existing).filter(([id]) =>
                  prepareRuns.some((run) => run.runId === id)
                )
              ),
              [index.runId]: value
            }))
        },
        () => {
          if (current)
            setRunDetails((existing) => ({
              ...existing,
              [index.runId]: { status: 'unavailable', reason: 'load-failed' }
            }))
        }
      )
    })
    return () => {
      current = false
    }
    // Bounded cache identity includes the complete source and run id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, runCache])

  const pause = useCallback(() => setPlaying(false), [setPlaying])
  const selectResource = useCallback(
    (id?: string): void => {
      if (id && !materialCatalog.files.some((resource) => resource.id === id)) return
      pause()
      if (id) setNotebookFollowing(false)
      if (id && !selectedResourceId) beforeFile.current = materialsOpen
      setSelectedResourceId(id)
      setMaterialsOverride(id ? true : beforeFile.current)
      if (id && !wide) setFilesOverride(false)
      if (id) {
        const index = materialCatalog.files.findIndex((resource) => resource.id === id)
        setFilePage(Math.floor(index / DRAWER_PAGE_SIZE))
      } else {
        const rowKey = `resource:${selectedResourceId}`
        requestAnimationFrame(() => {
          const row = Array.from(
            panel.current?.querySelectorAll<HTMLElement>('[data-replay-material-item]') ?? []
          ).find((element) => element.dataset.replayMaterialItem === rowKey)
          ;(
            row ??
            panel.current?.querySelector<HTMLElement>(`[id="${materialsId}"]`) ??
            panel.current
          )?.focus()
        })
      }
    },
    [materialCatalog.files, pause, selectedResourceId, materialsId, materialsOpen, wide]
  )
  const seek = useCallback(
    (position: number) => {
      setPlaying(false)
      setSelectedResourceId(undefined)
      setPositionMs(position)
      setConversationFocusRequest((request) => request + 1)
      setNotebookFollowing(true)

      setNotebookLimit(undefined)
      setFilePage(0)
    },
    [setPlaying, setPositionMs, setSelectedResourceId]
  )
  useEffect(() => {
    const receive = (target: ReplaySeekTarget): void => {
      if (
        target.projectId !== replayDocument.source.projectId ||
        target.sourceSessionId !== replayDocument.source.sessionId
      )
        return
      consumeReplaySeek(target.projectId, target.sourceSessionId)
      setPlaying(false)
      const targetBranch = replayDocument.branches.find((item) => item.id === target.branchId)
      const step = targetBranch?.steps.find((item) => item.id === target.stepId)
      if (!step) {
        setSeekMissing(true)
        return
      }
      setSeekMissing(false)
      setBranchId(targetBranch!.id)
      const offset = Number.isFinite(target.stepOffsetMs) ? target.stepOffsetMs! : 0
      seek(step.startMs + Math.max(0, Math.min(step.durationMs, offset)))
    }
    const unsubscribe = subscribeReplaySeek(receive)
    const pending = consumeReplaySeek(
      replayDocument.source.projectId,
      replayDocument.source.sessionId
    )
    if (pending) receive(pending)
    return unsubscribe
  }, [replayDocument, seek])

  // The live frame is available to replay consumers; explicit Ask actions capture their own snapshot.
  const captureCurrent = useRef(() =>
    captureDiscussionStep(replayDocument, scene, runDetails, resources)
  )
  useLayoutEffect(() => {
    captureCurrent.current = () =>
      captureDiscussionStep(replayDocument, scene, runDetails, resources)
  })
  const hasStep = !!scene.step
  useEffect(() => {
    if (!active || !hasStep) return
    const playhead = {
      projectId: replayDocument.source.projectId,
      sourceSessionId: replayDocument.source.sessionId,
      capture: () => captureCurrent.current()
    }
    useSessionReplayStore.setState({ playhead })
    return () => {
      if (useSessionReplayStore.getState().playhead === playhead)
        useSessionReplayStore.setState({ playhead: undefined })
    }
  }, [active, hasStep, replayDocument])

  const ask = (): void => {
    pause()
    if (scene.step) onAskStep(captureDiscussionStep(replayDocument, scene, runDetails, resources))
  }
  const askSession = (): void => {
    pause()
    const context = captureDiscussionSession(replayDocument)
    if (context) onAskStep({ ...context, stepTitle: t('Entire research') })
  }
  const toggle = (): void => {
    if (!branch?.steps.length) return
    setSelectedResourceId(undefined)
    setConversationFocusRequest((request) => request + 1)
    setNotebookFollowing(true)

    setNotebookLimit(undefined)
    setFilePage(0)
    if (scene.ended) setPositionMs(0)
    setPlaying((value) => !value)
  }

  const renderMaterialPagination = (
    page: number,
    last: number,
    change: (page: number) => void
  ): React.JSX.Element | null =>
    last > 0 ? (
      <nav className="flex shrink-0 items-center gap-1 text-xs" aria-label={t('Material pages')}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('Previous page')}
          disabled={page === 0}
          onClick={() => {
            pause()
            change(page - 1)
          }}
        >
          <ChevronLeft size={14} />
        </Button>
        <span>{t('Page {{current}} of {{total}}', { current: page + 1, total: last + 1 })}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('Next page')}
          disabled={page === last}
          onClick={() => {
            pause()
            change(page + 1)
          }}
        >
          <ChevronRight size={14} />
        </Button>
      </nav>
    ) : null

  return (
    <div
      ref={panel}
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg-10"
      data-testid="replay-panel"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === ' ') {
          event.preventDefault()
          toggle()
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          seek(branch?.steps[Math.max(0, scene.stepIndex - 1)]?.startMs ?? 0)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          seek(
            branch?.steps[Math.min((branch?.steps.length ?? 1) - 1, scene.stepIndex + 1)]
              ?.startMs ?? 0
          )
        }
      }}
      tabIndex={0}
      aria-label={t('Research replay')}
    >
      <div
        data-testid="replay-header"
        className="flex shrink-0 items-center gap-1 border-b border-border-200 bg-bg-000 px-2 py-1"
      >
        <div className="min-w-0 flex-1">
          <Popover
            onOpenChange={(open) => {
              if (open) pause()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className="min-w-0 max-w-full justify-start gap-1.5 px-2 text-[13px] font-semibold"
                data-testid="replay-information-trigger"
                aria-label={t('Session information: {{title}}', {
                  title: replayDocument.source.title
                })}
              >
                <span className="truncate">{replayDocument.source.title}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              collisionPadding={12}
              aria-labelledby={informationTitleId}
              className="w-[min(360px,calc(100vw-1.5rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-menu"
            >
              <h2 id={informationTitleId} className="break-words text-sm font-semibold">
                {replayDocument.source.title}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Reconstructed from archived records')}
              </p>
              <p className="my-3 text-xs text-muted-foreground">
                {t('Recorded steps: {{steps}}; files: {{files}}', {
                  steps: branch?.steps.length ?? 0,
                  files: replayDocument.resources.length
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('Presentation timing is reconstructed; recorded results are unchanged.')}
              </p>
              {replayDocument.source.packageOrigin ? (
                <div className="border-t border-border pt-3">
                  <ReplaySourceDetails source={replayDocument.source} onInspect={pause} />
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={askSession}
                disabled={
                  discussionPending || !replayDocument.branches.some((item) => item.steps.length)
                }
                aria-label={t('Discuss the entire research')}
              >
                <MessageSquare size={16} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" collisionBoundary={tooltipBoundary}>
              {t('Discuss the entire research')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {onChooseConversation ? (
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
                  size="icon"
                  disabled={discussionPending || !scene.step}
                  aria-label={t('Add to another conversation…')}
                  onClick={() => {
                    pause()
                    if (scene.step)
                      onChooseConversation(
                        captureDiscussionStep(replayDocument, scene, runDetails, resources)
                      )
                  }}
                >
                  <MessageSquarePlus size={16} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Add to another conversation…')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {replayDocument.branches.length > 1 ? (
          <Select
            value={scene.branchId}
            onOpenChange={(open) => {
              if (open) pause()
            }}
            onValueChange={(value) => {
              pause()
              setSelectedResourceId(undefined)
              const saved = branchPositions.get(value)
              const restored =
                saved && viewRef.current
                  ? restoredPosition(replayDocument, {
                      ...viewRef.current,
                      ...saved,
                      anchor: undefined
                    })
                  : undefined
              setBranchId(value)
              setPositionMs(restored?.positionMs ?? 0)
              setNotebookFollowing(true)

              setNotebookLimit(undefined)
              setFilePage(0)
            }}
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <SelectTrigger
                    aria-label={t('Replay branch')}
                    className="relative size-8 shrink-0 justify-center border-transparent bg-transparent p-0 [&>svg:last-child]:hidden"
                  >
                    <span>
                      <GitBranch size={16} aria-hidden="true" />
                      <span
                        aria-hidden="true"
                        className="absolute right-0.5 top-0 rounded-sm bg-bg-000 px-0.5 text-[9px] leading-3 tabular-nums"
                      >
                        {replayDocument.branches.findIndex((item) => item.id === scene.branchId) +
                          1}
                      </span>
                    </span>
                    <span className="sr-only">
                      <SelectValue />
                    </span>
                  </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  collisionBoundary={tooltipBoundary}
                  collisionPadding={8}
                >
                  {t('Replay branch')} ·{' '}
                  {branch?.kind === 'unattributed'
                    ? t('Related material')
                    : t('Branch {{index}}', {
                        index:
                          replayDocument.branches.findIndex((item) => item.id === scene.branchId) +
                          1
                      })}
                  {branch?.label ? ` · ${branch.label}` : ''}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <SelectContent
              align="end"
              collisionPadding={12}
              className="max-w-[min(24rem,calc(100vw-1.5rem))]"
            >
              {replayDocument.branches.map((item, index) => (
                <SelectItem
                  key={item.id}
                  value={item.id}
                  className="break-words"
                  icon={
                    item.kind === 'unattributed' ? (
                      <Library size={14} aria-hidden="true" />
                    ) : (
                      <GitBranch size={14} aria-hidden="true" />
                    )
                  }
                >
                  {item.kind === 'unattributed'
                    ? t('Related material')
                    : t('Branch {{index}}', { index: index + 1 })}
                  {item.label ? ` · ${item.label}` : ''}
                  {item.parentBranchId
                    ? ` · ${t('From branch {{index}}', { index: replayDocument.branches.findIndex((parent) => parent.id === item.parentBranchId) + 1 })}`
                    : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              asChild
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
              }}
            >
              <Button
                ref={materialsTrigger}
                variant={materialsOpen ? 'secondary' : 'ghost'}
                size="icon"
                aria-label={t('Notebook')}
                aria-expanded={materialsOpen}
                aria-controls={materialsId}
                onClick={() => {
                  setMaterialsOverride(!materialsOpen)
                  if (!materialsOpen)
                    requestAnimationFrame(() =>
                      panel.current?.querySelector<HTMLElement>(`[id="${materialsId}"]`)?.focus()
                    )
                }}
              >
                <BookOpen size={16} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="end"
              sideOffset={6}
              collisionBoundary={tooltipBoundary}
              collisionPadding={8}
            >
              {t('Notebook')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              asChild
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
              }}
            >
              <Button
                ref={filesTrigger}
                variant={filesOpen ? 'secondary' : 'ghost'}
                size="icon"
                aria-label={t('View files')}
                aria-expanded={filesOpen}
                aria-controls={filesId}
                onClick={() => {
                  setFilesOverride(!filesOpen)
                  if (!filesOpen)
                    requestAnimationFrame(() =>
                      panel.current?.querySelector<HTMLElement>(`[id="${filesId}"]`)?.focus()
                    )
                }}
              >
                <Files size={16} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="end"
              sideOffset={6}
              collisionBoundary={tooltipBoundary}
              collisionPadding={8}
            >
              {t('View files')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {onToggleExpanded ? (
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
                  size="icon"
                  aria-label={expanded ? t('Exit full screen') : t('Enter full screen')}
                  onClick={onToggleExpanded}
                >
                  {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="end"
                sideOffset={6}
                collisionBoundary={tooltipBoundary}
                collisionPadding={8}
              >
                {expanded ? t('Exit full screen') : t('Enter full screen')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {replayDocument.issues.some((issue) => issue.code === 'review-unavailable') ? (
        <p role="status" className="border-b border-border-200 px-3 py-2 text-xs text-text-300">
          {t('Session Reviewer')}: {t('The recorded evidence is unavailable.')}
        </p>
      ) : null}
      {initial.relocated || seekMissing ? (
        <p
          role="status"
          className="border-b border-border-200 bg-bg-000 px-3 py-2 text-xs text-text-300"
        >
          {seekMissing
            ? t('The referenced step is no longer available.')
            : t('The saved step is unavailable. Replay starts at the beginning.')}
        </p>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ReplayStage
          fitContainer
          selectedResource={selectedResource}
          onSelectResource={selectResource}
          wide={wide}
          materialsOpen={materialsOpen}
          materialsId={materialsId}
          filesOpen={filesOpen}
          filesId={filesId}
          onOpenFiles={() => setFilesOverride(true)}
          onCloseFiles={() => {
            setFilesOverride(false)
            filesTrigger.current?.focus()
          }}
          onCloseMaterials={() => {
            setSelectedResourceId(undefined)
            setMaterialsOverride(false)
            materialsTrigger.current?.focus()
          }}
          onSeek={seek}
          notebookRuns={pageRuns}
          fileResources={pageFiles}
          notebookHistoryControl={
            notebookStart > 0 ? (
              <div className="flex justify-center px-3 py-2 [overflow-anchor:none]">
                <Button
                  variant="secondary"
                  className="max-w-full gap-1.5"
                  onClick={() => {
                    pause()
                    setNotebookFollowing(false)
                    setNotebookLimit(
                      (count) => (count ?? REPLAY_MATERIAL_RUN_LIMIT) + REPLAY_MATERIAL_RUN_LIMIT
                    )
                  }}
                >
                  <ChevronUp size={14} aria-hidden="true" />
                  {t('Load earlier runs')}
                </Button>
              </div>
            ) : null
          }
          filesPagination={renderMaterialPagination(currentFilePage, lastFilePage, setFilePage)}
          document={replayDocument}
          scene={scene}
          resources={resources}
          presentation={presentation}
          preparationId={preparationId}
          runDetails={runDetails}
          followNotebook={notebookFollowing && notebookLimit === undefined}
          conversationFocusRequest={conversationFocusRequest}
          onInspect={() => {
            setNotebookFollowing(false)
            pause()
          }}
          onReady={(result) => {
            setReady(result.resourcesReady)
            setDegraded(result.degraded)
            setRetryable(result.retryable)
          }}
        />
      </div>
      {degraded ? (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-t border-border-200 bg-bg-000 px-3 py-2 text-xs text-text-300"
        >
          <span>{t('Some source material is incomplete or unavailable.')}</span>
          {retryable ? (
            <Button
              variant="ghost"
              type="button"
              className={buttonClass}
              onClick={() => {
                pause()
                setResources({})
                setRunDetails({})
                setPreparationId((value) => value + 1)
              }}
            >
              {t('Prepare material again')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ReplayControls
        key={scene.branchId}
        playing={playing}
        ready={ready}
        positionMs={scene.positionMs}
        durationMs={scene.durationMs}
        stepIndex={scene.stepIndex}
        steps={branch?.steps ?? EMPTY_STEPS}
        resources={replayDocument.resources}
        onPause={pause}
        onOpenEvidence={(step) => onOpenEvidence(undefined, step)}
        speed={speed}
        onToggle={toggle}
        onPrevious={() => seek(branch?.steps[Math.max(0, scene.stepIndex - 1)]?.startMs ?? 0)}
        onNext={() =>
          seek(
            branch?.steps[Math.min((branch?.steps.length ?? 1) - 1, scene.stepIndex + 1)]
              ?.startMs ?? 0
          )
        }
        onSeek={seek}
        onSpeed={setSpeed}
        onAsk={ask}
        discussionPending={discussionPending}
      />
    </div>
  )
}

// A source replacement is a new player, even when two imports have the same package fingerprint.
export const ReplayPanel = (props: ReplayPanelProps): React.JSX.Element => (
  <ReplayPanelContent
    key={JSON.stringify([
      props.document.source.projectId,
      props.document.source.sessionId,
      props.document.source.fingerprint
    ])}
    {...props}
  />
)

export type { SessionDiscussionCapture, ReplayViewState }
