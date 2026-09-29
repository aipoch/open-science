import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, RotateCcw, GitFork, Maximize2, Minimize2, FolderOpen } from 'lucide-react'
import type {
  ReplayDocument,
  ReplayNotebookRunDetails,
  ReplayResource,
  ReplaySpeed,
  ReplayStep
} from '../../../../../shared/replay'
import type { ReplayViewState } from '../../../../../shared/research-workspace'
import {
  projectReplayScene,
  ReplayNotebookRunCache,
  readReplayNotebookRun,
  REPLAY_MATERIAL_RUN_LIMIT,
  REPLAY_MATERIAL_RESOURCE_LIMIT,
  type ReplayNotebookRunReader
} from '@/lib/replay'
import { createReplayPresentation } from './replay-presentation'
import { ReplayStage, REPLAY_VIEWPORT } from './ReplayStage'
import { ReplayControls } from './ReplayControls'
import { ReplaySourceDetails } from './ReplaySourceDetails'
import {
  captureReplayStepContext,
  subscribeReplaySeek,
  consumeReplaySeek,
  type ReplaySeekTarget,
  type ReplayStepContext
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
  onAskStep: (context: ReplayStepContext) => void
  onContinueResearch?: () => void
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
    positionMs: Math.min(branch?.durationMs ?? 0, exact ? (view?.timeMs ?? 0) : fallback),
    speed: view?.rate ?? 1,
    relocated: Boolean(view && !exact && !step)
  }
}

