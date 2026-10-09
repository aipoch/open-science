import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { RecordedMediaViewport } from './RecordedMediaViewport'
import { useReplayMaterialAction } from './replay-material-action'
import type { ProjectReplayTrack } from '../../../../../shared/project-recording'

export type ProjectReplayProps = {
  track: ProjectReplayTrack
  active?: boolean
  readImage: (mediaKey: string, signal: AbortSignal) => Promise<string | null>
  onAskFrame?: (frame: ProjectReplayTrack['frames'][number]) => void | Promise<void>
  presentationMode?: 'standalone' | 'research'
  onPlaybackError?: () => void
  retryRevision?: number
  missingMediaKeys?: readonly string[]
  transport?: {
    recordedAt?: number
    onSeekRecordedAt: (recordedAt: number) => void
    onPause?: () => void
  }
}

/** Passive frames follow their recorded timestamps, optionally driven by the research clock.
 * No environment, URL, executable HTML or live control can enter this component. */
const ProjectReplayContent = ({
  track,
  active = true,
  readImage,
  onAskFrame,
  presentationMode = 'standalone',
  transport,
  onPlaybackError,
  retryRevision = 0,
  missingMediaKeys
}: ProjectReplayProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [localIndex, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [retryAttempt, setRetryAttempt] = useState(0)
  const controlled = transport !== undefined
  const aligned = !controlled || Number.isFinite(transport.recordedAt)
  const recordedAt = transport?.recordedAt ?? Number.NaN
  const index = !controlled
    ? localIndex
    : recordedAt < track.startedAt || recordedAt > track.endedAt
      ? -1
      : track.frames.reduce(
          (selected, frame, frameIndex) => (frame.recordedAt <= recordedAt ? frameIndex : selected),
          -1
        )
  const [loaded, setLoaded] = useState<{
    id: string
    track: ProjectReplayTrack
    reader: ProjectReplayProps['readImage']
    src: string | null
    retryAttempt: number
    retryRevision: number
  }>()
  const [decoded, setDecoded] = useState<{
    loaded: typeof loaded
    failed: boolean
    width: number
    height: number
  }>()
  const [asking, setAsking] = useState(false)
  const [askFailed, setAskFailed] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const frame = track.frames[index]
  const missing = Boolean(
    frame &&
    (track.coverage.missingMediaKeys.includes(frame.mediaKey) ||
      missingMediaKeys?.includes(frame.mediaKey))
  )
  useEffect(() => {
    const next = track.frames[index + 1]
    if (controlled || !playing || !active || !frame || !next) return
    const timer = setTimeout(
      () => {
        setIndex(index + 1)
        if (index + 1 === track.frames.length - 1) setPlaying(false)
      },
      Math.min(2_147_483_647, Math.max(1, next.recordedAt - frame.recordedAt))
    )
    return () => clearTimeout(timer)
  }, [active, controlled, playing, frame, index, track])
  useEffect(() => {
    if (!active || !frame || missing) return
    const abort = new AbortController()
    void readImage(frame.mediaKey, abort.signal).then(
      (src) => {
        if (!abort.signal.aborted)
          setLoaded({
            id: frame.frameId,
            track,
            reader: readImage,
            src,
            retryAttempt,
            retryRevision
          })
      },
      () => {
        if (!abort.signal.aborted)
          setLoaded({
            id: frame.frameId,
            track,
            reader: readImage,
            src: null,
            retryAttempt,
            retryRevision
          })
      }
    )
    return () => abort.abort()
  }, [active, frame, readImage, track, missing, retryAttempt, retryRevision])
  const ready = Boolean(
    active &&
    frame &&
    loaded?.id === frame.frameId &&
    loaded.track === track &&
    loaded.reader === readImage &&
    loaded.retryAttempt === retryAttempt &&
    loaded.retryRevision === retryRevision
  )
  const decodedCurrent = ready && decoded?.loaded === loaded
  const canAsk = Boolean(
    frame && ready && loaded?.src && decodedCurrent && !decoded?.failed && !missing
  )
  const failed = Boolean(ready && (!loaded?.src || (decodedCurrent && decoded?.failed)))
  if (playing && (failed || missing)) setPlaying(false)
  const reportFailure = useEffectEvent(() => {
    if (transport?.onPause) transport.onPause()
    else if (transport && aligned) transport.onSeekRecordedAt(recordedAt)
    if (!missing) onPlaybackError?.()
  })
  useEffect(() => {
    if (active && frame && (missing || failed)) reportFailure()
  }, [active, frame, missing, failed])
  const ask = (): void => {
    if (!canAsk || !frame || !onAskFrame || asking) return
    transport?.onSeekRecordedAt(frame.recordedAt)
    setPlaying(false)
    setAsking(true)
    setAskFailed(false)
    void Promise.resolve()
      .then(() => onAskFrame(frame))
      .catch(() => {
        if (mounted.current) setAskFailed(true)
      })
      .finally(() => {
        if (mounted.current) setAsking(false)
      })
  }
  const sharedAction = useReplayMaterialAction(
    active && onAskFrame
      ? {
          label: t('Ask about this frame'),
          disabled: !canAsk || asking,
          pending: asking,
          recordedAt: canAsk ? frame?.recordedAt : undefined,
          title: track.title ?? t('Project recording'),
          onAsk: ask
        }
      : undefined
  )
  const compact = presentationMode === 'research' || sharedAction
  const gap = Boolean(
    track.coverage.failures ||
    track.coverage.droppedSamples ||
    track.coverage.missingMediaKeys.length ||
    !['finished', 'stopped'].includes(track.coverage.stopReason)
  )
  const dimensions =
    decodedCurrent && decoded?.width && decoded?.height
      ? decoded
      : frame?.provenance.kind === 'capture'
        ? frame.provenance
        : undefined
  const status = !frame ? (
    <p role="status" className="max-w-prose text-center">
      {!aligned
        ? t('This recording cannot be aligned with the research replay timeline.')
        : controlled && track.frames.length
          ? compact && recordedAt < track.frames[0].recordedAt
            ? t('The project recording has not started yet.')
            : compact && recordedAt > track.endedAt
              ? t('The project recording has ended.')
              : t('No project image was recorded at this time.')
          : t('No project images were recorded. Other research materials remain available.')}
    </p>
  ) : missing ? (
    <ErrorNotice inline title={t('This recorded media file is not included.')} />
  ) : !ready || (loaded?.src && !decodedCurrent) ? (
    <p role="status">{t('Preparing recorded material…')}</p>
  ) : !loaded?.src || decoded?.failed ? (
    <ErrorNotice
      inline
      title={t('Could not read the recorded material.')}
      primaryButton={{
        label: t('Retry'),
        onClick: () => setRetryAttempt((attempt) => attempt + 1)
      }}
    />
  ) : null
  return (
    <section
      aria-label={t('Project replay')}
      className={
        compact
          ? 'flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-3'
          : 'flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3'
      }
      data-testid="project-replay"
    >
      {!compact ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'Saved project frames use their own recording times. Viewing them does not run the project.'
          )}
        </p>
      ) : null}
      {gap && !compact ? (
        <p role="status" className="text-xs text-status-warning-foreground">
          {t('This project recording is incomplete. Missing activity is not reconstructed.')}
        </p>
      ) : null}
      {frame && !controlled ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={track.frames.length < 2}
              onClick={() => {
                if (index === track.frames.length - 1) setIndex(0)
                setPlaying(!playing)
              }}
            >
              {playing ? t('Pause replay') : t('Play replay')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={index === 0}
              onClick={() => {
                setPlaying(false)
                setIndex(index - 1)
              }}
            >
              {t('Previous image')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={index >= track.frames.length - 1}
              onClick={() => {
                setPlaying(false)
                setIndex(index + 1)
              }}
            >
              {t('Next image')}
            </Button>
          </div>
          <input
            type="range"
            className="w-full"
            min={0}
            max={Math.max(0, track.frames.length - 1)}
            value={index}
            step={1}
            aria-label={t('Recorded project frame')}
            onChange={(event) => {
              setPlaying(false)
              setIndex(Number(event.target.value))
            }}
          />
        </>
      ) : null}
      <div
        className={compact ? 'flex min-h-0 flex-1' : 'flex h-[min(65vh,480px)] min-h-48 shrink-0'}
      >
        <RecordedMediaViewport
          compact={compact}
          width={dimensions?.width}
          height={dimensions?.height}
          status={status}
          metadata={
            compact && dimensions
              ? `${dimensions.width} × ${dimensions.height}`
              : frame
                ? t('Recorded project image {{current}} of {{total}}', {
                    current: index + 1,
                    total: track.frames.length
                  })
                : undefined
          }
          surfaceTestId="recorded-image-surface"
        >
          {ready && loaded?.src ? (
            <img
              key={loaded.src}
              src={loaded.src}
              alt={t('Recorded project image')}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ visibility: decodedCurrent && decoded?.failed ? 'hidden' : 'visible' }}
              onLoad={(event) =>
                setDecoded({
                  loaded,
                  failed: false,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                })
              }
              onError={() => setDecoded({ loaded, failed: true, width: 0, height: 0 })}
            />
          ) : null}
        </RecordedMediaViewport>
      </div>
      {onAskFrame && frame && !sharedAction ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={!canAsk || asking}
          onClick={ask}
        >
          {t('Ask about this frame')}
        </Button>
      ) : null}
      {askFailed ? (
        <ErrorNotice inline title={t('Could not reference this recorded step.')} />
      ) : null}
      {frame || track.states.length || track.events.length || (compact && gap) ? (
        <details className="shrink-0 text-xs">
          <summary>{t('Recorded states and events')}</summary>
          <div className="mt-2 max-h-32 space-y-2 overflow-auto">
            {compact && gap ? (
              <p className="text-status-warning-foreground">
                {t('This project recording is incomplete. Missing activity is not reconstructed.')}
              </p>
            ) : null}
            {frame ? (
              <>
                <p className="text-muted-foreground">{new Date(frame.recordedAt).toISOString()}</p>
                <p className="text-muted-foreground">
                  {frame.provenance.kind === 'capture'
                    ? t('Captured project image')
                    : t('Derived visualization from saved data')}
                </p>
                {frame.provenance.kind === 'derived' ? (
                  <p className="break-words">{frame.provenance.method}</p>
                ) : null}
              </>
            ) : null}
            {track.states.length || track.events.length ? (
              <>
                <p className="text-muted-foreground">
                  {t(
                    'Author-declared data is shown as recorded; it is not an original screenshot.'
                  )}
                </p>
                <pre className="whitespace-pre-wrap">
                  {JSON.stringify({ states: track.states, events: track.events }, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  )
}
export const ProjectReplay = (props: ProjectReplayProps): React.JSX.Element => (
  <ProjectReplayContent key={props.track.recordingId} {...props} />
)
