import type { BrowserRecordingMoment } from '../../../../shared/browser-recording'
import { Button } from '@/components/ui/button'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import {
  useRunObservationQuestionStore,
  type ObservationQuestionSelection
} from '@/stores/run-observation-question-store'
import type { ObservationQuestionRecovery } from './replay/use-observation-question-recovery'
import { useObservationRecordingStatus } from './replay/use-observation-recording-status'
import { useReplayMaterialAction } from './replay/replay-material-action'
import { exitResearchReplayFullscreen } from './replay/exit-research-fullscreen'
import { ObservationRecordingStatus } from './replay/ObservationRecordingStatus'
import { showRecordedObservation } from './replay/open-run-observation'
import {
  useBrowserRecordingTransportHost,
  type EmbeddedBrowserRecordingPlayback
} from './replay/use-browser-recording-transport'
import type {
  RunObservationSelection,
  RunObservationTarget
} from '../../../../shared/run-observation'
import type {
  RunObservationViewerAccess,
  RecordedObservationViewerAccess
} from '../../../../shared/run-observation-viewer'
import type {
  RecordedObservationTarget,
  RecordedRunObservationSelection,
  RecordedObservationFileSelection
} from '../../../../shared/run-observation-recorded'
type ViewerAccess = RunObservationViewerAccess | RecordedObservationViewerAccess

export type RunObservationPreviewProps = {
  title: string
  isActive: boolean
  questionRecovery?: ObservationQuestionRecovery
  playback?: EmbeddedBrowserRecordingPlayback
  presentationMode?: 'research'
} & (
  | {
      mode?: 'live'
      format?: never
      target: RunObservationTarget
      allowInteraction?: boolean
      allowCancel?: boolean
      allowCapture?: boolean
      onAskSelection?: (
        selection: RunObservationSelection,
        viewerId: string
      ) => void | Promise<void>
      onAskArchiveSelection?: never
      onAskBrowserMoment?: never
      onAskArchiveFile?: never
    }
  | {
      onAskBrowserMoment?: (
        selection: BrowserRecordingMoment,
        viewerId: string
      ) => void | Promise<void>
      onAskArchiveFile?: (
        selection: RecordedObservationFileSelection,
        viewerId: string
      ) => void | Promise<void>
      mode: 'recorded'
      format?: 'run-observation' | 'project-recording' | 'web-recording'
      target: RecordedObservationTarget
      allowInteraction?: never
      allowCancel?: never
      allowCapture?: never
      onAskSelection?: never
      onAskArchiveSelection?: (
        selection: RecordedRunObservationSelection,
        viewerId: string
      ) => void | Promise<void>
    }
)

const targetKey = (target: RunObservationTarget | RecordedObservationTarget): string =>
  JSON.stringify(
    'artifactId' in target
      ? ['recorded', target.projectId, target.sessionId, target.artifactId, target.versionId]
      : [
          'live',
          target.projectId,
          target.sessionId,
          target.operationId,
          target.executionInvocationId,
          target.runId
        ]
  )
const validAccess = (
  access: ViewerAccess,
  target: RunObservationTarget | RecordedObservationTarget
): boolean => {
  if (targetKey(access.target) !== targetKey(target)) return false
  try {
    const url = new URL(access.url)
    return (
      url.protocol === 'http:' &&
      url.hostname === `viewer-${access.viewerId}.localhost` &&
      Boolean(url.port) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === '/__open_science_viewer' &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get('grant') ?? '') &&
      [...url.searchParams.keys()].length === 1
    )
  } catch {
    return false
  }
}
const matchesSelection = (
  selection: RunObservationSelection,
  target: RunObservationTarget
): boolean => {
  const identity = selection.identity
  return (
    identity.projectId === target.projectId &&
    identity.sessionId === target.sessionId &&
    (['operationId', 'executionInvocationId', 'runId'] as const).every(
      (key) => !target[key] || target[key] === identity[key]
    ) &&
    selection.cursor.epoch === selection.snapshot.cursor.epoch &&
    selection.cursor.sequence === selection.snapshot.cursor.sequence &&
    selection.stepId === selection.snapshot.stepId &&
    targetKey(identity) === targetKey(selection.snapshot.identity)
  )
}

/** Electron owns viewer lifetime and selection delivery. Recorded web embeds additionally receive
 * a presentation-only clock over an exact-origin channel; no execution capabilities cross it. */
