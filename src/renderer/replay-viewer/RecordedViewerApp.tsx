import type { RecordedBrowserPayload, BrowserRecordingMoment } from '../../shared/browser-recording'
import { BrowserRecordingPlayer } from '../src/pages/workspace/replay/BrowserRecordingPlayer'
import { useBrowserRecordingTransportReceiver } from '../src/pages/workspace/replay/use-browser-recording-transport'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReplayResource } from '../../shared/replay'
import type {
  RecordedObservationPayload,
  ResolvedObservationMedia,
  RecordedRunObservationSelection,
  RecordedObservationFileSelection,
  RecordedProjectPayload
} from '../../shared/run-observation-recorded'
import { RecordedRunObservationPreview } from '../src/pages/workspace/RecordedRunObservationPreview'
import { useMemo } from 'react'
import { ProjectReplay } from '../src/pages/workspace/replay/ProjectReplay'
import { ResultsPanel } from '../src/pages/workspace/replay/results/ResultsPanel'
import { Button } from '../src/components/ui/button'
import { projectRecordingToTrack } from '../../shared/project-recording'
import { recordedResults, recordedMediaResource } from '../src/lib/replay/recorded-results'
import { BrowserArtifactPreview } from './BrowserArtifactPreview'
import { ReferencePanel } from './ReferencePanel'
import { recordedSelectionReference } from './selection-reference'
import { ReplayViewerClient, type RecordedReplayViewerContext } from './client'

const NO_MEDIA: readonly ResolvedObservationMedia[] = []

