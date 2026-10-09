import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReplayDocument, ReplayResource } from '../../shared/replay'
import type {
  ResearchReplayDocument,
  ResearchReplayPosition,
  ResearchReplaySelection
} from '../../shared/research-replay'
import { replayViewStateSchema, type ReplayViewState } from '../../shared/session-replay'
import {
  projectLegacyObservationToTrack,
  projectRecordingToTrack
} from '../../shared/project-recording'
import { recordedMediaResource } from '../src/lib/replay/recorded-results'
import {
  buildRecordedExecutionTracks,
  type RecordedExecutionAskContext
} from '../src/lib/replay/recorded-execution'
import type { RecordedRunObservationSelection } from '../../shared/run-observation-recorded'
import type { ReplayNotebookRunReader } from '../src/lib/replay/notebook-details'
import { ErrorNotice } from '../src/components/error-notice'
import { Info } from 'lucide-react'
import { Button } from '../src/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../src/components/ui/popover'
import { ReplayPanel } from '../src/pages/workspace/replay/ReplayPanel'
import type {
  ReplayMaterialPlayback,
  ReplayMaterialView
} from '../src/pages/workspace/replay/ReplayStage'
import { BrowserRecordingPlayer } from '../src/pages/workspace/replay/BrowserRecordingPlayer'
import { ProjectReplay } from '../src/pages/workspace/replay/ProjectReplay'
import { recordingSourceLabel } from '../src/pages/workspace/replay/recording-source-label'
import { RecordingTimelineFollow } from '../src/pages/workspace/replay/RecordingTimelineFollow'
import { recordingTargetKey } from '../src/pages/workspace/replay/recording-timeline-follow'
import { ResultsPanel } from '../src/pages/workspace/replay/results/ResultsPanel'
import type { SessionDiscussionCapture } from '../src/pages/workspace/replay/replay-context'
import { BrowserArtifactPreview } from './BrowserArtifactPreview'
import { ReferencePanel } from './ReferencePanel'
import { ReplayViewerRequestError, type ResearchReplayViewerContext } from './client'
import { ResearchReplayClient } from './research-client'
import {
  researchPosition,
  researchResourcePosition,
  researchResults,
  type ResearchRecordingMaterial
} from './research-materials'

const storageKey = (viewerId: string, document: ReplayDocument): string =>
  `research-replay:${viewerId}:${document.source.fingerprint}`
const restoreView = (viewerId: string, document: ReplayDocument): ReplayViewState | undefined => {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(viewerId, document)) ?? 'null')
    const parsed = replayViewStateSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
const saveView = (viewerId: string, document: ReplayDocument, view: ReplayViewState): void => {
  try {
    sessionStorage.setItem(storageKey(viewerId, document), JSON.stringify(view))
  } catch {
    /* Optional per-viewer navigation state, never source history. */
  }
}

type MaterialPreferences = {
  materialId: 'conversation' | 'notebook' | 'project' | 'results'
  recordingId?: string
  followingRecording?: boolean
}
const restoreMaterials = (viewerId: string, document: ReplayDocument): MaterialPreferences => {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`${storageKey(viewerId, document)}:materials`) ?? 'null'
    )
    if (saved && ['conversation', 'notebook', 'project', 'results'].includes(saved.materialId))
      return {
        materialId: saved.materialId,
        recordingId: typeof saved.recordingId === 'string' ? saved.recordingId : undefined,
        followingRecording: saved.followingRecording !== false
      }
  } catch {
    /* Optional browser navigation state. */
  }
  return { materialId: 'conversation' }
}

