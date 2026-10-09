import { RunObservationPreview } from '../RunObservationPreview'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { recordingSourceLabel } from './recording-source-label'
import { RecordingTimelineFollow } from './RecordingTimelineFollow'
import { recordingTargetKey } from './recording-timeline-follow'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  sameObservationQuestionDestination,
  useRunObservationQuestionStore
} from '@/stores/run-observation-question-store'
import { useObservationQuestionRecovery } from './use-observation-question-recovery'
import type { ReplayDocument, ReplayResource } from '../../../../../shared/replay'
import type { RecordedBrowserPayload } from '../../../../../shared/browser-recording'
import {
  createResearchReplayTimeline,
  type ResearchReplayTimeline
} from '@/lib/replay/recorded-time'
import type {
  RecordedObservationPayload,
  RecordedProjectPayload,
  RecordedRunObservationSelection
} from '../../../../../shared/run-observation-recorded'
import type { ResearchDemoSource, ResearchDemoHistory } from '../../../../../shared/research-demo'
import {
  projectLegacyObservationToTrack,
  projectRecordingToTrack
} from '../../../../../shared/project-recording'
import { recordedResults, recordedMediaResource } from '@/lib/replay/recorded-results'
import {
  fixedReplayResource,
  readRecordedResource,
  type RecordedResourceReader
} from './results/recorded-resource-reader'
import { readReplayResource } from './replay-resources'
import { ResultsPanel, type ReplayResultEntry } from './results/ResultsPanel'
import { ProjectReplay } from './ProjectReplay'
import type { RecordingDiscovery } from './use-recording-discovery'
import type { RecordingCandidate } from './recording-discovery'
import type { ReplayMaterialView } from './ReplayStage'
import { showRecordedObservation } from './open-run-observation'
import { exitResearchReplayFullscreen } from './exit-research-fullscreen'
import { useReplayExecutions } from './use-replay-executions'
import type {
  RecordedExecutionTrack,
  RecordedExecutionAskContext
} from '@/lib/replay/recorded-execution'