const RecordedObservationViewerApp = ({
  client,
  context,
  payload
}: {
  client: ReplayViewerClient
  context: RecordedReplayViewerContext
  payload: RecordedObservationPayload
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<
    RecordedRunObservationSelection | RecordedObservationFileSelection
  >()
  useEffect(() => {
    const controller = new AbortController()
    void Promise.allSettled([
      client.recordedSelection(payload, controller.signal),
      client.recordedFileSelection(payload, controller.signal)
    ]).then((results) => {
      if (controller.signal.aborted) return
      const saved = results
        .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
        .sort((a, b) => (b.selectedAt ?? 0) - (a.selectedAt ?? 0))[0]
      if (saved) setSelection((current) => current ?? saved)
    })
    return () => controller.abort()
  }, [client, payload])
  const read = useCallback(
    (resource: ReplayResource, signal?: AbortSignal) =>
      client.recordedMedia(payload, resource, signal),
    [client, payload]
  )
  const readResource = useCallback(
    (resource: ReplayResource) =>
      context.canReadArtifacts
        ? client.readRecordedResource(payload, resource)
        : Promise.resolve({ status: 'unavailable' as const, reason: 'not-recorded' as const }),
    [client, payload, context.canReadArtifacts]
  )
  const ask = async (requested: RecordedRunObservationSelection): Promise<void> => {
    const selected = await client.selectRecording(payload, requested.stepKey)
    setSelection(selected)
  }
  const reference = selection ? recordedSelectionReference(context.viewerId, selection) : undefined
  return (
    <main className="flex h-svh min-h-0 flex-col bg-bg-000 text-text-100">
      {reference ? (
        <ReferencePanel
          presentation={context.presentation}
          kind={selection?.kind === 'recorded-observation-file' ? 'file' : 'step'}
          key={reference}
          reference={reference}
          observedAt={
            selection?.kind === 'recorded-run-observation'
              ? selection.record.observedAt
              : selection?.selectedAt
          }
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <RecordedRunObservationPreview
          archive={payload.archive}
          executionContext={payload.executionContext}
          receiving={payload.receiving}
          media={context.canReadArtifacts ? payload.media : NO_MEDIA}
          title={t('Archived observation')}
          readResource={readResource}
          readRawResource={read}
          onAskArchiveFile={async (requested) => {
            setSelection(await client.selectRecordingFile(payload, requested.mediaKey))
          }}
          renderResource={(resource) => (
            <BrowserArtifactPreview key={resource.versionId} resource={resource} read={read} />
          )}
          onAskArchiveSelection={ask}
        />
      </div>
    </main>
  )
}

const RecordedProjectViewerApp = ({
  client,
  context,
  payload
}: {
  client: ReplayViewerClient
  context: RecordedReplayViewerContext
  payload: RecordedProjectPayload
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [view, setView] = useState<'project' | 'results'>('project')
  const [selection, setSelection] = useState<RecordedObservationFileSelection>()
  const track = useMemo(() => projectRecordingToTrack(payload.recording), [payload.recording])
  const results = useMemo(() => recordedResults(payload), [payload])
  const read = useCallback(
    (resource: ReplayResource, signal?: AbortSignal) =>
      client.recordedMedia(payload, resource, signal),
    [client, payload]
  )
  const readImage = useCallback(
    async (mediaKey: string, signal: AbortSignal) => {
      const resource = recordedMediaResource(payload, mediaKey)
      if (!resource || !context.canReadArtifacts) return null
      signal.throwIfAborted()
      const prepared = await client.readRecordedResource(payload, resource)
      signal.throwIfAborted()
      return prepared.status === 'ready' && prepared.kind === 'image' ? prepared.content : null
    },
    [client, payload, context.canReadArtifacts]
  )
  const askFile = async (mediaKey: string): Promise<void> => {
    setSelection(await client.selectRecordingFile(payload, mediaKey))
  }
  useEffect(() => {
    const controller = new AbortController()
    void client.recordedFileSelection(payload, controller.signal).then(
      (saved) => {
        if (!controller.signal.aborted && saved) setSelection((current) => current ?? saved)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [client, payload])
  const reference = selection ? recordedSelectionReference(context.viewerId, selection) : undefined
  return (
    <main className="flex h-svh min-h-0 flex-col bg-bg-000 text-text-100">
      <header className="shrink-0 border-b border-border-200 p-3">
        <h1 className="text-sm font-medium">{payload.recording.title ?? t('Project recording')}</h1>
        <p className="mt-1 text-xs text-text-300">{t('Read-only research history')}</p>
      </header>
      {reference ? (
        <ReferencePanel
          key={reference}
          reference={reference}
          presentation={context.presentation}
          kind="file"
          observedAt={selection?.selectedAt}
        />
      ) : null}
      <div
        role="group"
        aria-label={t('Research materials')}
        className="flex shrink-0 gap-2 border-b border-border-200 p-2"
      >
        <Button
          size="sm"
          variant={view === 'project' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'project'}
          onClick={() => setView('project')}
        >
          {t('Project replay')}
        </Button>
        <Button
          size="sm"
          variant={view === 'results' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'results'}
          onClick={() => setView('results')}
        >
          {t('Results')}
        </Button>
      </div>
      <div
        className={view === 'project' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        hidden={view !== 'project'}
      >
        <ProjectReplay
          track={track}
          missingMediaKeys={track.media
            .filter(
              (media) => !payload.media.some((resolved) => resolved.mediaKey === media.mediaKey)
            )
            .map((media) => media.mediaKey)}
          active={view === 'project'}
          readImage={readImage}
          onAskFrame={(frame) => askFile(frame.mediaKey)}
        />
      </div>
      <div className={view === 'results' ? 'min-h-0 flex-1' : 'hidden'} hidden={view !== 'results'}>
        <ResultsPanel
          entries={context.canReadArtifacts ? results : []}
          read={read}
          onAskFile={(entry) => askFile(entry.mediaKey!)}
        />
      </div>
    </main>
  )
}
const RecordedBrowserViewerApp = ({
  client,
  context,
  payload
}: {
  client: ReplayViewerClient
  context: RecordedReplayViewerContext
  payload: RecordedBrowserPayload
}): React.JSX.Element => {
  const { t } = useTranslation()
  // Opt-in affects presentation only. A standalone desktop preview still owns its controls.
  const embedded =
    context.presentation === 'desktop' &&
    window.parent !== window &&
    window.name === 'open-science-research-clock'
  const transport = useBrowserRecordingTransportReceiver({ enabled: embedded })
  const researchPresentation = embedded && transport.playback?.presentation === 'research'
  const [selection, setSelection] = useState<BrowserRecordingMoment>()
  useEffect(() => {
    const controller = new AbortController()
    void client.browserMoment(payload, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && value) setSelection(value)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [client, payload])
  const mediaUrl = useCallback(
    (mediaKey: string) =>
      context.canReadArtifacts ? client.browserRecordingMediaUrl(payload, mediaKey) : null,
    [client, payload, context.canReadArtifacts]
  )
  return (
    <main className="flex h-svh min-h-0 flex-col bg-bg-000 text-text-100">
      {!researchPresentation ? (
        <header className="shrink-0 border-b border-border-200 p-3">
          <h1 className="text-sm font-medium">
            {payload.recording.title ?? t('Project recording')}
          </h1>
          <p className="mt-1 text-xs text-text-300">{t('Read-only research history')}</p>
        </header>
      ) : null}
      {selection && !researchPresentation ? (
        <ReferencePanel
          key={selection.selectionId}
          presentation={context.presentation}
          kind="moment"
          observedAt={payload.recording.startedAt + selection.offsetMs}
          reference={JSON.stringify({ viewerId: context.viewerId, ...selection }, null, 2)}
        />
      ) : null}
      <BrowserRecordingPlayer
        presentationMode={researchPresentation ? 'research' : undefined}
        onActionChange={researchPresentation ? transport.onActionChange : undefined}
        transport={
          embedded
            ? {
                offsetMs:
                  transport.playback?.recordedAt === undefined
                    ? undefined
                    : transport.playback.recordedAt - payload.recording.startedAt,
                playing: transport.playback?.playing ?? false,
                speed: transport.playback?.speed ?? 1,
                onSeek: (offsetMs) =>
                  transport.onSeekRecordedAt(payload.recording.startedAt + offsetMs)
              }
            : undefined
        }
        recording={payload.recording}
        missingMediaKeys={payload.recording.media
          .filter(
            (media) => !payload.media.some((resolved) => resolved.mediaKey === media.mediaKey)
          )
          .map((media) => media.mediaKey)}
        mediaUrl={mediaUrl}
        onAskMoment={async (offsetMs) => {
          setSelection(await client.selectBrowserMoment(payload, offsetMs))
        }}
      />
    </main>
  )
}
export const RecordedViewerApp = (props: {
  client: ReplayViewerClient
  context: RecordedReplayViewerContext
  payload: RecordedObservationPayload | RecordedProjectPayload | RecordedBrowserPayload
}): React.JSX.Element => {
  const key = JSON.stringify(props.payload.receiving)
  return 'indexChecksum' in props.payload ? (
    <RecordedBrowserViewerApp key={key} {...props} payload={props.payload} />
  ) : 'archive' in props.payload ? (
    <RecordedObservationViewerApp key={key} {...props} payload={props.payload} />
  ) : (
    <RecordedProjectViewerApp key={key} {...props} payload={props.payload} />
  )
}