const ResearchReplayContent = ({
  client,
  context,
  research,
  recordings,
  unavailable
}: {
  client: ResearchReplayClient
  context: ResearchReplayViewerContext
  research: ResearchReplayDocument
  recordings: readonly ResearchRecordingMaterial[]
  unavailable: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [connection, setConnection] = useState<'connected' | 'network' | 'authorization'>(
    'connected'
  )
  const [reconnecting, setReconnecting] = useState(false)
  const [readRevision, setReadRevision] = useState(0)
  const connectionRequest = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const unsubscribe = client.onConnectionFailure((error) => {
      setConnection((previous) =>
        previous === 'authorization' || error.kind === 'authorization' ? 'authorization' : 'network'
      )
    })
    return () => {
      unsubscribe()
      connectionRequest.current?.abort()
    }
  }, [client])
  const checkConnection = useCallback(
    async (retryMedia = false): Promise<void> => {
      if (connectionRequest.current) return
      const controller = new AbortController()
      connectionRequest.current = controller
      setReconnecting(retryMedia)
      try {
        const current = await client.context(controller.signal)
        if (
          current.mode !== 'research' ||
          current.viewerId !== context.viewerId ||
          current.target.projectId !== context.target.projectId ||
          current.target.sessionId !== context.target.sessionId
        )
          throw new ReplayViewerRequestError('authorization')
        if (controller.signal.aborted) return
        setConnection((previous) => (previous === 'authorization' ? previous : 'connected'))
        if (retryMedia) setReadRevision((value) => value + 1)
      } catch (error) {
        if (!controller.signal.aborted)
          setConnection((previous) =>
            previous === 'authorization' ||
            (error instanceof ReplayViewerRequestError && error.kind === 'authorization')
              ? 'authorization'
              : 'network'
          )
      } finally {
        if (connectionRequest.current === controller) {
          connectionRequest.current = undefined
          if (!controller.signal.aborted) setReconnecting(false)
        }
      }
    },
    [client, context.viewerId, context.target.projectId, context.target.sessionId]
  )
  // Main computes timing while original publication/branch evidence still exists. Applying the
  // projection again after technical-step removal can lose attribution and trim valid coverage.
  const timed = research.timing
  const document = research.document
  const executionTracks = useMemo(
    () =>
      buildRecordedExecutionTracks(
        document,
        recordings.map((item) => item.payload),
        research.observationBindings ?? [],
        timed.recordedTimeOrigins
      ),
    [document, recordings, research.observationBindings, timed.recordedTimeOrigins]
  )
  const unlinkedStates = useMemo(
    () =>
      recordings
        .filter((item) => 'archive' in item.payload)
        .some(
          (item) =>
            !executionTracks.some((track) => {
              const target = track.select(track.snapshots[0]).receiving
              return (
                target.projectId === item.descriptor.target.projectId &&
                target.sessionId === item.descriptor.target.sessionId &&
                target.artifactId === item.descriptor.target.artifactId &&
                target.versionId === item.descriptor.target.versionId
              )
            })
        ),
    [recordings, executionTracks]
  )
  const [initialView] = useState(() => restoreView(context.viewerId, document))
  const [watchingPosition, setWatchingPosition] = useState(initialView?.timeMs ?? 0)
  const [selection, setSelection] = useState<ResearchReplaySelection>()
  const [selectionFailed, setSelectionFailed] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [preferences] = useState(() => restoreMaterials(context.viewerId, document))
  const [materialId, setMaterialId] = useState<string>(preferences.materialId)
  const [materialRequest] = useState<{ id: string; revision: number }>({
    id: preferences.materialId,
    revision: 0
  })
  const [followingRecording, setFollowingRecording] = useState(
    preferences.followingRecording !== false
  )
  const [recordingId, setRecordingId] = useState(
    () =>
      recordings.find(({ descriptor }) => descriptor.id === preferences.recordingId)?.descriptor
        .id ??
      recordings.find(({ descriptor }) => descriptor.kind === 'web-recording')?.descriptor.id ??
      recordings[0]?.descriptor.id
  )
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `${storageKey(context.viewerId, document)}:materials`,
        JSON.stringify({ materialId, recordingId, followingRecording })
      )
    } catch {
      /* Optional browser navigation state. */
    }
  }, [context.viewerId, document, materialId, recordingId, followingRecording])
  const pending = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    void client.researchSelection(document, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && value) setSelection((current) => current ?? value)
      },
      () => undefined
    )
    return () => {
      controller.abort()
      pending.current += 1
    }
  }, [client, document])
  const select = useCallback(
    async (position: ResearchReplayPosition): Promise<void> => {
      const revision = ++pending.current
      setSelecting(true)
      setSelectionFailed(false)
      try {
        const saved = await client.selectResearch(document, position)
        if (revision === pending.current) setSelection(saved)
      } catch (error) {
        if (revision === pending.current) setSelectionFailed(true)
        throw error
      } finally {
        if (revision === pending.current) setSelecting(false)
      }
    },
    [client, document]
  )
  const readRaw = useCallback(
    async (resource: ReplayResource, signal?: AbortSignal) => {
      const local = document.resources.find(
        (item) => item.id === resource.id && item.versionId === resource.versionId
      )
      if (local) return client.researchArtifact(local, signal)
      const material = recordings.find(({ payload }) =>
        payload.media.some(
          (media) =>
            media.artifactId === resource.artifactId && media.versionId === resource.versionId
        )
      )
      if (!material) throw new ReplayViewerRequestError('unavailable')
      return client.researchMedia(material.descriptor.id, material.payload, resource, signal)
    },
    // Reset failed file previews after a successful scoped connection check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, document, recordings, readRevision]
  )
  const readResource = useCallback(
    (resource: ReplayResource) => client.prepareResearchResource(resource, () => readRaw(resource)),
    [client, readRaw]
  )
  const readNotebookRun: ReplayNotebookRunReader = useCallback(
    (_source, run, options) => client.notebook(run.runId, options?.signal),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, readRevision]
  )
  const results = useMemo(
    () =>
      researchResults(document, recordings, research.supportingResourceIds).map((entry) => {
        const index = recordings.findIndex(
          ({ payload }) =>
            !('indexChecksum' in payload) &&
            ('archive' in payload ? payload.archive.recordingId : payload.recording.recordingId) ===
              entry.source.id
        )
        const owner = recordings[index]
        return {
          ...entry,
          sourceKey: owner ? JSON.stringify(owner.descriptor.target) : 'research-files',
          sourceLabel: owner
            ? recordingSourceLabel(
                {
                  format: owner.descriptor.kind,
                  name: owner.descriptor.name,
                  title: 'archive' in owner.payload ? undefined : owner.payload.recording.title,
                  number: index + 1
                },
                t
              )
            : t('Research source files')
        }
      }),
    [document, recordings, research.supportingResourceIds, t]
  )
  const current = recordings.find(({ descriptor }) => descriptor.id === recordingId)
  const recordingLabel = useCallback(
    (material: ResearchRecordingMaterial, index: number): string =>
      recordingSourceLabel(
        {
          format: material.descriptor.kind,
          name: material.descriptor.name,
          title: 'archive' in material.payload ? undefined : material.payload.recording.title,
          number: index + 1
        },
        t
      ),
    [t]
  )
  const track = useMemo(
    () =>
      current && !('indexChecksum' in current.payload)
        ? 'archive' in current.payload
          ? projectLegacyObservationToTrack(current.payload.archive)
          : projectRecordingToTrack(current.payload.recording)
        : undefined,
    [current]
  )
  const readImage = useCallback(
    async (mediaKey: string, signal: AbortSignal) => {
      if (!current || 'indexChecksum' in current.payload) return null
      const resource = recordedMediaResource(current.payload, mediaKey)
      const prepared = await client.prepareResearchResource(resource, () =>
        client.researchMedia(current.descriptor.id, current.payload, resource, signal)
      )
      return prepared.status === 'ready' && prepared.kind === 'image' ? prepared.content : null
    },
    [client, current]
  )
  const mediaUrl = useCallback(
    (mediaKey: string) =>
      current ? client.researchMediaUrl(current.descriptor.id, current.payload, mediaKey) : null,
    [client, current]
  )
  const askResource = useCallback(
    async (resource: ReplayResource, playback?: ReplayMaterialPlayback, recordedAt?: number) => {
      const fixed = document.resources.find(
        (item) =>
          item.projectId === resource.projectId &&
          item.sessionId === resource.sessionId &&
          item.versionId === resource.versionId &&
          item.artifactId === resource.artifactId &&
          item.fileId === resource.fileId
      )
      const position =
        fixed &&
        researchResourcePosition(
          document,
          timed.recordedTimeOrigins,
          fixed,
          playback,
          recordedAt ?? fixed.createdAt
        )
      if (!position || !fixed) throw new ReplayViewerRequestError('unavailable')
      await select({ ...position, resourceId: fixed.id })
    },
    [document, select, timed.recordedTimeOrigins]
  )
  const materials = useMemo<ReplayMaterialView[]>(
    () => [
      {
        id: 'project',
        label: t('Project replay'),
        content: (active, playback) => {
          const payload = current?.payload
          const web = payload && 'indexChecksum' in payload ? payload : undefined
          const coverage =
            web && playback?.branchId
              ? timed.coverage[playback.branchId]?.find(
                  (item) =>
                    item.recordingId === web.recording.recordingId &&
                    (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
                      (key) => item.target[key] === web.receiving[key]
                    )
                )
              : undefined
          const aligned = Boolean(web && playback?.continuous && coverage)
          const at = playback?.recordedAt
          return (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border-200 px-2 py-1">
                {recordings.length <= 1 ? (
                  <p
                    className="min-w-0 flex-1 truncate text-sm text-text-200"
                    title={current?.descriptor.name}
                  >
                    {current
                      ? recordingLabel(current, recordings.indexOf(current))
                      : t('Project recording')}
                  </p>
                ) : null}
                {recordings.length > 1 ? (
                  <select
                    aria-label={t('Project recording')}
                    className="h-7 min-w-0 flex-1 rounded border border-border-200 bg-bg-000 px-2 text-xs"
                    value={recordingId}
                    onChange={(event) => {
                      setFollowingRecording(false)
                      setRecordingId(event.target.value)
                    }}
                  >
                    {recordings.map((material, index) => (
                      <option key={material.descriptor.id} value={material.descriptor.id}>
                        {recordingLabel(material, index)}
                      </option>
                    ))}
                  </select>
                ) : null}
                {current ? (
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
                      <p>{current.descriptor.name}</p>
                      <p>
                        {t('Version')}
                        {': '}
                        <code>{current.descriptor.target.versionId}</code>
                      </p>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
              <RecordingTimelineFollow
                enabled={recordings.filter((item) => 'indexChecksum' in item.payload).length > 1}
                following={followingRecording}
                onFollowingChange={setFollowingRecording}
                coverage={playback?.branchId ? (timed.coverage[playback.branchId] ?? []) : []}
                recordedAt={playback?.continuous ? at : undefined}
                selected={current?.descriptor.target}
                availableTargets={recordings.map((item) => item.descriptor.target)}
                onSelect={(target) => {
                  const next = recordings.find(
                    (item) =>
                      recordingTargetKey(item.descriptor.target) === recordingTargetKey(target)
                  )
                  if (next) setRecordingId(next.descriptor.id)
                }}
              >
                {!current ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    {t(
                      'No project images were recorded. Other research materials remain available.'
                    )}
                  </p>
                ) : null}
                {web ? (
                  <BrowserRecordingPlayer
                    presentationMode="research"
                    key={current!.descriptor.id}
                    active={active}
                    recording={web.recording}
                    mediaUrl={mediaUrl}
                    retryRevision={readRevision}
                    onPlaybackError={() => void checkConnection()}
                    missingMediaKeys={web.recording.media
                      .filter(
                        (declared) =>
                          !web.media.some((resolved) => resolved.mediaKey === declared.mediaKey)
                      )
                      .map((media) => media.mediaKey)}
                    transport={{
                      offsetMs:
                        aligned && at !== undefined ? at - web.recording.startedAt : undefined,
                      playing: Boolean(playback?.playing && aligned),
                      speed: playback?.speed ?? 1,
                      onPause: playback?.onPause,
                      onSeek: (offsetMs) =>
                        playback?.onSeekRecordedAt(web.recording.startedAt + offsetMs)
                    }}
                    onAskMoment={async (offsetMs) => {
                      const position = researchPosition(
                        document,
                        timed.recordedTimeOrigins,
                        playback,
                        web.recording.startedAt + offsetMs
                      )
                      if (!position) throw new ReplayViewerRequestError('unavailable')
                      await select({ ...position, recordingId: current!.descriptor.id, offsetMs })
                    }}
                  />
                ) : null}
                {track ? (
                  <ProjectReplay
                    presentationMode="research"
                    key={current!.descriptor.id}
                    track={track}
                    active={active}
                    readImage={readImage}
                    missingMediaKeys={
                      current && track
                        ? track.frames
                            .filter(
                              (frame) =>
                                !current.payload.media.some(
                                  (media) => media.mediaKey === frame.mediaKey
                                )
                            )
                            .map((frame) => frame.mediaKey)
                        : undefined
                    }
                    retryRevision={readRevision}
                    onPlaybackError={() => void checkConnection()}
                    transport={{
                      recordedAt: playback?.recordedAt,
                      onPause: playback?.onPause,
                      onSeekRecordedAt: (at) => playback?.onSeekRecordedAt(at)
                    }}
                    onAskFrame={async (frame) => {
                      if (!current || 'indexChecksum' in current.payload) return
                      await askResource(
                        recordedMediaResource(current.payload, frame.mediaKey),
                        playback,
                        frame.recordedAt
                      )
                    }}
                  />
                ) : null}
              </RecordingTimelineFollow>
            </div>
          )
        }
      },
      {
        id: 'results',
        label: t('Results'),
        content: (active, playback) => (
          <ResultsPanel
            active={active}
            presentationMode="research"
            entries={results}
            recordedAt={playback?.recordedAt}
            read={readRaw}
            onAskFile={(entry) => askResource(entry.resource, playback, entry.availableAt)}
          />
        )
      }
    ],
    [
      t,
      current,
      timed,
      recordings,
      recordingId,
      followingRecording,
      mediaUrl,
      document,
      select,
      track,
      readImage,
      askResource,
      results,
      readRaw,
      readRevision,
      checkConnection,
      recordingLabel
    ]
  )
  const askStep = useCallback(
    (capture: SessionDiscussionCapture) => {
      const step = document.branches
        .find((branch) => branch.id === capture.branchId)
        ?.steps.find((step) => step.id === capture.stepId)
      if (!step) return
      const timeMs =
        capture.notebookInspection?.timeMs ??
        capture.stepInspection?.timeMs ??
        step.startMs + capture.stepOffsetMs
      const origin = timed.recordedTimeOrigins[capture.branchId]
      void select({
        branchId: capture.branchId,
        scope: capture.scope,
        notebookRunId: capture.notebookInspection?.runId,
        inspectStep: capture.stepInspection?.mode,
        stepId: capture.stepId,
        timeMs,
        ...(origin === undefined ? {} : { recordedAt: origin + timeMs })
      }).catch(() => undefined)
    },
    [document, timed.recordedTimeOrigins, select]
  )
  const askObservation = useCallback(
    async (
      selection: RecordedRunObservationSelection,
      watching: RecordedExecutionAskContext
    ): Promise<void> => {
      if (connection !== 'connected') throw new ReplayViewerRequestError('authorization')
      const descriptor = recordings.find(
        ({ payload }) =>
          'archive' in payload &&
          payload.archive.recordingId === selection.recordingId &&
          payload.receiving.projectId === selection.receiving.projectId &&
          payload.receiving.sessionId === selection.receiving.sessionId &&
          payload.receiving.artifactId === selection.receiving.artifactId &&
          payload.receiving.versionId === selection.receiving.versionId
      )?.descriptor
      const track = executionTracks.find(
        (track) =>
          track.branchId === watching.branchId &&
          track.stepId === watching.stepId &&
          track.runId === watching.runId &&
          track.snapshots.some((snapshot) => snapshot.stepId === selection.stepKey)
      )
      const origin = timed.recordedTimeOrigins[watching.branchId]
      if (!descriptor || !track || origin === undefined)
        throw new ReplayViewerRequestError('unavailable')
      await select({
        branchId: watching.branchId,
        stepId: watching.stepId,
        timeMs: watching.timeMs,
        recordedAt: origin + watching.timeMs,
        observation: { recordingId: descriptor.id, stepKey: selection.stepKey }
      })
    },
    [connection, recordings, executionTracks, timed.recordedTimeOrigins, select]
  )
  const reference = selection
    ? JSON.stringify(
        {
          kind: 'open-science-research-replay',
          viewerId: context.viewerId,
          selectionId: selection.selectionId,
          source: {
            projectId: selection.source.projectId,
            sessionId: selection.source.sessionId,
            fingerprint: selection.source.fingerprint
          },
          position: selection.position,
          phase: selection.phase,
          inspection: selection.inspection
        },
        null,
        2
      )
    : undefined
  const referenceStep =
    selection &&
    document.branches
      .find((branch) => branch.id === selection.position.branchId)
      ?.steps.find((step) => step.id === selection.step.id)
  const referenceAt = selection?.observation
    ? selection.observation.record.observedAt
    : selection?.resource
      ? selection.resource.createdAt
      : selection?.moment
        ? selection.position.recordedAt
        : selection?.position.notebookRunId
          ? referenceStep?.runs.find((run) => run.runId === selection.position.notebookRunId)
              ?.startedAt
          : referenceStep?.recordedAt
  const referenceOrigin = selection && timed.recordedTimeOrigins[selection.position.branchId]
  const referencePosition =
    referenceAt !== undefined && referenceOrigin !== undefined && referenceAt >= referenceOrigin
      ? referenceAt - referenceOrigin
      : undefined
  return (
    <main
      className="flex h-svh min-h-0 flex-col bg-bg-000 text-text-100"
      data-testid="research-replay-viewer"
    >
      {connection !== 'connected' ? (
        <ErrorNotice
          inline
          tone="amber"
          title={
            connection === 'authorization'
              ? t('This observation link is no longer authorized.')
              : t('Replay connection interrupted')
          }
          description={
            connection === 'authorization'
              ? t(
                  'Open a new viewer from Open Science or your agent. Existing experiments are not restarted.'
                )
              : t('Playback is paused. Reconnect to continue from the same position.')
          }
          primaryButton={
            connection === 'network'
              ? {
                  label: t('Reconnect'),
                  loading: reconnecting,
                  onClick: () => void checkConnection(true)
                }
              : undefined
          }
        />
      ) : null}
      {selectionFailed ? (
        <ErrorNotice inline title={t('Could not reference this research evidence.')} />
      ) : null}
      {unavailable ? (
        <p className="shrink-0 px-3 py-2 text-xs text-status-warning-foreground">
          {t('Some saved recordings are unavailable. Other research records remain available.')}
        </p>
      ) : null}
      {research.recordingsTruncated ? (
        <p className="shrink-0 px-3 py-2 text-xs text-status-warning-foreground">
          {t('Some saved recordings are not listed. The research history remains available.')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <ReplayPanel
          presentationMode="research"
          executionTracks={executionTracks}
          executionNotice={
            unlinkedStates ? (
              <p className="px-3 py-2 text-xs text-text-300">
                {t(
                  'Some saved states could not be linked to a Notebook run. Open their recording separately.'
                )}
              </p>
            ) : undefined
          }
          onAskObservation={askObservation}
          footerReference={
            reference ? (
              <ReferencePanel
                compact
                key={selection!.selectionId}
                reference={reference}
                kind={
                  selection!.observation
                    ? 'observation'
                    : selection!.moment
                      ? 'moment'
                      : selection!.resource
                        ? 'file'
                        : 'step'
                }
                observedAt={
                  selection!.observation?.record.observedAt ?? selection!.position.recordedAt
                }
                referencePositionMs={referencePosition}
                watchingPositionMs={watchingPosition}
                presentation={context.presentation}
              />
            ) : null
          }
          host={null}
          active={connection === 'connected'}
          document={document}
          initialView={initialView}
          recordedTimeOrigins={timed.recordedTimeOrigins}
          recordedCoverage={timed.timelineCoverage}
          materialViews={materials}
          materialViewRequest={materialRequest}
          onMaterialViewChange={setMaterialId}
          readNotebookRun={readNotebookRun}
          readResource={readResource}
          discussionPending={selecting}
          onAskStep={(capture) => {
            if (connection === 'connected') askStep(capture)
          }}
          onViewChange={(view) => {
            setWatchingPosition(view.timeMs)
            saveView(context.viewerId, document, view)
          }}
          renderResource={(resource) => (
            <BrowserArtifactPreview key={resource.id} resource={resource} read={readRaw} />
          )}
        />
      </div>
    </main>
  )
}

export function ResearchReplayViewerApp({
  context,
  client: providedClient
}: {
  context: ResearchReplayViewerContext
  client?: ResearchReplayClient
}): React.JSX.Element {
  const { t } = useTranslation()
  const [client] = useState(() => providedClient ?? new ResearchReplayClient())
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState<{
    research: ResearchReplayDocument
    recordings: ResearchRecordingMaterial[]
    unavailable: boolean
  }>()
  const [error, setError] = useState<'authorization' | 'unavailable'>()
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const research = await client.document(context.target, controller.signal)
      const recordings: ResearchRecordingMaterial[] = []
      let unavailable = research.unavailableRecordingIds.length > 0
      // Bounded concurrent index reads. Media, full Notebook outputs and files stay lazy.
      for (let offset = 0; offset < research.recordings.length; offset += 4) {
        const batch = research.recordings.slice(offset, offset + 4)
        const results = await Promise.allSettled(
          batch.map((descriptor) => client.researchRecording(descriptor, controller.signal))
        )
        results.forEach((result, index) => {
          if (result.status === 'fulfilled')
            recordings.push({ descriptor: batch[index], payload: result.value })
          else if (
            result.reason instanceof ReplayViewerRequestError &&
            result.reason.kind === 'authorization'
          )
            throw result.reason
          else unavailable = true
        })
        controller.signal.throwIfAborted()
      }
      if (!controller.signal.aborted) setLoaded({ research, recordings, unavailable })
    })().catch((reason) => {
      if (!controller.signal.aborted)
        setError(
          reason instanceof ReplayViewerRequestError && reason.kind === 'authorization'
            ? 'authorization'
            : 'unavailable'
        )
    })
    return () => controller.abort()
  }, [client, context.target, retry])
  if (!loaded)
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorNotice
          tone={error ? 'amber' : 'teal'}
          role={error ? 'alert' : 'status'}
          title={
            error === 'authorization'
              ? t('This observation link is no longer authorized.')
              : error
                ? t('Could not read the recorded material.')
                : t('Loading replay…')
          }
          description={
            error === 'authorization'
              ? t(
                  'Open a new viewer from Open Science or your agent. Existing experiments are not restarted.'
                )
              : undefined
          }
          primaryButton={
            error === 'unavailable'
              ? {
                  label: t('Retry'),
                  onClick: () => {
                    setError(undefined)
                    setRetry((value) => value + 1)
                  }
                }
              : undefined
          }
        />
      </main>
    )
  return <ResearchReplayContent client={client} context={context} {...loaded} />
}