const RunObservationPreviewContent = (props: RunObservationPreviewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [admission] = useState(() =>
    props.mode === 'recorded'
      ? { mode: 'recorded' as const, target: props.target, format: props.format }
      : {
          mode: 'live' as const,
          target: props.target,
          allowInteraction: props.allowInteraction,
          allowCancel: props.allowCancel,
          allowCapture: props.allowCapture,
          allowRecording: props.allowInteraction
        }
  )
  const [access, setAccess] = useState<ViewerAccess>()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const recordingTransport = useBrowserRecordingTransportHost({
    iframeRef,
    origin: access ? new URL(access.url).origin : undefined,
    enabled: props.mode === 'recorded' && props.format === 'web-recording' && !!props.playback,
    playback: props.playback
      ? {
          ...props.playback,
          presentation: props.presentationMode,
          playing: props.playback.playing && props.isActive
        }
      : undefined
  })
  useReplayMaterialAction(
    props.presentationMode === 'research' &&
      props.mode === 'recorded' &&
      props.format === 'web-recording' &&
      props.isActive
      ? {
          label: t('Ask about this moment'),
          disabled: !recordingTransport.action || recordingTransport.action.disabled,
          pending: recordingTransport.action?.pending,
          recordedAt: recordingTransport.action?.recordedAt,
          title: recordingTransport.action?.title,
          onAsk: recordingTransport.ask
        }
      : undefined
  )
  const [openFailed, setOpenFailed] = useState(false)
  const [savedBrowserTarget, setSavedBrowserTarget] = useState<RecordedObservationTarget>()
  const [publishedBrowserTargetKey, setPublishedBrowserTargetKey] = useState<string>()
  const publishedBrowserTargets = useRef(new Set<string>())
  const pendingBrowserReads = useRef(new Map<string, Promise<boolean>>())
  const [selectionFailed, setSelectionFailed] = useState<'read' | 'ask'>()
  const [retry, setRetry] = useState(0)
  const liveTarget = admission.mode === 'live' ? admission.target : undefined
  const readRecordingStatus = useCallback(
    () => window.api.observations.recordingStatus({ target: liveTarget! }),
    [liveTarget]
  )
  const { status: recordingStatus } = useObservationRecordingStatus({
    target: liveTarget,
    read: readRecordingStatus,
    active: Boolean(
      liveTarget &&
      access &&
      props.isActive &&
      typeof window.api?.observations?.recordingStatus === 'function'
    ),
    // The outer host does not own the iframe's live snapshot. Keep checking until the
    // exact archive receipt settles or the preview becomes inactive.
    running: true
  })
  useEffect(() => {
    if (
      !access ||
      admission.mode === 'recorded' ||
      !props.isActive ||
      !window.api?.projectRecordings?.status
    )
      return
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const value = await window.api.projectRecordings.status({ viewerId: access.viewerId })
        // Keep the previous saved recording available during the next capture. Removing
        // its action row would change the project's capture rectangle mid-recording.
        if (!disposed && value.target && ['finalized', 'partial', 'failed'].includes(value.state)) {
          const target = value.target
          const key = targetKey(target)
          setSavedBrowserTarget(target)
          // A finalized encoder may still belong to a running execution whose artifacts are
          // unpublished. The existing exact reader is authoritative; never relax its boundary.
          if (!publishedBrowserTargets.current.has(key)) {
            let checking = pendingBrowserReads.current.get(key)
            if (!checking) {
              checking = Promise.resolve()
                .then(() => window.api.projectRecordings.read({ target }))
                .then(
                  (payload) => {
                    if (targetKey(payload.receiving) !== key) return false
                    publishedBrowserTargets.current.add(key)
                    return true
                  },
                  () => false
                )
                .finally(() => pendingBrowserReads.current.delete(key))
              pendingBrowserReads.current.set(key, checking)
            }
            await checking
          }
          if (!disposed && publishedBrowserTargets.current.has(key))
            setPublishedBrowserTargetKey(key)
        }
      } catch {
        /* Recording controls own errors. */
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [access, admission, props.isActive])
  const delivered = useRef(new Set<string>())
  const [requestedSelectionId, setRequestedSelectionId] = useState<string>()
  const [recovering, setRecovering] = useState(false)
  const failedSelection = useRef<ObservationQuestionSelection | undefined>(undefined)
  const recoveryRequest = useRef<AbortController | undefined>(undefined)
  const added = useRunObservationQuestionStore((state) => state.lastAdded)
  const draftReceived = Boolean(
    requestedSelectionId && added?.selection.selectionId === requestedSelectionId
  )
  const current = useRef(props)
  useLayoutEffect(() => {
    current.current = props
    if (!props.isActive) recoveryRequest.current?.abort()
  }, [props])
  useEffect(() => () => recoveryRequest.current?.abort(), [])
  useEffect(() => {
    let disposed = false,
      opened: ViewerAccess | undefined
    const api = window.api?.observations
    const revoke = (viewerId: string): void => {
      void api?.revoke({ viewerId }).catch(() => undefined)
    }
    if (!api) {
      queueMicrotask(() => {
        if (!disposed) setOpenFailed(true)
      })
      return () => {
        disposed = true
      }
    }
    const opening =
      admission.mode === 'recorded'
        ? api.openRecorded({
            target: admission.target,
            ...(admission.format ? { format: admission.format } : {})
          })
        : api.open({
            target: admission.target,
            allowInteraction: admission.allowInteraction,
            allowCancel: admission.allowCancel,
            allowCapture: admission.allowCapture,
            allowRecording: admission.allowRecording
          })
    void opening.then(
      (result) => {
        if (disposed) {
          revoke(result.viewerId)
          return
        }
        if (
          !validAccess(result, admission.target) ||
          (admission.mode === 'recorded') !== ('mode' in result && result.mode === 'recorded')
        ) {
          revoke(result.viewerId)
          setOpenFailed(true)
          return
        }
        opened = result
        setAccess(result)
        setOpenFailed(false)
      },
      () => {
        if (!disposed) setOpenFailed(true)
      }
    )
    return () => {
      disposed = true
      if (opened) revoke(opened.viewerId)
    }
  }, [admission, retry])
  const canAsk = Boolean(
    props.onAskSelection ||
    props.onAskArchiveSelection ||
    props.onAskArchiveFile ||
    props.onAskBrowserMoment
  )
  useEffect(() => {
    if (!access || !props.isActive || !canAsk) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        let selectionId: string | undefined,
          selectedEvidence: ObservationQuestionSelection | undefined,
          deliver: (() => void | Promise<void>) | undefined
        if (admission.mode === 'recorded' && admission.format === 'web-recording') {
          const selected = await window.api.projectRecordings.selection({
            viewerId: access.viewerId
          })
          const destination = current.current
          if (disposed || !destination.isActive || destination.mode !== 'recorded') return
          if (selected) {
            if (
              !selected.selectionId ||
              targetKey(selected.receiving) !== targetKey(admission.target)
            )
              throw new Error('Recorded moment scope changed.')
            selectionId = selected.selectionId
            selectedEvidence = selected
            deliver = destination.onAskBrowserMoment
              ? () => destination.onAskBrowserMoment!(selected, access.viewerId)
              : undefined
          }
        } else if (admission.mode === 'recorded') {
          const [stepSelection, fileSelection] = await Promise.all([
            admission.format === 'project-recording'
              ? null
              : window.api.observations.recordingSelection({ viewerId: access.viewerId }),
            window.api.observations.recordingFileSelection?.({ viewerId: access.viewerId }) ?? null
          ])
          const selected =
            fileSelection &&
            (!stepSelection || (fileSelection.selectedAt ?? 0) >= (stepSelection.selectedAt ?? 0))
              ? fileSelection
              : stepSelection
          const destination = current.current
          if (disposed || !destination.isActive || destination.mode !== 'recorded') return
          if (selected) {
            if (
              !selected.selectionId ||
              targetKey(selected.receiving) !== targetKey(admission.target)
            )
              throw new Error('Recorded selection scope changed.')
            selectionId = selected.selectionId
            selectedEvidence = selected
            deliver =
              selected.kind === 'recorded-observation-file'
                ? destination.onAskArchiveFile
                  ? () => destination.onAskArchiveFile!(selected, access.viewerId)
                  : undefined
                : destination.onAskArchiveSelection
                  ? () => destination.onAskArchiveSelection!(selected, access.viewerId)
                  : undefined
          }
        } else {
          const selected = await window.api.observations.selection({ viewerId: access.viewerId })
          const destination = current.current
          if (disposed || !destination.isActive || destination.mode === 'recorded') return
          if (selected) {
            if (!matchesSelection(selected, admission.target))
              throw new Error('Selection scope changed.')
            selectionId = selected.selectionId
            selectedEvidence = selected
            deliver = destination.onAskSelection
              ? () => destination.onAskSelection!(selected, access.viewerId)
              : undefined
          }
        }
        if (selectionId && deliver && !delivered.current.has(selectionId)) {
          recoveryRequest.current?.abort()
          setRecovering(false)
          delivered.current.add(selectionId)
          setRequestedSelectionId(selectionId)
          // Freeze this exact explicit Ask action before navigation or later observations.
          failedSelection.current = selectedEvidence && structuredClone(selectedEvidence)
          try {
            if (current.current.presentationMode === 'research') {
              const exiting = exitResearchReplayFullscreen()
              if (exiting) await exiting
              if (disposed || !current.current.isActive) return
            }
            await deliver()
            if (!disposed) {
              failedSelection.current = undefined
              setSelectionFailed(undefined)
            }
          } catch {
            if (!disposed) setSelectionFailed('ask')
          }
        }
        if (!disposed)
          setSelectionFailed((previous) => (previous === 'read' ? undefined : previous))
      } catch {
        if (!disposed) {
          setSelectionFailed('read')
          const playback = current.current.playback
          if (
            current.current.mode === 'recorded' &&
            playback?.playing &&
            playback.recordedAt !== undefined
          )
            playback.onSeekRecordedAt(playback.recordedAt)
        }
      }
      if (!disposed)
        timer = setTimeout(() => {
          void poll()
        }, 750)
    }
    void poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [access, admission, props.isActive, canAsk])
  return (
    // Keep the iframe inside fractional clipping/viewport edges and outside the workspace
    // divider's 20px hit area, which extends 9.5px into this panel. Preserve that drag corridor.
    <div className="flex h-full min-h-0 flex-col p-px pl-2.5" hidden={!props.isActive}>
      {openFailed ? (
        <ErrorNotice
          inline
          title={t('Could not open the research viewer.')}
          description={
            props.mode === 'recorded'
              ? t('The recorded evidence is unavailable.')
              : t('The experiment may still be running. Retry to open a new observation link.')
          }
          primaryButton={{ label: t('Retry'), onClick: () => setRetry((value) => value + 1) }}
        />
      ) : access ? (
        <>
          {savedBrowserTarget ? (
            <div className="h-12 shrink-0 overflow-y-auto border-b border-border-200 px-3 py-2">
              {publishedBrowserTargetKey === targetKey(savedBrowserTarget) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    showRecordedObservation(
                      savedBrowserTarget,
                      t('Project recording'),
                      'web-recording'
                    )
                  }
                >
                  {t('View recording')}
                </Button>
              ) : (
                <p role="status" className="text-xs text-muted-foreground">
                  {t('Recording saved. Playback will be available when this run finishes.')}
                </p>
              )}
            </div>
          ) : null}
          {recordingStatus?.archive ? (
            <div className="shrink-0 border-b border-border-200 px-3 py-2">
              <ObservationRecordingStatus
                status={recordingStatus}
                onOpenArchive={() =>
                  showRecordedObservation(recordingStatus.archive!, t('Archived observation'))
                }
              />
            </div>
          ) : null}
          {draftReceived ? (
            <p role="status" className="shrink-0 border-b border-border-200 px-3 py-2 text-xs">
              {t('Selected step added to the current draft. Review it before sending.')}
            </p>
          ) : null}
          {selectionFailed && (!draftReceived || selectionFailed === 'read') ? (
            <ErrorNotice
              inline
              title={
                selectionFailed === 'read' && props.mode === 'recorded'
                  ? t('Replay connection interrupted')
                  : t('Could not reference this recorded step.')
              }
              description={
                selectionFailed === 'ask'
                  ? props.mode === 'recorded'
                    ? t(
                        'Open an editable Session in this Project, or use Discuss from the imported research, to ask about this step.'
                      )
                    : t('Open the recorded Session to ask about this step.')
                  : props.mode === 'recorded'
                    ? t('Playback is paused. Reconnect to continue from the same position.')
                    : t('Return to this preview and select the step again.')
              }
              primaryButton={
                selectionFailed === 'ask' && props.questionRecovery
                  ? {
                      label: props.questionRecovery.label,
                      loading: recovering,
                      onClick: () => {
                        const selection = failedSelection.current
                        if (recovering || !selection) return
                        const abort = new AbortController()
                        recoveryRequest.current?.abort()
                        recoveryRequest.current = abort
                        setRecovering(true)
                        void Promise.resolve()
                          .then(() =>
                            props.questionRecovery!.onClick(
                              structuredClone(selection),
                              abort.signal
                            )
                          )
                          .catch(() => {
                            if (!abort.signal.aborted) setSelectionFailed('ask')
                          })
                          .finally(() => {
                            if (recoveryRequest.current === abort) setRecovering(false)
                          })
                      }
                    }
                  : selectionFailed === 'read' && props.mode === 'recorded'
                    ? {
                        label: t('Reconnect'),
                        onClick: () => {
                          setSelectionFailed(undefined)
                          setOpenFailed(false)
                          setAccess(undefined)
                          setRetry((value) => value + 1)
                        }
                      }
                    : undefined
              }
            />
          ) : null}
          <iframe
            ref={iframeRef}
            onLoad={recordingTransport.onLoad}
            key={access.viewerId}
            title={props.title}
            name={
              props.mode === 'recorded' && props.format === 'web-recording' && props.playback
                ? 'open-science-research-clock'
                : undefined
            }
            src={access.url}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0"
          />
        </>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {props.mode === 'recorded'
            ? t('Loading archived observation…')
            : t('Connecting to the research run…')}
        </p>
      )}
    </div>
  )
}
export const RunObservationPreview = (props: RunObservationPreviewProps): React.JSX.Element => (
  <RunObservationPreviewContent
    key={`${targetKey(props.target)}:${props.format ?? 'run-observation'}:${Boolean(props.allowInteraction)}:${Boolean(props.allowCancel)}:${Boolean(props.allowCapture)}`}
    {...props}
  />
)
