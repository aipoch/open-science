import { ErrorNotice } from '@/components/error-notice'
import {
  recordedExecutionAt,
  recordedExecutionTimes,
  type RecordedExecutionTrack,
  type RecordedExecutionAskContext
} from '@/lib/replay/recorded-execution'
import type { RecordedRunObservationSelection } from '../../../../../shared/run-observation-recorded'
import { OverlayPortalContainer } from '@/components/ui/overlay-portal-container'
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
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  ChevronUp,
  Expand,
  Shrink
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
import { ReplayStage, type ReplayMaterialView, type ReplayStageProps } from './ReplayStage'
import { ReplayLayoutMenu } from './ReplayLayoutMenu'
import { useResearchReplayLayout } from './use-research-replay-layout'
import { ReplayControls } from './ReplayControls'
import { ReplayMaterialActionProvider, type ReplayMaterialAction } from './replay-material-action'
import {
  advanceResearchReplay,
  formatReplayRecordedTime,
  type ReplayRecordedRange
} from './replay-recorded-gaps'
import { formatReplayTime } from './replay-navigation'
import type {
  RunObservationExecutionContext,
  RunObservationSnapshot
} from '../../../../../shared/run-observation'
import {
  isObservationTerminal,
  observationRecordId,
  type ReplayObservationMode
} from '@/lib/replay/live-source'
import {
  ReplayLiveRecord,
  type ReplayProjectActivation,
  type ReplayRuntimeSurface
} from './ReplayLiveRecord'
import { useObservationPhaseLabel } from './replay-observation-labels'
import { ReplaySourceDetails } from './ReplaySourceDetails'
import {
  captureDiscussionStep,
  captureDiscussionNotebookRun,
  captureDiscussionInspectedStep,
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

export type ReplayLiveSource = {
  sourceIdentity: string
  snapshot: RunObservationSnapshot
  executionContext?: RunObservationExecutionContext
  // Actual retained observations only. Hosts must disclose missing/restarted history.
  history?: readonly RunObservationSnapshot[]
  connection: 'connected' | 'reconnecting' | 'disconnected'
  runtimeSurface?: ReplayRuntimeSurface
  projectActivation?: ReplayProjectActivation
  renderActions?: (enabled: boolean) => React.ReactNode
  renderRecordedSurface?: (snapshot: RunObservationSnapshot) => React.ReactNode | undefined
  onAskSelection: (snapshot: RunObservationSnapshot) => void
  onStop?: () => void
  stopping?: boolean
  recorded?: boolean
  historyTruncated?: boolean
}

/** Archived evidence has no execution or service capabilities. */
export type ReplayRecordedSource = Pick<
  ReplayLiveSource,
  | 'sourceIdentity'
  | 'snapshot'
  | 'history'
  | 'executionContext'
  | 'onAskSelection'
  | 'historyTruncated'
>

/** Host effects are explicitly scoped. A browser uses null and supplies read-only readers. */
export type ReplayPanelHost = {
  subscribeSeek: (receive: (target: ReplaySeekTarget) => void) => () => void
  consumeSeek: (projectId: string, sessionId: string) => ReplaySeekTarget | undefined
  publishPlayhead: (playhead: {
    projectId: string
    sourceSessionId: string
    capture: () => SessionDiscussionCapture
  }) => () => void
}
const nativeReplayHost: ReplayPanelHost = {
  subscribeSeek: subscribeReplaySeek,
  consumeSeek: consumeReplaySeek,
  publishPlayhead: (playhead) => {
    useSessionReplayStore.setState({ playhead })
    return () => {
      if (useSessionReplayStore.getState().playhead === playhead)
        useSessionReplayStore.setState({ playhead: undefined })
    }
  }
}
const unavailableResourceReader: ReplayResourceReader = async () => ({
  status: 'unavailable',
  reason: 'read-failed'
})
const unavailableNotebookReader: ReplayNotebookRunReader = async () => ({
  status: 'unavailable',
  reason: 'load-failed'
})

export type ReplayPanelProps = {
  /** Opt in only for the read-only original research surface. */
  presentationMode?: 'research'
  footerReference?: React.ReactNode
  /** Undefined opts out; an empty list enables the legacy missing-observation explanation. */
  executionTracks?: readonly RecordedExecutionTrack[]
  executionNotice?: React.ReactNode
  onAskObservation?: (
    selection: RecordedRunObservationSelection,
    context: RecordedExecutionAskContext
  ) => Promise<void> | void
  info?: React.ReactNode
  host?: ReplayPanelHost | null
  /** Actual recording coverage; timestamps are absolute, never inferred activity durations. */
  recordedCoverage?: Readonly<Record<string, readonly ReplayRecordedRange[]>>
  /** Present only for branches rebuilt from actual recorded timestamps. */
  recordedTimeOrigins?: Readonly<Record<string, number>>
  materialViews?: readonly ReplayMaterialView[]
  materialViewRequest?: { id: string; revision: number }
  onMaterialViewChange?: (id: string) => void
  live?: ReplayLiveSource
  recorded?: ReplayRecordedSource
  document: ReplayDocument
  initialView?: ReplayViewState
  active?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
  onViewChange?: (state: ReplayViewState) => void
  onAskStep: (context: SessionDiscussionCapture) => void
  onChooseConversation?: (context: SessionDiscussionCapture) => void
  discussionPending?: boolean
  onOpenEvidence?: (resource: ReplayResource | undefined, step: ReplayStep) => void
  readResource?: ReplayResourceReader
  readNotebookRun?: ReplayNotebookRunReader
  renderResource?: (resource: ReplayResource, onClose: () => void) => React.ReactNode
}

const restoredPosition = (
  document: ReplayDocument,
  view?: ReplayViewState,
  origins?: Readonly<Record<string, number>>
): {
  branchId: string
  positionMs: number
  stepOffsetMs: number
  clock: 'presentation' | 'recorded'
  speed: ReplaySpeed
  relocated: boolean
} => {
  const branch =
    document.branches.find((item) => item.id === view?.branchId) ??
    document.branches.find((item) => item.id === document.defaultBranchId) ??
    document.branches[0]
  const clock = branch && origins?.[branch.id] !== undefined ? 'recorded' : 'presentation'
  const matchingClock = (view?.clock ?? 'presentation') === clock
  const exact =
    matchingClock &&
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
  const stepOffsetMs =
    step && matchingClock ? Math.min(step.durationMs, view?.stepOffsetMs ?? 0) : 0
  const fallback = step ? step.startMs + stepOffsetMs : 0
  return {
    clock,
    stepOffsetMs,
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
  document: incomingDocument,
  presentationMode,
  footerReference,
  executionTracks,
  executionNotice,
  onAskObservation,
  info,
  host = nativeReplayHost,
  recordedCoverage,
  recordedTimeOrigins,
  materialViews,
  materialViewRequest,
  onMaterialViewChange,
  live: liveSource,
  recorded,
  initialView,
  active = true,
  expanded = false,
  onToggleExpanded,
  onViewChange,
  onAskStep,
  onChooseConversation,
  discussionPending = false,
  onOpenEvidence,
  readResource = host ? undefined : unavailableResourceReader,
  renderResource,
  readNotebookRun = host ? defaultNotebookReader : unavailableNotebookReader
}: ReplayPanelProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  // Pick the narrow historical fields explicitly, even if an untyped caller supplies extras.
  const live = useMemo<ReplayLiveSource | undefined>(
    () =>
      recorded
        ? {
            sourceIdentity: recorded.sourceIdentity,
            snapshot: recorded.snapshot,
            history: recorded.history,
            executionContext: recorded.executionContext,
            onAskSelection: recorded.onAskSelection,
            historyTruncated: recorded.historyTruncated,
            connection: 'disconnected',
            recorded: true
          }
        : liveSource,
    [recorded, liveSource]
  )
  const researchPresentation = presentationMode === 'research' && !live
  const phaseLabel = useObservationPhaseLabel()
  const [materialViewId, setMaterialViewId] = useState(
    materialViewRequest?.id ?? (researchPresentation ? 'conversation' : 'notebook')
  )
  const [materialAction, setMaterialAction] = useState<ReplayMaterialAction>()
  const [paneActions, setPaneActions] = useState<Record<string, ReplayMaterialAction | undefined>>(
    {}
  )
  const [inspectedContents, setInspectedContents] = useState<
    Partial<Record<'conversation' | 'notebook', ReplayStageProps['selectedContent']>>
  >({})
  const [focusedPane, setFocusedPane] = useState(materialViewId)
  const [selectedResourcePaneId, setSelectedResourcePaneId] = useState<string>()
  const [fullscreen, setFullscreen] = useState(false)
  // The desktop workbench expands previews without entering DOM fullscreen.
  // Both surfaces have room for research panes; only real fullscreen owns its exit/portal.
  const layoutExpanded = fullscreen || (researchPresentation && host !== null && expanded)
  const paneCatalog = useMemo(
    () => [
      { id: 'conversation', label: t('Original conversation') },
      { id: 'notebook', label: t('Notebook') },
      ...(materialViews ?? []).map(({ id, label }) => ({ id, label }))
    ],
    [materialViews, t]
  )
  const paneIds = useMemo(() => paneCatalog.map(({ id }) => id), [paneCatalog])
  const {
    preferences: layoutPreferences,
    changePreferences: changeLayoutPreferences,
    rememberMaterial,
    layout: researchLayout
  } = useResearchReplayLayout({
    enabled: researchPresentation,
    fullscreen: layoutExpanded,
    paneIds,
    materialId: materialViewId,
    native: host !== null,
    sourceKey: JSON.stringify([
      incomingDocument.source.projectId,
      incomingDocument.source.sessionId,
      incomingDocument.source.fingerprint
    ])
  })
  const focusedPaneId =
    researchPresentation && layoutExpanded
      ? researchLayout.visiblePaneIds.includes(focusedPane)
        ? focusedPane
        : (researchLayout.visiblePaneIds[0] ?? 'conversation')
      : materialViewId
  const inspectedContent = inspectedContents[focusedPaneId as 'conversation' | 'notebook']
  const setInspectedContent = (selection: ReplayStageProps['selectedContent']): void => {
    if (!selection) setInspectedContents({})
    else {
      setInspectedContents((previous) => ({ ...previous, [selection.kind]: selection }))
      setFocusedPane(selection.kind)
    }
  }
  const renderMaterialPane = useCallback(
    (id: string, content: React.ReactNode) => (
      <ReplayMaterialActionProvider
        key={id}
        enabled={researchPresentation}
        onActionChange={(action) =>
          setPaneActions((previous) =>
            previous[id] === action ? previous : { ...previous, [id]: action }
          )
        }
      >
        {content}
      </ReplayMaterialActionProvider>
    ),
    [researchPresentation]
  )
  // Inspecting freezes both record navigation and bounded evidence. New logs never replace
  // the evidence a user is reading or about to reference in a question.
  const [inspection, setInspection] = useState<{
    document: ReplayDocument
    snapshots: readonly RunObservationSnapshot[]
  }>()
  const replayDocument = inspection?.document ?? incomingDocument
  const observationHistory = useMemo(
    () => inspection?.snapshots ?? live?.history ?? (live ? [live.snapshot] : []),
    [inspection, live]
  )
  const observationMode: ReplayObservationMode | undefined = live
    ? inspection
      ? 'inspect'
      : live.recorded || isObservationTerminal(live.snapshot)
        ? 'history'
        : 'follow'
    : undefined
  const [presentation] = useState(() =>
    createReplayPresentation(
      i18n.resolvedLanguage ?? i18n.language ?? 'en',
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  )
  const initial = useMemo(
    () => restoredPosition(replayDocument, initialView, recordedTimeOrigins),
    [replayDocument, initialView, recordedTimeOrigins]
  )
  const [branchPositions] = useState(
    () =>
      new Map(
        initialView?.branchPositions?.flatMap((position) => {
          if (!replayDocument.branches.some((branch) => branch.id === position.branchId)) return []
          const restored = restoredPosition(
            replayDocument,
            {
              ...initialView,
              ...position,
              clock: position.clock,
              anchor: undefined
            },
            recordedTimeOrigins
          )
          return [
            [
              position.branchId,
              {
                ...position,
                clock: restored.clock,
                stepOffsetMs: restored.stepOffsetMs,
                timeMs: restored.positionMs
              }
            ]
          ]
        })
      )
  )
  const [branchId, setBranchId] = useState(initial.branchId)
  const [selectedResourceId, setSelectedResourceId] = useState<string>()
  const [positionMs, setPositionMs] = useState(initial.positionMs)
  const [speed, setSpeed] = useState<ReplaySpeed>(initial.speed)
  const [playing, setPlaying] = useState(false)
  const [observationPending, setObservationPending] = useState(false)
  const [observationError, setObservationError] = useState<string>()
  const observationPendingRef = useRef(false)
  const [skipNoNewRecords, setSkipNoNewRecords] = useState(false)
  const [skipped, setSkipped] = useState<{ from: number; to: number }>()
  const skippedFrame = useRef<{ from: number; to: number } | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [wide, setWide] = useState(false)
  const [liveProjectTabActive, setLiveProjectTabActive] = useState(false)
  const [materialsOverride, setMaterialsOverride] = useState<boolean | undefined>(
    materialViewRequest ? true : undefined
  )
  const materialsOpen = researchPresentation
    ? researchLayout.visiblePaneIds.some((id) => id !== 'conversation') ||
      Boolean(selectedResourceId)
    : (materialsOverride ?? ((!live || !!recorded) && (expanded || wide)))
  const [handledMaterialRequest, setHandledMaterialRequest] = useState(materialViewRequest)
  if (materialViewRequest && materialViewRequest !== handledMaterialRequest) {
    setHandledMaterialRequest(materialViewRequest)
    setMaterialViewId(materialViewRequest.id)
    setFocusedPane(materialViewRequest.id)
    rememberMaterial(materialViewRequest.id)
    if (
      layoutExpanded &&
      layoutPreferences.mode === 'columns' &&
      !layoutPreferences.visiblePaneIds.includes(materialViewRequest.id)
    )
      changeLayoutPreferences({
        ...layoutPreferences,
        visiblePaneIds: [...layoutPreferences.visiblePaneIds, materialViewRequest.id]
      })
    if (materialViewRequest.id !== materialViewId) setMaterialAction(undefined)
    setInspectedContent(undefined)
    setMaterialsOverride(true)
  }

  const [filesOverride, setFilesOverride] = useState<boolean>()
  const filesOpen = filesOverride ?? (!researchPresentation && (expanded || wide))
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
  const [informationOpen, setInformationOpen] = useState(false)
  const [informationActive, setInformationActive] = useState(active)
  if (informationActive !== active) {
    setInformationActive(active)
    if (!active) setInformationOpen(false)
  }
  const researchContentId = useId()
  const questionActionChosen = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!researchPresentation) return
    const update = (): void => {
      const next = document.fullscreenElement === panel.current
      setFullscreen(next)
    }
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [researchPresentation])
  const [tooltipBoundary, setTooltipBoundary] = useState<HTMLDivElement | null>(null)
  const [seekMissing, setSeekMissing] = useState(false)
  const [resources, setResources] = useState<ReplayResourceMap>({})
  const [preparationId, setPreparationId] = useState(0)
  const [degraded, setDegraded] = useState(false)
  const [retryable, setRetryable] = useState(false)
  const [runDetails, setRunDetails] = useState<Readonly<Record<string, ReplayNotebookRunDetails>>>(
    {}
  )
  const scene = useMemo(() => {
    const target =
      replayDocument.branches.find((item) => item.id === branchId) ?? replayDocument.branches[0]
    const result = projectReplayScene(
      replayDocument,
      target.id,
      live && !inspection ? target.durationMs : positionMs,
      recordedTimeOrigins?.[target.id]
    )
    // Observed snapshots expose only actual recorded data; never animate an imagined
    // input/activity/result boundary within a snapshot.
    return live
      ? {
          ...result,
          phase: 'result' as const,
          showResults: true,
          stepProgress: 1,
          visibleResourceIds: [...new Set(result.visibleSteps.flatMap((step) => step.resourceIds))]
        }
      : result
  }, [replayDocument, branchId, positionMs, live, inspection, recordedTimeOrigins])
  const branch = replayDocument.branches.find((item) => item.id === scene.branchId)
  const executionStates = useMemo(() => {
    const origin = recordedTimeOrigins?.[scene.branchId]
    return !live && origin !== undefined
      ? executionTracks
          ?.filter((track) => track.branchId === scene.branchId)
          .map((track) => recordedExecutionAt(track, origin + scene.positionMs))
      : undefined
  }, [executionTracks, recordedTimeOrigins, scene.branchId, scene.positionMs, live])
  const observationTimes = useMemo(
    () => recordedExecutionTimes(executionTracks ?? [], scene.branchId),
    [executionTracks, scene.branchId]
  )
  const nextObservationTime = observationTimes.find(
    (time) => time > (recordedTimeOrigins?.[scene.branchId] ?? Infinity) + scene.positionMs
  )
  const currentObservation = live
    ? observationHistory.find((snapshot) => observationRecordId(snapshot) === scene.step?.id)
    : undefined
  const inspect = useCallback(() => {
    if (!live || inspection) return
    setInspection({ document: replayDocument, snapshots: observationHistory })
    setPositionMs(scene.positionMs)
  }, [live, inspection, replayDocument, observationHistory, scene.positionMs])
  const returnToLive = (): void => {
    setInspection(undefined)
    setPlaying(false)
    setSelectedResourceId(undefined)
    setNotebookFollowing(true)
    setConversationFocusRequest((value) => value + 1)
  }

  const materialCatalog = useMemo(() => {
    const steps = branch?.steps.slice(0, scene.stepIndex + 1) ?? []
    const runs = new Map<string, ReplayRunIndex>()
    const ids = new Set<string>()
    for (const step of steps) {
      for (const run of step.runs) runs.set(run.runId, run)
      const origin = recordedTimeOrigins?.[scene.branchId]
      const showStepResults =
        origin === undefined
          ? step.id !== scene.step?.id || scene.showResults
          : step.recordedEndAt === undefined || step.recordedEndAt <= origin + scene.positionMs
      if (showStepResults) for (const id of step.resourceIds) ids.add(id)
    }
    return {
      runs: [...runs.values()],
      files: replayDocument.resources.filter((resource) => ids.has(resource.id))
    }
  }, [
    branch,
    scene.stepIndex,
    scene.step?.id,
    scene.showResults,
    replayDocument.resources,
    recordedTimeOrigins,
    scene.branchId,
    scene.positionMs
  ])
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
    clock: recordedTimeOrigins?.[scene.branchId] === undefined ? 'presentation' : 'recorded',
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
        clock: recordedTimeOrigins?.[scene.branchId] === undefined ? 'presentation' : 'recorded',
        branchId: scene.branchId,
        stepId: scene.step?.id,
        stepOffsetMs: scene.step ? scene.positionMs - scene.step.startMs : 0,
        timeMs: scene.positionMs
      })
  }
  useLayoutEffect(() => {
    viewRef.current = viewSnapshot
    for (const position of viewSnapshot.branchPositions ?? [])
      branchPositions.set(position.branchId, {
        ...position,
        clock:
          position.clock ??
          (recordedTimeOrigins?.[position.branchId] === undefined ? 'presentation' : 'recorded')
      })
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
      if (previous !== undefined) {
        // React can defer a functional update until after this animation callback returns.
        // Capture the elapsed interval before advancing the mutable frame timestamp.
        const elapsedMs = Math.min(250, time - previous) * speed
        setPositionMs((position) => {
          const next = advanceResearchReplay({
            positionMs: position,
            elapsedMs,
            durationMs: scene.durationMs,
            origin: recordedTimeOrigins?.[scene.branchId],
            steps: branch?.steps ?? [],
            ranges: recordedCoverage?.[scene.branchId] ?? [],
            skip: skipNoNewRecords,
            observationTimes
          })
          if (next.skipped) skippedFrame.current = next.skipped
          return next.positionMs
        })
      }
      previous = time
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [
    playing,
    active,
    ready,
    speed,
    scene.durationMs,
    scene.ended,
    scene.branchId,
    recordedTimeOrigins,
    recordedCoverage,
    branch,
    skipNoNewRecords,
    observationTimes
  ])

  useEffect(() => {
    if (skippedFrame.current) {
      setSkipped(skippedFrame.current)
      skippedFrame.current = undefined
    }
  }, [positionMs])

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

  const pause = useCallback(() => {
    setPlaying(false)
    inspect()
  }, [inspect])
  const selectResource = useCallback(
    (id?: string): void => {
      if (id && !materialCatalog.files.some((resource) => resource.id === id)) return
      pause()
      if (id && (!researchPresentation || focusedPaneId === 'notebook')) setNotebookFollowing(false)
      if (id && !selectedResourceId) beforeFile.current = materialsOpen
      setSelectedResourceId(id)
      if (id) setSelectedResourcePaneId(focusedPaneId)
      setMaterialsOverride(id ? true : beforeFile.current)
      if (id && (!wide || researchPresentation)) setFilesOverride(false)
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
    [
      materialCatalog.files,
      pause,
      selectedResourceId,
      materialsId,
      materialsOpen,
      wide,
      researchPresentation,
      focusedPaneId
    ]
  )
  const seek = useCallback(
    (position: number) => {
      inspect()
      setPlaying(false)
      setSelectedResourceId(undefined)
      setPositionMs(position)
      setSkipped(undefined)
      setInspectedContent(undefined)
      setConversationFocusRequest((request) => request + 1)
      setNotebookFollowing(true)

      setNotebookLimit(undefined)
      setFilePage(0)
    },
    [setPlaying, setPositionMs, setSelectedResourceId, inspect]
  )
  useEffect(() => {
    if (live || !host) return
    const receive = (target: ReplaySeekTarget): void => {
      if (
        target.projectId !== replayDocument.source.projectId ||
        target.sourceSessionId !== replayDocument.source.sessionId
      )
        return
      host.consumeSeek(target.projectId, target.sourceSessionId)
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
    const unsubscribe = host.subscribeSeek(receive)
    const pending = host.consumeSeek(
      replayDocument.source.projectId,
      replayDocument.source.sessionId
    )
    if (pending) receive(pending)
    return unsubscribe
  }, [replayDocument, seek, live, host])

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
    if (!active || !hasStep || live || !host) return
    const playhead = {
      projectId: replayDocument.source.projectId,
      sourceSessionId: replayDocument.source.sessionId,
      capture: () => captureCurrent.current()
    }
    return host.publishPlayhead(playhead)
  }, [active, hasStep, replayDocument, live, host])

  const ask = (): void => {
    if (!active) return
    pause()
    if (live) {
      if (currentObservation) live.onAskSelection(structuredClone(currentObservation))
    } else if (scene.step)
      onAskStep(captureDiscussionStep(replayDocument, scene, runDetails, resources))
  }
  const askSession = (): void => {
    if (!active) return
    pause()
    const context = captureDiscussionSession(replayDocument)
    if (context) onAskStep({ ...context, stepTitle: t('Entire research') })
  }
  const toggle = (): void => {
    if (live) {
      if (inspection) returnToLive()
      else pause()
      return
    }
    if (!branch?.steps.length) return
    setSelectedResourceId(undefined)
    setInspectedContent(undefined)
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

  const branchSelector =
    replayDocument.branches.length > 1 ? (
      <Select
        value={scene.branchId}
        onOpenChange={(open) => {
          if (open) pause()
        }}
        onValueChange={(value) => {
          pause()
          setSelectedResourceId(undefined)
          setInspectedContent(undefined)
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
                    {replayDocument.branches.findIndex((item) => item.id === scene.branchId) + 1}
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
                      replayDocument.branches.findIndex((item) => item.id === scene.branchId) + 1
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
    ) : null
  const selectMaterial = (id: string): void => {
    setFocusedPane(id)
    rememberMaterial(id)
    if (
      layoutExpanded &&
      layoutPreferences.mode === 'columns' &&
      !layoutPreferences.visiblePaneIds.includes(id)
    )
      changeLayoutPreferences({
        ...layoutPreferences,
        visiblePaneIds: [...layoutPreferences.visiblePaneIds, id]
      })
    if (id === materialViewId) return
    if (!researchPresentation) {
      setMaterialAction(undefined)
      setSelectedResourceId(undefined)
      setInspectedContent(undefined)
    }
    setMaterialViewId(id)
    onMaterialViewChange?.(id)
  }
  const inspectedStep =
    inspectedContent?.kind === focusedPaneId
      ? branch?.steps.find((step) => step.id === inspectedContent.stepId)
      : undefined
  const notebookStep =
    inspectedStep ?? [...scene.visibleSteps].reverse().find((step) => step.runs.length)
  const contentStep = focusedPaneId === 'notebook' ? notebookStep : (inspectedStep ?? scene.step)
  const contentAction =
    focusedPaneId !== 'conversation' && focusedPaneId !== 'notebook'
      ? researchPresentation
        ? paneActions[focusedPaneId]
        : materialAction
      : undefined
  const selectedExecution =
    focusedPaneId === 'notebook'
      ? executionStates?.find(
          (state) =>
            state.track.runId ===
            (inspectedContent?.runId ??
              (contentStep?.runs.length === 1 ? contentStep.runs[0].runId : undefined))
        )
      : undefined
  const observationAction =
    onAskObservation && selectedExecution?.snapshot ? selectedExecution : undefined
  const observationActionKey = JSON.stringify([
    scene.branchId,
    observationAction?.track.id,
    observationAction?.snapshot?.stepId
  ])
  const askObservation = async (): Promise<void> => {
    if (
      !active ||
      !observationAction?.snapshot ||
      !onAskObservation ||
      observationPendingRef.current ||
      discussionPending
    )
      return
    pause()
    observationPendingRef.current = true
    setObservationPending(true)
    setObservationError(undefined)
    try {
      await onAskObservation(observationAction.track.select(observationAction.snapshot), {
        branchId: scene.branchId,
        stepId: observationAction.track.stepId,
        runId: observationAction.track.runId,
        timeMs: scene.positionMs
      })
    } catch {
      setObservationError(observationActionKey)
    } finally {
      observationPendingRef.current = false
      setObservationPending(false)
    }
  }
  const askContent = (runOnly = false): void => {
    if (!active) return
    pause()
    if (!runOnly && observationAction) {
      void askObservation()
      return
    }
    if (contentAction) {
      contentAction.onAsk()
      return
    }
    if (!contentStep) return
    if (focusedPaneId === 'notebook') {
      const runId = inspectedContent?.runId ?? contentStep.runs.at(-1)?.runId
      if (!runId) return
      const captured = captureDiscussionNotebookRun(
        replayDocument,
        scene,
        contentStep.id,
        runId,
        recordedTimeOrigins?.[scene.branchId],
        runDetails,
        resources
      )
      if (captured) onAskStep(captured)
      return
    }
    if (!inspectedContent) {
      onAskStep(captureDiscussionStep(replayDocument, scene, runDetails, resources))
      return
    }
    const captured = captureDiscussionInspectedStep(
      replayDocument,
      scene,
      contentStep.id,
      inspectedContent.savedHistory,
      recordedTimeOrigins?.[scene.branchId],
      runDetails,
      resources
    )
    if (captured) onAskStep(captured)
  }
  const contentLabel =
    (observationAction ? t('Ask about this status') : undefined) ??
    contentAction?.label ??
    (focusedPaneId === 'notebook'
      ? t('Ask about this run')
      : focusedPaneId === 'conversation'
        ? t('Ask about this record')
        : t('Ask about this content'))
  const contentDisabled =
    observationPending ||
    !active ||
    discussionPending ||
    Boolean(contentAction?.disabled || contentAction?.pending) ||
    (focusedPaneId === 'conversation' || focusedPaneId === 'notebook'
      ? !contentStep
      : !contentAction)
  const selectedRun =
    focusedPaneId === 'notebook'
      ? (contentStep?.runs.find((run) => run.runId === inspectedContent?.runId) ??
        contentStep?.runs.at(-1))
      : undefined
  const referenceRecordedAt = observationAction?.snapshot
    ? observationAction.snapshot.observedAt
    : contentAction
      ? contentAction.recordedAt
      : (selectedRun?.startedAt ?? contentStep?.recordedAt)
  const referenceOrigin = recordedTimeOrigins?.[scene.branchId]
  const referencePosition =
    referenceRecordedAt !== undefined &&
    Number.isFinite(referenceRecordedAt) &&
    referenceOrigin !== undefined &&
    Number.isFinite(referenceOrigin)
      ? referenceRecordedAt - referenceOrigin
      : undefined

  const researchTabs =
    researchPresentation && researchLayout.mode !== 'columns' ? (
      <div
        data-replay-layout-control
        role="tablist"
        aria-label={t('Research materials')}
        onKeyDown={(event) => {
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          const current = tabs.findIndex((tab) => tab === document.activeElement)
          const next =
            event.key === 'ArrowRight'
              ? (current + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (current - 1 + tabs.length) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1
          if (next < 0) return
          event.preventDefault()
          tabs[next]?.click()
          tabs[next]?.focus()
        }}
        className="flex shrink-0 gap-1 overflow-x-auto bg-bg-000 px-2 py-1"
      >
        {paneCatalog
          .filter((view) => !layoutExpanded || view.id !== 'conversation')
          .map((view) => (
            <Button
              key={view.id}
              role="tab"
              aria-selected={
                (layoutExpanded ? layoutPreferences.rightMaterialId : materialViewId) === view.id
              }
              aria-controls={layoutExpanded ? `${researchContentId}-material` : researchContentId}
              tabIndex={
                (layoutExpanded ? layoutPreferences.rightMaterialId : materialViewId) === view.id
                  ? 0
                  : -1
              }
              data-replay-material-view={view.id}
              variant={
                (layoutExpanded ? layoutPreferences.rightMaterialId : materialViewId) === view.id
                  ? 'secondary'
                  : 'ghost'
              }
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => selectMaterial(view.id)}
            >
              {view.label}
            </Button>
          ))}
      </div>
    ) : null
  return (
    <div
      ref={panel}
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg-10"
      data-testid="replay-panel"
      data-replay-layout-mode={researchPresentation ? researchLayout.mode : undefined}
      data-replay-presentation={researchPresentation ? 'research' : undefined}
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
      aria-label={live && !live.recorded ? t('Run observation') : t('Research replay')}
    >
      <div
        data-testid="replay-header"
        className="flex shrink-0 items-center gap-1 border-b border-border-200 bg-bg-000 px-2 py-1"
      >
        <div className="min-w-0 flex-1">
          {!researchPresentation ? (
            <p className="px-2 text-[11px] text-text-300" data-testid="replay-process-kind">
              {live
                ? live.recorded
                  ? t('Experiment run · Saved recording')
                  : isObservationTerminal(live.snapshot)
                    ? t('Experiment run · Run history')
                    : t('Experiment run · Live observation')
                : t('Session process · Reconstructed from records')}
            </p>
          ) : null}
          <Popover
            open={informationOpen}
            onOpenChange={(open) => {
              setInformationOpen(open)
              if (open) pause()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size={live || researchPresentation ? 'sm' : 'default'}
                className="min-w-0 max-w-full justify-start gap-1.5 px-2 text-[13px] font-semibold"
                data-testid="replay-information-trigger"
                aria-label={t('Session information: {{title}}', {
                  title: replayDocument.source.title
                })}
              >
                <span className="truncate">{replayDocument.source.title}</span>
                {researchPresentation ? (
                  <span className="shrink-0 text-xs font-normal text-text-300">
                    {t('Read-only')}
                  </span>
                ) : null}
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
                {live
                  ? t('Recorded execution observations')
                  : t('Reconstructed from archived records')}
              </p>
              <p className="my-3 text-xs text-muted-foreground">
                {t('Recorded steps: {{steps}}; files: {{files}}', {
                  steps: branch?.steps.length ?? 0,
                  files: replayDocument.resources.length
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {live
                  ? t(
                      'Only observed records are shown. Earlier activity may not have been captured.'
                    )
                  : recordedTimeOrigins?.[scene.branchId] !== undefined
                    ? t(
                        'Playback follows recorded research timestamps; gaps do not imply inactivity.'
                      )
                    : t('Presentation timing is reconstructed; recorded results are unchanged.')}
              </p>
              {researchPresentation ? (
                <div className="my-3 flex flex-wrap items-center gap-2">
                  {branchSelector}
                  <PopoverClose asChild>
                    <Button variant="outline" size="sm" onClick={() => setFilesOverride(true)}>
                      <Files size={14} aria-hidden="true" />
                      {t('View files')}
                    </Button>
                  </PopoverClose>
                  {info}
                </div>
              ) : null}
              {replayDocument.source.packageOrigin ? (
                <div className="border-t border-border pt-3">
                  <ReplaySourceDetails source={replayDocument.source} onInspect={pause} />
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
        {!researchPresentation && (!live || recorded) ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={askSession}
                  disabled={
                    !active ||
                    discussionPending ||
                    !replayDocument.branches.some((item) => item.steps.length)
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
        ) : null}
        {onChooseConversation && !live && !researchPresentation ? (
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
                  disabled={!active || discussionPending || !scene.step}
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
        {!researchPresentation ? branchSelector : null}
        {!researchPresentation && (!live || recorded) ? (
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
                  aria-label={materialViews?.length ? t('Research materials') : t('Notebook')}
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
                {materialViews?.length ? t('Research materials') : t('Notebook')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {!researchPresentation ? (
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
        ) : null}
        {researchPresentation && layoutExpanded ? (
          <ReplayLayoutMenu
            preferences={layoutPreferences}
            onChange={changeLayoutPreferences}
            panes={paneCatalog}
          />
        ) : null}
        {researchPresentation ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? t('Exit full screen') : t('Enter full screen')}
            onClick={() => {
              if (document.fullscreenElement === panel.current) void document.exitFullscreen?.()
              else void panel.current?.requestFullscreen?.().catch(() => undefined)
            }}
          >
            {fullscreen ? (
              <Shrink size={16} aria-hidden="true" />
            ) : (
              <Expand size={16} aria-hidden="true" />
            )}
          </Button>
        ) : null}
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
                  aria-label={
                    researchPresentation
                      ? expanded
                        ? t('Collapse preview')
                        : t('Expand preview')
                      : expanded
                        ? t('Exit full screen')
                        : t('Enter full screen')
                  }
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
                {researchPresentation
                  ? expanded
                    ? t('Collapse preview')
                    : t('Expand preview')
                  : expanded
                    ? t('Exit full screen')
                    : t('Enter full screen')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {researchPresentation && !layoutExpanded ? researchTabs : null}
      {live ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-200 px-3 py-1 text-xs"
          data-testid="replay-live-status"
        >
          <div className="min-w-0" role="status">
            <span>
              {observationMode === 'follow'
                ? t('Following live')
                : observationMode === 'inspect'
                  ? t('Inspecting recorded evidence')
                  : t('Run history')}
            </span>
            <span className="ml-2">
              {live.recorded
                ? t('Recorded run: {{status}}', { status: phaseLabel(live.snapshot.phase) })
                : t('Current run: {{status}}', { status: phaseLabel(live.snapshot.phase) })}
            </span>
            {!live.recorded && live.connection !== 'connected' ? (
              <span className="ml-2 text-status-warning-foreground">
                {live.connection === 'reconnecting'
                  ? t('Reconnecting to the run…')
                  : t('Live connection unavailable')}
              </span>
            ) : null}
          </div>
          {inspection || (!live.recorded && !isObservationTerminal(live.snapshot)) ? (
            <Button variant="secondary" size="sm" onClick={inspection ? returnToLive : pause}>
              {inspection
                ? live.recorded || isObservationTerminal(live.snapshot)
                  ? t('Show latest record')
                  : t('Back to live')
                : t('Pause following')}
            </Button>
          ) : null}
          {live.onStop && !live.recorded && !isObservationTerminal(live.snapshot) ? (
            <Button variant="outline" size="sm" disabled={live.stopping} onClick={live.onStop}>
              {live.stopping ? t('Waiting for the run to stop…') : t('Stop run')}
            </Button>
          ) : null}
          {inspection ? (
            <p className="w-full text-muted-foreground">
              {live.recorded
                ? t('Inspecting archived evidence. No live execution is connected.')
                : isObservationTerminal(live.snapshot)
                  ? t('Inspecting an earlier recorded state. The run has ended.')
                  : t('Viewing is paused. The experiment continues independently.')}
            </p>
          ) : null}
        </div>
      ) : null}
      {replayDocument.issues.some((issue) => issue.code === 'review-unavailable') ? (
        <p role="status" className="border-b border-border-200 px-3 py-2 text-xs text-text-300">
          {t('Session Reviewer')}: {t('The recorded evidence is unavailable.')}
        </p>
      ) : null}
      {live?.renderActions?.(
        observationMode === 'follow' &&
          live.connection === 'connected' &&
          live.snapshot.run?.status === 'running'
      )}
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
      <div
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        id={researchPresentation ? researchContentId : undefined}
        role={researchPresentation ? (layoutExpanded ? 'region' : 'tabpanel') : undefined}
        aria-label={
          researchPresentation && layoutExpanded
            ? t('Research materials')
            : researchPresentation
              ? materialViewId === 'conversation'
                ? t('Original conversation')
                : materialViewId === 'notebook'
                  ? t('Notebook')
                  : materialViews?.find((view) => view.id === materialViewId)?.label
              : undefined
        }
      >
        <ReplayMaterialActionProvider
          enabled={researchPresentation}
          onActionChange={setMaterialAction}
        >
          <ReplayStage
            presentationMode={researchPresentation ? 'research' : undefined}
            onSelectContent={researchPresentation ? setInspectedContent : undefined}
            selectedContent={researchPresentation ? inspectedContent : undefined}
            selectedContentByPane={researchPresentation ? inspectedContents : undefined}
            researchLayout={researchPresentation ? researchLayout : undefined}
            researchMaterialTabs={layoutExpanded ? researchTabs : undefined}
            researchTabPanelId={`${researchContentId}-material`}
            focusedPaneId={researchPresentation ? focusedPaneId : undefined}
            onFocusPane={researchPresentation ? setFocusedPane : undefined}
            selectedResourcePaneId={selectedResourcePaneId}
            renderMaterialPane={researchPresentation ? renderMaterialPane : undefined}
            onBrowsePane={(id) => {
              if (id === 'notebook') setNotebookFollowing(false)
            }}
            onFollowPane={(id) => {
              if (id === 'notebook') {
                setNotebookFollowing(true)
                setNotebookLimit(undefined)
              }
            }}
            sourceIdentity={live?.sourceIdentity}
            renderResource={renderResource}
            followPrimary={
              !live || (!live.recorded && !inspection && active && !liveProjectTabActive)
            }
            primaryMode={liveProjectTabActive ? 'project' : 'record'}
            liveProjectActive={
              liveProjectTabActive &&
              observationMode === 'follow' &&
              live?.connection === 'connected' &&
              live.snapshot.phase === 'running' &&
              live.snapshot.run?.status === 'running'
            }
            primaryLabel={live ? t('Execution record') : undefined}
            primaryContent={
              live && currentObservation ? (
                <ReplayLiveRecord
                  historicalOnly={!!recorded}
                  snapshot={currentObservation}
                  latestSnapshot={live.snapshot}
                  executionContext={live.executionContext ?? live.snapshot.executionContext}
                  mode={observationMode!}
                  recordedSurface={live.renderRecordedSurface?.(currentObservation)}
                  historyTruncated={live.historyTruncated}
                  onProjectActiveChange={setLiveProjectTabActive}
                  projectActivation={
                    observationMode === 'follow' &&
                    live.connection === 'connected' &&
                    !live.recorded &&
                    live.snapshot.phase === 'running' &&
                    live.snapshot.run?.status === 'running'
                      ? live.projectActivation
                      : undefined
                  }
                  runtimeSurface={
                    live.connection === 'connected' &&
                    !live.recorded &&
                    live.snapshot.phase === 'running' &&
                    live.snapshot.run?.status === 'running'
                      ? live.runtimeSurface
                      : undefined
                  }
                />
              ) : undefined
            }
            fitContainer
            selectedResource={selectedResource}
            onSelectResource={selectResource}
            wide={researchPresentation ? false : wide}
            materialsOpen={materialsOpen}
            materialsId={materialsId}
            materialViews={materialViews}
            executionStates={executionStates}
            executionNotice={executionNotice}
            materialPlayback={{
              branchId: scene.branchId,
              positionMs: scene.positionMs,
              recordedAt:
                recordedTimeOrigins?.[scene.branchId] !== undefined
                  ? recordedTimeOrigins[scene.branchId] + scene.positionMs
                  : scene.step?.recordedAt,
              continuous: recordedTimeOrigins?.[scene.branchId] !== undefined,
              playing: playing && active && ready && !scene.ended,
              speed,
              onPause: pause,
              onSeekRecordedAt: (recordedAt) => {
                const origin = recordedTimeOrigins?.[scene.branchId]
                if (origin !== undefined) seek(recordedAt - origin)
                else {
                  // Snapshot navigation has discrete anchors. Use the latest known state;
                  // never stretch its presentation duration to simulate elapsed recording time.
                  const step = branch?.steps
                    .filter(
                      (step) => step.recordedAt !== undefined && step.recordedAt <= recordedAt
                    )
                    .reduce<ReplayStep | undefined>(
                      (latest, step) =>
                        !latest || step.recordedAt! >= latest.recordedAt! ? step : latest,
                      undefined
                    )
                  if (step) seek(step.startMs)
                  else pause()
                }
              }
            }}
            materialsActive={active}
            materialViewId={materialViewId}
            onMaterialViewChange={selectMaterial}
            filesOpen={filesOpen}
            filesId={filesId}
            onOpenFiles={() => setFilesOverride(true)}
            onCloseFiles={() => {
              setFilesOverride(false)
              if (researchPresentation)
                panel.current
                  ?.querySelector<HTMLElement>('[data-testid="replay-information-trigger"]')
                  ?.focus()
              else filesTrigger.current?.focus()
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
                      if (!researchPresentation) pause()
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
              if (!researchPresentation) setNotebookFollowing(false)
              pause()
            }}
            onReady={(result) => {
              setReady(result.resourcesReady)
              setDegraded(result.degraded)
              setRetryable(result.retryable)
            }}
          />
        </ReplayMaterialActionProvider>
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
      {skipped ? (
        <p
          role="status"
          className="shrink-0 border-t border-border-200 px-3 py-1 text-xs text-text-300"
        >
          {t('Skipped an interval without new records: {{from}} → {{to}}', {
            from: formatReplayTime(skipped.from),
            to: formatReplayTime(skipped.to)
          })}
        </p>
      ) : null}
      <ReplayControls
        compact={researchPresentation}
        hideAsk={researchPresentation}
        skipNoNewRecords={
          recordedTimeOrigins?.[scene.branchId] !== undefined && !live
            ? skipNoNewRecords
            : undefined
        }
        onSkipNoNewRecords={setSkipNoNewRecords}
        nextObservationPosition={
          nextObservationTime !== undefined
            ? nextObservationTime - recordedTimeOrigins![scene.branchId]
            : undefined
        }
        key={scene.branchId}
        playing={playing}
        recordNavigation={Boolean(live)}
        ready={ready}
        positionMs={scene.positionMs}
        durationMs={scene.durationMs}
        recordedCoverage={researchPresentation ? recordedCoverage?.[scene.branchId] : undefined}
        recordedTimeOrigin={recordedTimeOrigins?.[scene.branchId]}
        stepIndex={scene.stepIndex}
        steps={branch?.steps ?? EMPTY_STEPS}
        resources={replayDocument.resources}
        onPause={pause}
        onOpenEvidence={(step) =>
          live || !onOpenEvidence ? seek(step.startMs) : onOpenEvidence(undefined, step)
        }
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
        discussionPending={!active || discussionPending}
      />
      {researchPresentation ? (
        <div
          className="flex shrink-0 flex-col gap-1.5 border-t border-border-200 bg-bg-000 px-3 py-2"
          data-testid="replay-question-footer"
        >
          <div
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[10px] text-text-300"
            data-testid="replay-reference-time"
          >
            <span>
              {referencePosition !== undefined && referencePosition >= 0 && !contentDisabled
                ? t('Reference time: {{time}}', {
                    time: formatReplayRecordedTime(referencePosition)
                  })
                : t('Reference time unavailable')}
            </span>
            <span>
              {t('Playback position: {{time}}', {
                time: formatReplayRecordedTime(scene.positionMs)
              })}
            </span>
          </div>
          {layoutExpanded ? (
            <span className="text-xs font-medium text-text-200" data-testid="replay-question-pane">
              {paneCatalog.find((pane) => pane.id === focusedPaneId)?.label}
            </span>
          ) : null}
          <div className="flex w-full min-w-0 items-center">
            <Button
              size="sm"
              variant="default"
              disabled={contentDisabled}
              onClick={() => askContent()}
              className="h-8 min-w-0 flex-1 rounded-r-none"
              title={contentAction?.title}
            >
              <MessageSquare size={14} aria-hidden="true" />
              <span className="truncate">{contentLabel}</span>
            </Button>
            <Popover
              onOpenChange={(open) => {
                if (open) {
                  questionActionChosen.current = false
                  pause()
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 rounded-l-none border-l border-primary-foreground/20 px-2"
                  aria-label={t('Question options')}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="flex w-64 flex-col gap-1 p-1"
                onCloseAutoFocus={(event) => {
                  // Explicit questions transfer focus to the discussion destination; ordinary
                  // Escape/outside dismissal still restores focus to this trigger.
                  if (questionActionChosen.current) event.preventDefault()
                  questionActionChosen.current = false
                }}
              >
                {observationAction ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start"
                      disabled={!active || discussionPending || observationPending}
                      onClick={() => {
                        questionActionChosen.current = true
                        askContent(true)
                      }}
                    >
                      {t('Ask about this run')}
                    </Button>
                  </PopoverClose>
                ) : null}
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    disabled={!active || !scene.step || discussionPending}
                    onClick={() => {
                      questionActionChosen.current = true
                      ask()
                    }}
                  >
                    {t('Ask about this step')}
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    disabled={!active || !branch?.steps.length || discussionPending}
                    onClick={() => {
                      questionActionChosen.current = true
                      askSession()
                    }}
                  >
                    {t('Discuss the entire research')}
                  </Button>
                </PopoverClose>
                {onChooseConversation ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start"
                      disabled={!active || !scene.step || discussionPending}
                      onClick={() => {
                        questionActionChosen.current = true
                        pause()
                        if (scene.step)
                          onChooseConversation(
                            captureDiscussionStep(replayDocument, scene, runDetails, resources)
                          )
                      }}
                    >
                      {t('Add to another conversation…')}
                    </Button>
                  </PopoverClose>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
          {active && observationError === observationActionKey ? (
            <ErrorNotice
              inline
              title={t('Could not prepare this observation reference.')}
              primaryButton={{
                label: t('Try again'),
                onClick: () => void askObservation(),
                disabled: !active || !observationAction,
                loading: observationPending
              }}
            />
          ) : null}
          {footerReference ? <div className="min-w-0 w-full">{footerReference}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Fullscreen keeps existing portal controls in the same top-layer subtree without remounting evidence. */
const ResearchReplayPortal = ({
  enabled,
  children
}: {
  enabled: boolean
  children: React.ReactNode
}): React.JSX.Element => {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!enabled) return
    const update = (): void =>
      setContainer(
        document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : null
      )
    update()
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [enabled])
  return (
    <OverlayPortalContainer.Provider value={enabled ? container : null}>
      {children}
    </OverlayPortalContainer.Provider>
  )
}

// A source replacement is a new player, even when two imports have the same package fingerprint.
export const ReplayPanel = (props: ReplayPanelProps): React.JSX.Element => (
  <ResearchReplayPortal enabled={props.presentationMode === 'research'}>
    <ReplayPanelContent
      key={JSON.stringify([
        props.document.source.projectId,
        props.document.source.sessionId,
        props.recorded?.sourceIdentity ??
          props.live?.sourceIdentity ??
          props.document.source.fingerprint
      ])}
      {...props}
    />
  </ResearchReplayPortal>
)

export type { SessionDiscussionCapture, ReplayViewState }