const buttonClass =
  'rounded-md border border-border-200 px-3 py-1.5 text-xs text-text-100 hover:bg-bg-200 focus-visible:keyboard-focus'

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
  onContinueResearch,
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
  const [branchId, setBranchId] = useState(initial.branchId)
  const [positionMs, setPositionMs] = useState(initial.positionMs)
  const [speed, setSpeed] = useState<ReplaySpeed>(initial.speed)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [materialPage, setMaterialPage] = useState(0)
  const drawerReturnFocus = useRef<HTMLElement | null>(null)
  const drawerClose = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [seekMissing, setSeekMissing] = useState(false)
  const [resources, setResources] = useState<ReplayResourceMap>({})
  const [preparationId, setPreparationId] = useState(0)
  const [degraded, setDegraded] = useState(false)
  const [runDetails, setRunDetails] = useState<Readonly<Record<string, ReplayNotebookRunDetails>>>(
    {}
  )
  const [scale, setScale] = useState(0.5)
  const viewport = useRef<HTMLDivElement>(null)
  const scene = useMemo(
    () => projectReplayScene(replayDocument, branchId, positionMs),
    [replayDocument, branchId, positionMs]
  )
  const branch = replayDocument.branches.find((item) => item.id === scene.branchId)
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
    rate: speed
  }
  useLayoutEffect(() => {
    viewRef.current = viewSnapshot
  })
  const checkpoint = useCallback(() => {
    if (viewRef.current) onViewChangeRef.current?.(structuredClone(viewRef.current))
  }, [])

  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const resize = (): void =>
      setScale(
        Math.max(
          0.1,
          Math.min(
            (node.clientWidth || 640) / REPLAY_VIEWPORT.width,
            (node.clientHeight || 360) / REPLAY_VIEWPORT.height
          )
        )
      )
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    return () => observer.disconnect()
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
  const prepareIds = [
    ...new Set([
      ...(materialStep?.resourceIds.slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT) ?? []),
      ...(branch?.steps[scene.stepIndex + 1]?.resourceIds.slice(
        0,
        REPLAY_MATERIAL_RESOURCE_LIMIT
      ) ?? [])
    ])
  ]
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
    ...(materialStep?.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT) ?? []),
    ...(branch?.steps[scene.stepIndex + 1]?.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT) ?? [])
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

  const pause = useCallback(() => setPlaying(false), [])
  const openDrawer = (mode: 'step' | 'results' | 'materials'): void => {
    pause()
    drawerReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMaterialPage(0)
    setMaterialsOpen(mode === 'materials')
    setResultsOpen(mode === 'results')
    setEvidenceOpen(true)
  }
  const closeDrawer = (): void => {
    setEvidenceOpen(false)
    const target = drawerReturnFocus.current
    if (target?.isConnected) target.focus()
    else panel.current?.focus()
  }
  useLayoutEffect(() => {
    if (evidenceOpen) drawerClose.current?.focus()
  }, [evidenceOpen, materialsOpen, resultsOpen])
  const seek = useCallback((position: number) => {
    setPlaying(false)
    setPositionMs(position)
    setResultsOpen(false)
    setMaterialsOpen(false)
  }, [])
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
      setPositionMs(step.startMs + Math.max(0, Math.min(step.durationMs, offset)))
    }
    const unsubscribe = subscribeReplaySeek(receive)
    const pending = consumeReplaySeek(
      replayDocument.source.projectId,
      replayDocument.source.sessionId
    )
    if (pending) receive(pending)
    return unsubscribe
  }, [replayDocument])

  const ask = (): void => {
    pause()
    if (scene.step)
      onAskStep(captureReplayStepContext(replayDocument, scene, runDetails, resources))
  }
  const openEvidence = (resource?: ReplayResource): void => {
    pause()
    if (scene.step) onOpenEvidence(resource, scene.step)
  }
  const toggle = (): void => {
    if (!branch?.steps.length) return
    if (scene.ended) setPositionMs(0)
    setPlaying((value) => !value)
  }

  const drawerItems = useMemo(() => {
    if (!evidenceOpen) return []
    const sourceSteps = materialsOpen
      ? replayDocument.branches.flatMap((entry) => entry.steps)
      : scene.visibleSteps
    const items: {
      key: string
      step: ReplayStep
      stepNumber: number
      resource?: ReplayResource
    }[] = []
    const seen = new Set<string>()
    if (resultsOpen || materialsOpen)
      for (const step of sourceSteps) {
        const key = `run:${step.branchId}:${step.id}`
        if (!step.runs.length || seen.has(key)) continue
        seen.add(key)
        items.push({
          key,
          step,
          stepNumber:
            (replayDocument.branches
              .find((entry) => entry.id === step.branchId)
              ?.steps.indexOf(step) ?? 0) + 1
        })
      }
    const owners = new Map<string, ReplayStep>()
    for (const entry of replayDocument.branches)
      for (const step of entry.steps)
        for (const id of step.resourceIds) if (!owners.has(id)) owners.set(id, step)
    for (const resource of replayDocument.resources) {
      const included =
        materialsOpen ||
        (resultsOpen
          ? scene.visibleResourceIds.includes(resource.id)
          : scene.visibleEvidence.some(
              (reference) =>
                (reference.kind === 'artifact-version' || reference.kind === 'upload-version') &&
                reference.versionId === resource.versionId
            ))
      const owner = owners.get(resource.id) ?? scene.step
      if (included && owner)
        items.push({ key: `resource:${resource.id}`, step: owner, resource, stepNumber: 0 })
    }
    return items
  }, [evidenceOpen, materialsOpen, resultsOpen, replayDocument, scene])

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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-200 bg-bg-000 px-3 py-2">
        <div className="min-w-32 flex-1">
          <h2 className="truncate text-sm font-medium">{replayDocument.source.title}</h2>
          <p className="text-[11px] text-text-300">{t('Reconstructed from archived records')}</p>
        </div>
        <select
          value={scene.branchId}
          aria-label={t('Replay branch')}
          onChange={(event) => {
            pause()
            setBranchId(event.currentTarget.value)
            setPositionMs(0)
          }}
          className="max-w-36 rounded-md border border-border-200 bg-bg-000 px-2 py-1 text-xs text-text-100"
        >
          {replayDocument.branches.map((item, index) => (
            <option key={item.id} value={item.id}>
              {item.label ??
                (item.kind === 'unattributed'
                  ? t('Related material')
                  : t('Branch {{index}}', { index: index + 1 }))}
            </option>
          ))}
        </select>
        {onToggleExpanded ? (
          <button
            type="button"
            className={buttonClass}
            aria-label={expanded ? t('Exit full screen') : t('Enter full screen')}
            title={expanded ? t('Exit full screen') : t('Enter full screen')}
            onClick={() => {
              pause()
              onToggleExpanded()
            }}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-200 bg-bg-000 px-3 py-2">
        <span className="text-xs text-text-300">
          {t('Recorded steps: {{steps}}; files: {{files}}', {
            steps: branch?.steps.length ?? 0,
            files: replayDocument.resources.length
          })}
        </span>
        <button
          type="button"
          className={`${buttonClass} inline-flex items-center gap-1`}
          onClick={() => openDrawer('materials')}
        >
          <FolderOpen size={14} />
          {t('View research materials')}
        </button>
      </div>
      <ReplaySourceDetails source={replayDocument.source} onInspect={pause} />
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
        ref={viewport}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-1"
      >
        <div
          style={{ width: REPLAY_VIEWPORT.width * scale, height: REPLAY_VIEWPORT.height * scale }}
        >
          <div
            style={{
              width: REPLAY_VIEWPORT.width,
              height: REPLAY_VIEWPORT.height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left'
            }}
          >
            <ReplayStage
              document={replayDocument}
              scene={scene}
              resources={resources}
              presentation={presentation}
              preparationId={preparationId}
              runDetails={runDetails}
              onInspect={pause}
              onReady={(result) => {
                setReady(result.ready)
                setDegraded(result.degraded)
              }}
            />
          </div>
        </div>
      </div>
      {degraded ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-200 bg-bg-000 px-3 py-2 text-xs text-text-300">
          <span>{t('Some source material is incomplete or unavailable.')}</span>
          <button
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
          </button>
        </div>
      ) : null}
      {evidenceOpen && (scene.step || materialsOpen) ? (
        <section
          className="max-h-52 shrink-0 overflow-auto border-t border-border-200 bg-bg-000 p-3"
          aria-label={
            materialsOpen
              ? t('View research materials')
              : resultsOpen
                ? t('View results')
                : t('Step evidence')
          }
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeDrawer()
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium">
              {materialsOpen
                ? t('View research materials')
                : resultsOpen
                  ? t('View results')
                  : t('Step evidence')}
            </h3>
            <button
              type="button"
              ref={drawerClose}
              onClick={closeDrawer}
              aria-label={t('Close evidence')}
              className="rounded p-1 hover:bg-bg-200"
            >
              <X size={14} />
            </button>
          </div>
          {!resultsOpen && !materialsOpen && scene.step ? (
            <div className="space-y-1 text-xs text-text-300">
              <p>
                {t('Recorded time: {{time}}', {
                  time:
                    scene.step.recordedAt === undefined
                      ? t('Time not recorded')
                      : new Date(scene.step.recordedAt).toISOString()
                })}
              </p>
              {scene.step.recordedEndAt !== undefined && scene.step.recordedAt !== undefined ? (
                <p>
                  {t('Recorded duration: {{seconds}} s', {
                    seconds: ((scene.step.recordedEndAt - scene.step.recordedAt) / 1000).toFixed(1)
                  })}
                </p>
              ) : null}
              {scene.step.issues.length ? (
                <p>{t('Some source material is incomplete or unavailable.')}</p>
              ) : null}
              {scene.visibleEvidence.map((evidence) => (
                <div
                  key={`${evidence.kind}:${evidence.id}`}
                  className="break-all font-mono text-[10px]"
                >{`${evidence.kind}: ${evidence.id}`}</div>
              ))}
            </div>
          ) : null}
          {materialsOpen ? (
            <div className="space-y-2 text-xs text-text-300">
              <p>{t('All archived materials; playback stays at the current step.')}</p>
              {replayDocument.issues.some((issue) => issue.code === 'incomplete-history') ? (
                <p>{t('Recorded history is incomplete.')}</p>
              ) : null}
              {replayDocument.issues.some(
                (issue) =>
                  (issue.code === 'notebook-unavailable' ||
                    issue.code === 'artifact-unavailable') &&
                  issue.detail
              ) ? (
                <p>{t('Could not read the recorded material.')}</p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!resultsOpen && !materialsOpen ? (
              <button type="button" className={buttonClass} onClick={() => openEvidence()}>
                {t('Open original evidence')}
              </button>
            ) : null}
            {drawerItems.slice(materialPage * 40, (materialPage + 1) * 40).map((item) => (
              <button
                key={item.key}
                type="button"
                className={buttonClass}
                data-replay-material-item={item.key}
                onClick={() => {
                  pause()
                  onOpenEvidence(item.resource, item.step)
                }}
              >
                <span>
                  {item.resource?.name ??
                    item.step.title ??
                    t('Step {{step}}', { step: item.stepNumber })}
                </span>
                {item.resource?.versionNumber !== undefined ? (
                  <span className="ml-2 text-text-300">
                    {' '}
                    {t('Version {{version}}', { version: item.resource.versionNumber })}
                  </span>
                ) : null}
                {item.resource?.availability === 'unavailable' ? (
                  <span className="ml-2 text-text-300">
                    {' '}
                    {t('This exact file version is unavailable.')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {drawerItems.length > 40 ? (
            <nav
              className="mt-3 flex items-center justify-between gap-2"
              aria-label={t('View research materials')}
            >
              <button
                type="button"
                className={buttonClass}
                disabled={materialPage === 0}
                onClick={() => setMaterialPage((page) => Math.max(0, page - 1))}
              >
                {t('Previous page')}
              </button>
              <span className="text-xs">
                {t('Page {{current}} of {{total}}', {
                  current: materialPage + 1,
                  total: Math.ceil(drawerItems.length / 40)
                })}
              </span>
              <button
                type="button"
                className={buttonClass}
                disabled={(materialPage + 1) * 40 >= drawerItems.length}
                onClick={() => setMaterialPage((page) => page + 1)}
              >
                {t('Next page')}
              </button>
            </nav>
          ) : null}
        </section>
      ) : null}
      {scene.ended || !branch?.steps.length ? (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border-200 bg-bg-000 p-3">
          <span className="w-full text-center text-xs text-text-300">
            {branch?.steps.length ? t('Replay complete') : t('No recorded steps are available.')}
          </span>
          {branch?.steps.length ? (
            <>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  seek(0)
                  setPlaying(true)
                }}
              >
                <RotateCcw size={12} className="mr-1 inline" />
                {t('Watch again')}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  openDrawer('results')
                }}
              >
                {t('View results')}
              </button>
            </>
          ) : null}
          {onContinueResearch ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                pause()
                onContinueResearch()
              }}
            >
              <GitFork size={12} className="mr-1 inline" />
              {t('Create a copy to continue research')}
            </button>
          ) : null}
        </div>
      ) : null}
      <ReplayControls
        playing={playing}
        ready={ready}
        positionMs={scene.positionMs}
        durationMs={scene.durationMs}
        stepIndex={scene.stepIndex}
        stepCount={branch?.steps.length ?? 0}
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
        onEvidence={() => {
          if (evidenceOpen && !resultsOpen && !materialsOpen) closeDrawer()
          else openDrawer('step')
        }}
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

export type { ReplayStepContext, ReplayViewState }