type Candidate = RecordingCandidate & { localHistory?: boolean }
export function useRecordedMaterials(
  document: ReplayDocument | undefined,
  discovery: RecordingDiscovery,
  legacySource?: ResearchDemoSource,
  onAskSourceFile?: (resource: ReplayResource) => Promise<void> | void,
  presentationMode?: 'research'
): {
  views: ReplayMaterialView[]
  choose: (candidate: RecordingCandidate) => void
  request?: { id: string; revision: number }
  playbackDocument?: ReplayDocument
  recordedTimeOrigins?: Readonly<Record<string, number>>
  playbackKey?: string
  timingReady: boolean
  timelineCoverage?: ResearchReplayTimeline['timelineCoverage']
  executionTracks?: readonly RecordedExecutionTrack[]
  executionNotice?: ReactNode
  askObservation: (
    selection: RecordedRunObservationSelection,
    context: RecordedExecutionAskContext
  ) => Promise<void>
} {
  const { t } = useTranslation()
  const sourceKey = JSON.stringify([
    document?.source.projectId,
    document?.source.sessionId,
    document?.source.fingerprint,
    legacySource
  ])
  const askRequest = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => askRequest.current?.abort(), [sourceKey])
  const [history, setHistory] = useState<ResearchDemoHistory>()
  const [historyFailed, setHistoryFailed] = useState(false)
  const [selected, setSelected] = useState<Candidate>()
  const [followingRecording, setFollowingRecording] = useState(true)
  const [selectionInitialized, setSelectionInitialized] = useState(false)
  const [request, setRequest] = useState<{ id: string; revision: number }>()
  const [payload, setPayload] = useState<RecordedObservationPayload | RecordedProjectPayload>()
  const [browserPayload, setBrowserPayload] = useState<RecordedBrowserPayload>()
  const [timing, setTiming] = useState<{
    sourceKey: string
    timeline: ResearchReplayTimeline
    recordings: RecordedBrowserPayload[]
    payloads: Map<
      string,
      RecordedObservationPayload | RecordedProjectPayload | RecordedBrowserPayload
    >
  }>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadedSourceKey, setLoadedSourceKey] = useState(sourceKey)
  if (loadedSourceKey !== sourceKey) {
    setLoadedSourceKey(sourceKey)
    setSelected(undefined)
    setFollowingRecording(true)
    setSelectionInitialized(false)
    setPayload(undefined)
    setBrowserPayload(undefined)
    setTiming(undefined)
    setHistory(undefined)
    setHistoryFailed(false)
    setLoadFailed(false)
    setRequest(undefined)
  }
  const recovery = useObservationQuestionRecovery(
    document
      ? { projectId: document.source.projectId, sessionId: document.source.sessionId }
      : undefined
  )
  useEffect(() => {
    let disposed = false
    if (!document || !legacySource || !window.api?.researchDemos?.readHistory) return
    void window.api.researchDemos.readHistory(legacySource).then(
      (result) => {
        if (!disposed) setHistory(result)
      },
      () => {
        if (!disposed) setHistoryFailed(true)
      }
    )
    return () => {
      disposed = true
    }
  }, [legacySource, sourceKey, document])
  const candidates = useMemo<Candidate[]>(
    () => [
      ...discovery.recordings,
      ...(history?.receipts ?? []).flatMap((receipt) =>
        receipt.recordingTarget
          ? [
              {
                target: receipt.recordingTarget,
                localHistory: true,
                resource: {
                  id: receipt.recordingTarget.versionId,
                  name: receipt.title,
                  projectId: receipt.recordingTarget.projectId,
                  sessionId: receipt.recordingTarget.sessionId,
                  artifactId: receipt.recordingTarget.artifactId,
                  versionId: receipt.recordingTarget.versionId,
                  availability: 'recorded' as const
                }
              }
            ]
          : []
      )
    ],
    [discovery.recordings, history]
  )
  const choose = useCallback((candidate: Candidate, reveal = true, follow = false) => {
    setFollowingRecording(follow)
    askRequest.current?.abort()
    setSelectionInitialized(true)
    setSelected(candidate)
    setPayload(undefined)
    setBrowserPayload(undefined)
    setLoadFailed(false)
    if (reveal)
      setRequest((previous) => ({ id: 'project', revision: (previous?.revision ?? 0) + 1 }))
  }, [])
  // Resolve the research catalog before first playback. Individual headers are read in bounded
  // pages; selecting a tab or a later local execution never rebuilds the source research clock.
  const {
    loading: discoveryLoading,
    scanned: discoveryScanned,
    unchecked: discoveryUnchecked,
    recordings: discoveredRecordings,
    supportingResourceIds: discoveredSupportingIds,
    loadMore: discoverMore
  } = discovery
  useEffect(() => {
    if (!document || timing?.sourceKey === sourceKey || discoveryLoading) return
    if (discoveryScanned === false) return
    if (discoveryUnchecked) {
      discoverMore()
      return
    }
    let disposed = false
    const recordings: RecordedBrowserPayload[] = []
    const payloads = new Map<
      string,
      RecordedObservationPayload | RecordedProjectPayload | RecordedBrowserPayload
    >()
    const supporting = new Set(discoveredSupportingIds)
    const candidates = discoveredRecordings
    let index = 0
    const worker = async (): Promise<void> => {
      while (!disposed && index < candidates.length) {
        const candidate = candidates[index++]
        try {
          const value =
            candidate.format === 'web-recording'
              ? await window.api.projectRecordings.read({ target: candidate.target })
              : candidate.format === 'project-recording'
                ? await window.api.observations.readProjectRecording({ target: candidate.target })
                : await window.api.observations.readRecorded({ target: candidate.target })
          if (disposed || !value) continue
          payloads.set(JSON.stringify(candidate.target), value)
          supporting.add(candidate.resource.id)
          if ('indexChecksum' in value) recordings.push(value)
          else {
            const frameKeys =
              'archive' in value
                ? new Set(
                    value.archive.media
                      .filter((media) => media.capture)
                      .map((media) => media.mediaKey)
                  )
                : new Set(value.recording.frames.map((frame) => frame.mediaKey))
            for (const media of value.media) {
              if (!media.versionId || !frameKeys.has(media.mediaKey)) continue
              const resource = document.resources.find(
                (item) =>
                  item.projectId === value.receiving.projectId &&
                  item.sessionId === value.receiving.sessionId &&
                  item.versionId === media.versionId
              )
              if (resource) supporting.add(resource.id)
            }
          }
        } catch {
          // Missing footage does not block the original conversation and Notebook.
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(2, candidates.length) }, worker)).then(() => {
      if (disposed) return
      setTiming({
        sourceKey,
        timeline: createResearchReplayTimeline(document, recordings, [...supporting]),
        recordings,
        payloads
      })
      if (!selectionInitialized) {
        setSelectionInitialized(true)
        const first =
          candidates.find((candidate) => candidate.format === 'web-recording') ?? candidates[0]
        if (first) choose(first, false, true)
      }
    })
    return () => {
      disposed = true
    }
  }, [
    document,
    sourceKey,
    discoveryLoading,
    discoveryScanned,
    discoveryUnchecked,
    discoveredRecordings,
    discoveredSupportingIds,
    discoverMore,
    timing?.sourceKey,
    selectionInitialized,
    choose
  ])
  const prepared = timing?.sourceKey === sourceKey ? timing : undefined
  const timed = prepared?.timeline
  const executionPayloads = useMemo(
    () => (prepared ? [...prepared.payloads.values()] : undefined),
    [prepared]
  )
  const { executionTracks, executionNotice } = useReplayExecutions(
    timed?.document,
    executionPayloads,
    timed?.recordedTimeOrigins
  )
  useEffect(() => {
    if (selected?.format !== 'web-recording') return
    if (!selected.localHistory && !prepared) return
    const saved = prepared?.payloads.get(JSON.stringify(selected.target))
    let disposed = false
    void Promise.resolve()
      .then(() =>
        saved && 'indexChecksum' in saved
          ? saved
          : window.api.projectRecordings.read({ target: selected.target })
      )
      .then(
        (value) => {
          if (!disposed) setBrowserPayload(value)
        },
        () => {
          if (!disposed) setLoadFailed(true)
        }
      )
    return () => {
      disposed = true
    }
  }, [selected, prepared])
  useEffect(() => {
    if (!selected || selected.format === 'web-recording') return
    if (!selected.localHistory && !prepared) return
    const saved = prepared?.payloads.get(JSON.stringify(selected.target))
    let disposed = false
    const load =
      selected.format === 'project-recording'
        ? window.api?.observations?.readProjectRecording
        : window.api?.observations?.readRecorded
    void Promise.resolve()
      .then<RecordedObservationPayload | RecordedProjectPayload>(() => {
        if (saved && !('indexChecksum' in saved)) return saved
        if (!load) throw new Error('Recording reader unavailable')
        return load({ target: selected.target })
      })
      .then(
        (value) => {
          if (!disposed) setPayload(value)
        },
        () => {
          if (!disposed) setLoadFailed(true)
        }
      )
    return () => {
      disposed = true
    }
  }, [selected, prepared])
  const track = useMemo(
    () =>
      payload
        ? 'archive' in payload
          ? projectLegacyObservationToTrack(payload.archive)
          : projectRecordingToTrack(payload.recording)
        : undefined,
    [payload]
  )
  const readImage = useCallback(
    async (key: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      const resource = payload && recordedMediaResource(payload, key)
      if (!resource) return null
      const value = await readReplayResource(resource)
      signal.throwIfAborted()
      return value.status === 'ready' && value.kind === 'image' ? value.content : null
    },
    [payload]
  )
  const recordingLabel = useCallback(
    (candidate: Candidate): string => {
      const key = JSON.stringify(candidate.target)
      const saved = prepared?.payloads.get(key)
      const index = candidates.findIndex((item) => JSON.stringify(item.target) === key)
      return recordingSourceLabel(
        {
          format: candidate.format,
          name: candidate.resource.name,
          title: saved && !('archive' in saved) ? saved.recording.title : undefined,
          number: index < 0 ? candidates.length + 1 : index + 1
        },
        t
      )
    },
    [prepared, candidates, t]
  )
  // The result catalog belongs to the research, not to the currently displayed video. All
  // payloads here have already been resolved by their existing exact-Version storage owners.
  const resultCatalog = useMemo(() => {
    const owners = new Map<ReplayResultEntry, RecordedObservationPayload | RecordedProjectPayload>()
    const attachments: ReplayResultEntry[] = []
    const resourceIdentity = (resource: ReplayResource): string =>
      JSON.stringify([
        resource.source ?? 'artifact',
        resource.projectId,
        resource.sessionId,
        resource.artifactId,
        resource.fileId,
        resource.versionId,
        resource.checksum
      ])
    const sourceResources = new Map(
      (document?.resources ?? []).map((resource) => [resourceIdentity(resource), resource])
    )
    for (const [key, value] of prepared?.payloads ?? []) {
      if ('indexChecksum' in value) continue
      const candidate = discoveredRecordings.find((item) => JSON.stringify(item.target) === key)
      for (const attachment of recordedResults(value)) {
        const resource =
          sourceResources.get(resourceIdentity(attachment.resource)) ?? attachment.resource
        const entry: ReplayResultEntry = {
          ...attachment,
          resource,
          sourceKey: key,
          sourceLabel: candidate ? recordingLabel(candidate) : undefined
        }
        attachments.push(entry)
        owners.set(entry, value)
      }
    }
    const mapped = new Set(attachments.map((entry) => resourceIdentity(entry.resource)))
    const supporting = new Set(timed?.supportingResourceIds)
    const entries: ReplayResultEntry[] = [
      ...attachments,
      ...(document?.resources ?? [])
        .filter((resource) => !mapped.has(resourceIdentity(resource)))
        .map((resource) => ({
          resource,
          source: { kind: 'session-history' as const, id: document!.source.sessionId },
          sourceLabel: t('Research source files'),
          scope: { kind: 'recording' as const },
          stage: 'unspecified' as const,
          technical: supporting.has(resource.id)
        }))
    ]
    return { entries, owners }
  }, [prepared, document, timed, discoveredRecordings, recordingLabel, t])
  const readResults = useCallback<RecordedResourceReader>(
    (requested, signal) => {
      // A UI filter is not authority: only exact resources in the resolved research catalog
      // can reach the existing immutable reader. No latest-Version or mutable path fallback.
      const requestedFixed = fixedReplayResource(requested)
      if (!requestedFixed) return Promise.reject(new Error('The recorded file is unavailable.'))
      const resource = resultCatalog.entries
        .map((entry) => fixedReplayResource(entry.resource))
        .find(
          (resource) =>
            resource &&
            (resource.source ?? 'artifact') === (requestedFixed.source ?? 'artifact') &&
            resource.projectId === requestedFixed.projectId &&
            resource.sessionId === requestedFixed.sessionId &&
            resource.artifactId === requestedFixed.artifactId &&
            resource.fileId === requestedFixed.fileId &&
            resource.versionId === requestedFixed.versionId &&
            resource.checksum === requestedFixed.checksum &&
            resource.locator === requestedFixed.locator
        )
      if (!resource) return Promise.reject(new Error('The recorded file is unavailable.'))
      return readRecordedResource(resource, signal)
    },
    [resultCatalog]
  )
  const askFile = async (mediaKey: string, owner = payload): Promise<void> => {
    if (!owner) return
    askRequest.current?.abort()
    const controller = new AbortController()
    askRequest.current = controller
    const revision = useNavigationStore.getState().explicitNavigationRevision
    const destination = useRunObservationQuestionStore.getState().destination
    const selection = await window.api.observations.selectRecordedFile({
      target: owner.receiving,
      mediaKey,
      format: 'archive' in owner ? 'run-observation' : 'project-recording'
    })
    if (presentationMode === 'research') {
      const exiting = exitResearchReplayFullscreen()
      if (exiting) await exiting
    }
    const currentDestination = useRunObservationQuestionStore.getState().destination
    if (
      controller.signal.aborted ||
      revision !== useNavigationStore.getState().explicitNavigationRevision ||
      ((destination || currentDestination) &&
        !sameObservationQuestionDestination(destination, currentDestination))
    )
      return
    if (!useRunObservationQuestionStore.getState().askRecorded(selection)) {
      if (!recovery) throw new Error('Discussion unavailable')
      await recovery.onClick(selection, controller.signal)
    }
  }
  const askObservation = async (
    requested: RecordedRunObservationSelection,
    context: RecordedExecutionAskContext
  ): Promise<void> => {
    const track = executionTracks?.find(
      (track) =>
        track.branchId === context.branchId &&
        track.runId === context.runId &&
        track.stepId === context.stepId &&
        track.snapshots.some((snapshot) => snapshot.stepId === requested.stepKey)
    )
    const snapshot = track?.snapshots.find((snapshot) => snapshot.stepId === requested.stepKey)
    if (!track || !snapshot || snapshot.observedAt > track.origin + context.timeMs)
      throw new Error('The recorded evidence is unavailable.')
    const captured = track.select(snapshot)
    if (
      (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).some(
        (key) => captured.receiving[key] !== requested.receiving[key]
      ) ||
      captured.recordingId !== requested.recordingId
    )
      throw new Error('The recorded evidence is unavailable.')
    const selection = Object.freeze({
      ...captured,
      selectionId: crypto.randomUUID(),
      selectedAt: Date.now()
    })
    askRequest.current?.abort()
    const controller = new AbortController()
    askRequest.current = controller
    const revision = useNavigationStore.getState().explicitNavigationRevision
    const destination = useRunObservationQuestionStore.getState().destination
    if (presentationMode === 'research') {
      const exiting = exitResearchReplayFullscreen()
      if (exiting) await exiting
    }
    const currentDestination = useRunObservationQuestionStore.getState().destination
    if (
      controller.signal.aborted ||
      revision !== useNavigationStore.getState().explicitNavigationRevision ||
      ((destination || currentDestination) &&
        !sameObservationQuestionDestination(destination, currentDestination))
    )
      return
    if (!useRunObservationQuestionStore.getState().askRecorded(selection)) {
      if (!recovery) throw new Error('Discussion unavailable')
      await recovery.onClick(selection, controller.signal)
    }
  }
  const catalog = (
    <div className="shrink-0 space-y-2 border-b border-border-200 p-2">
      <div className="flex min-w-0 items-center gap-2">
        {presentationMode === 'research' && candidates.length <= 1 ? (
          <p
            className="min-w-0 flex-1 truncate text-sm text-text-200"
            title={selected?.resource.name}
          >
            {selected ? recordingLabel(selected) : t('Project recording')}
          </p>
        ) : (
          <select
            aria-label={t('Project recording')}
            className="h-7 min-w-0 flex-1 rounded border border-border-200 bg-bg-000 px-2 text-xs"
            value={selected ? JSON.stringify(selected.target) : ''}
            onChange={(event) => {
              setFollowingRecording(false)
              const next = candidates.find(
                (candidate) => JSON.stringify(candidate.target) === event.target.value
              )
              if (next) choose(next, false)
              else {
                askRequest.current?.abort()
                setSelectionInitialized(true)
                setSelected(undefined)
                setPayload(undefined)
                setBrowserPayload(undefined)
              }
            }}
          >
            <option value="">{t('Research source files')}</option>
            {selected &&
            !candidates.some(
              (candidate) => JSON.stringify(candidate.target) === JSON.stringify(selected.target)
            ) ? (
              // A later discovery page may replace a checkpoint in the catalog. Keep the user's
              // explicitly opened immutable Version selected without silently switching its footage.
              <option value={JSON.stringify(selected.target)} disabled>
                {recordingLabel(selected)}
              </option>
            ) : null}
            {candidates.map((candidate) => (
              <option
                key={JSON.stringify(candidate.target)}
                value={JSON.stringify(candidate.target)}
              >
                {candidate.localHistory ? `${t('Local historical run')} · ` : ''}
                {recordingLabel(candidate)}
              </option>
            ))}
          </select>
        )}
        {selected ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={t('Recording details')}
              >
                <Info className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="max-w-72 space-y-1 break-all">
              <p>{selected.resource.name}</p>
              <p>
                <span>{t('Version')}</span>
                {': '}
                <code>{selected.target.versionId}</code>
              </p>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {selected?.localHistory ? (
        <p className="text-xs text-muted-foreground">
          {t('Recorded on this device. This is separate from the imported author’s evidence.')}
        </p>
      ) : null}
      {(history?.receipts ?? []).some((receipt) => !receipt.recordingTarget) ? (
        <p className="text-xs text-muted-foreground">
          {t('Some local runs have no saved recording. Viewing history does not resume them.')}
        </p>
      ) : null}
      {historyFailed || discovery.unavailable ? (
        <p className="text-xs text-status-warning-foreground">
          {t('Some source files could not be checked for run recordings.')}
        </p>
      ) : null}
      {discovery.unchecked ? (
        <Button
          size="sm"
          variant="outline"
          onClick={discovery.loadMore}
          disabled={discovery.loading}
        >
          {t('Check more files')}
        </Button>
      ) : null}
    </div>
  )
  const pending =
    selected && selected.format !== 'web-recording' && !payload ? (
      loadFailed ? (
        <ErrorNotice
          inline
          title={t('Could not read the recorded material.')}
          primaryButton={{ label: t('Retry'), onClick: () => choose({ ...selected }) }}
        />
      ) : (
        <p role="status" className="p-3 text-sm">
          {t('Preparing recorded material…')}
        </p>
      )
    ) : null
  return {
    executionTracks,
    executionNotice,
    askObservation,
    playbackDocument: timed?.document,
    recordedTimeOrigins: timed?.recordedTimeOrigins,
    playbackKey: sourceKey,
    timingReady: !!timed,
    timelineCoverage: timed?.timelineCoverage,
    choose,
    request,
    views: [
      {
        id: 'project',
        label: t('Project replay'),
        content: (active, playback) => {
          const browserAligned = Boolean(
            !selected?.localHistory &&
            browserPayload &&
            playback?.continuous &&
            playback.branchId &&
            timed?.coverage[playback.branchId]?.some(
              (item) => JSON.stringify(item.target) === JSON.stringify(browserPayload.receiving)
            )
          )
          return (
            <>
              {catalog}
              <RecordingTimelineFollow
                enabled={presentationMode === 'research' && (prepared?.recordings.length ?? 0) > 1}
                following={followingRecording}
                onFollowingChange={setFollowingRecording}
                coverage={playback?.branchId ? (timed?.coverage[playback.branchId] ?? []) : []}
                recordedAt={playback?.continuous ? playback.recordedAt : undefined}
                selected={selected?.target}
                availableTargets={prepared?.recordings.map((item) => item.receiving) ?? []}
                onSelect={(target) => {
                  const next = discoveredRecordings.find(
                    (item) => recordingTargetKey(item.target) === recordingTargetKey(target)
                  )
                  if (next) choose(next, false, true)
                }}
              >
                {selected &&
                (selected.localHistory ||
                  (payload && 'archive' in payload) ||
                  (selected.format === 'web-recording' && browserPayload && !browserAligned)) ? (
                  <div className="shrink-0 px-3 py-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        showRecordedObservation(
                          selected.target,
                          selected.resource.name,
                          selected.format
                        )
                      }
                    >
                      {t('Open recording separately')}
                    </Button>
                  </div>
                ) : null}
                {selected?.format === 'web-recording' && loadFailed ? (
                  <ErrorNotice
                    inline
                    title={t('Could not read the recorded material.')}
                    primaryButton={{ label: t('Retry'), onClick: () => choose({ ...selected }) }}
                  />
                ) : null}
                {selected?.format === 'web-recording' ? (
                  <RunObservationPreview
                    presentationMode={presentationMode}
                    mode="recorded"
                    format="web-recording"
                    target={selected.target}
                    title={selected.resource.name}
                    isActive={active}
                    questionRecovery={recovery}
                    playback={
                      playback
                        ? {
                            ...playback,
                            recordedAt: browserAligned ? playback.recordedAt : undefined,
                            playing: browserAligned && playback.playing
                          }
                        : undefined
                    }
                    onAskBrowserMoment={(selection) => {
                      if (!useRunObservationQuestionStore.getState().askRecorded(selection))
                        throw new Error('Discussion unavailable')
                    }}
                  />
                ) : (
                  (pending ??
                  (track ? (
                    <ProjectReplay
                      presentationMode={presentationMode}
                      active={active}
                      transport={
                        playback
                          ? {
                              ...playback,
                              recordedAt:
                                !selected?.localHistory &&
                                payload?.receiving.projectId === document?.source.projectId &&
                                payload?.receiving.sessionId === document?.source.sessionId
                                  ? playback.recordedAt
                                  : undefined
                            }
                          : undefined
                      }
                      track={track}
                      missingMediaKeys={
                        payload
                          ? track.media
                              .filter(
                                (media) =>
                                  !payload.media.some(
                                    (resolved) => resolved.mediaKey === media.mediaKey
                                  )
                              )
                              .map((media) => media.mediaKey)
                          : undefined
                      }
                      readImage={readImage}
                      onAskFrame={(frame) => askFile(frame.mediaKey)}
                    />
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">
                      {candidates.length && !selected
                        ? t('Choose saved project evidence. No environment is started.')
                        : t(
                            'No project images were recorded. Other research materials remain available.'
                          )}
                    </p>
                  )))
                )}
              </RecordingTimelineFollow>
            </>
          )
        }
      },
      {
        id: 'results',
        label: t('Results'),
        content: (active, playback) => (
          <>
            <ResultsPanel
              active={active}
              presentationMode={presentationMode}
              entries={resultCatalog.entries}
              recordedAt={playback?.continuous ? playback.recordedAt : undefined}
              read={readResults}
              onAskFile={
                resultCatalog.owners.size || onAskSourceFile
                  ? (entry) => {
                      const owner = resultCatalog.owners.get(entry)
                      return entry.mediaKey && owner
                        ? askFile(entry.mediaKey, owner)
                        : onAskSourceFile?.(entry.resource)
                    }
                  : undefined
              }
            />
          </>
        )
      }
    ]
  }
}
