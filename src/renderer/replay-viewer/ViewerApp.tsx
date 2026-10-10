import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '../src/components/error-notice'
import { Button } from '../src/components/ui/button'
import { LiveReplayView } from '../src/pages/workspace/replay/LiveReplayView'
import { observationRecordId, observationSourceIdentity } from '../src/lib/replay/live-source'
import type { ReplayResource } from '../../shared/replay'
import type { RunObservationSelection, RunObservationSnapshot } from '../../shared/run-observation'
import type { RuntimeViewAccess } from '../../shared/runtime-view'
import { ReplayViewerClient } from './client'
import { useViewerObservation } from './use-viewer-observation'
import { selectionReference } from './selection-reference'
import { BrowserArtifactPreview } from './BrowserArtifactPreview'
import { ReferencePanel } from './ReferencePanel'
import { RecordedViewerApp } from './RecordedViewerApp'
import { ResearchReplayViewerApp } from './ResearchReplayViewerApp'
import { useObservationRecordingStatus } from '../src/pages/workspace/replay/use-observation-recording-status'
import { ObservationRecordingStatus } from '../src/pages/workspace/replay/ObservationRecordingStatus'
import { BrowserRecordingControls } from './BrowserRecordingControls'
import { ObservationCaptureControls } from './ObservationCaptureControls'
import { capturesForObservation, useViewerCaptures } from './use-viewer-captures'
import { RecordedProjectImages } from '../src/pages/workspace/replay/RecordedProjectImages'
import { i18next, prepareI18nLocale, setI18nLocale } from '../src/i18n'
import { applyHtmlLang } from '../src/lib/locale-preference'

const unavailableResource = async (): Promise<{
  status: 'unavailable'
  reason: 'not-recorded'
}> => ({
  status: 'unavailable',
  reason: 'not-recorded'
})

export type ViewerAppProps = {
  client?: ReplayViewerClient
  /** An explicitly installed host adapter may forward a selection. The standalone page never
   * trusts a parent URL parameter and never sends wildcard postMessage notifications. */
  onSelectionCaptured?: (selection: RunObservationSelection) => void | Promise<void>
  /** Trusted host/test navigation adapter; no destination comes from the project iframe. */
  navigateToArchive?: (url: string) => void
}
export const ViewerApp = ({
  client: providedClient,
  onSelectionCaptured,
  navigateToArchive = (url) => window.location.replace(url)
}: ViewerAppProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [client] = useState(() => providedClient ?? new ReplayViewerClient())
  const [retry, setRetry] = useState(0)
  const {
    context: viewerContext,
    history,
    recording,
    connection,
    error
  } = useViewerObservation(client, retry)
  const context = viewerContext?.mode === 'research' ? undefined : viewerContext
  const desktopLocale = context?.presentation === 'desktop' ? context.locale : undefined
  useEffect(() => {
    if (!desktopLocale || i18next.language === desktopLocale) return
    let disposed = false
    // A timed-out initial context read must not permanently strand a desktop viewer in its
    // browser fallback language after the normal observation connection recovers.
    void Promise.resolve(prepareI18nLocale(desktopLocale))
      .then(() => {
        if (disposed) return
        setI18nLocale(desktopLocale)
        applyHtmlLang(desktopLocale)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [desktopLocale])
  const snapshot = history?.snapshots.at(-1)
  const captured = useViewerCaptures(
    client,
    Boolean(
      context?.mode !== 'recorded' &&
      context?.canReadArtifacts &&
      context?.canCapture &&
      connection === 'connected' &&
      snapshot?.run?.status === 'running'
    )
  )
  const readRecordingStatus = useCallback(() => client.recordingStatus(), [client])
  const { status: recordingStatus } = useObservationRecordingStatus({
    target: context?.mode !== 'recorded' ? context?.target : undefined,
    read: readRecordingStatus,
    active: context?.mode !== 'recorded' && connection === 'connected',
    running: Boolean(
      snapshot && ['preparing', 'queued', 'running', 'collecting'].includes(snapshot.phase)
    )
  })
  const [selection, setSelection] = useState<RunObservationSelection>()
  const [access, setAccess] = useState<RuntimeViewAccess>()
  const [opening, setOpening] = useState(false)
  const [projectError, setProjectError] = useState(false)
  const [archiveOpening, setArchiveOpening] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const archivePending = useRef(false)
  const openPending = useRef(false)
  const current = useRef({ snapshot, connection })
  useLayoutEffect(() => {
    current.current = { snapshot, connection }
  }, [snapshot, connection])
  const viewerId = context?.mode !== 'recorded' ? context?.viewerId : undefined
  useEffect(() => {
    if (!viewerId) return
    const controller = new AbortController()
    void client.selection(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && value) setSelection((existing) => existing ?? value)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [client, viewerId])
  // Drop a consumed one-use URL immediately on disconnect or run change. Reconnection
  // needs a new explicit activation, never a reload of an already consumed grant.
  if (
    access &&
    (connection !== 'connected' ||
      snapshot?.phase !== 'running' ||
      snapshot.run?.status !== 'running' ||
      access.view.scope.runId !== snapshot.run.runId)
  )
    setAccess(undefined)
  const readResource = useCallback(
    (resource: ReplayResource) => client.readResource(resource),
    [client]
  )
  const readArtifact = useCallback(
    (resource: ReplayResource, signal?: AbortSignal) => client.artifact(resource, signal),
    [client]
  )
  const ask = async (record: RunObservationSnapshot): Promise<void> => {
    const captured = await client.select(record)
    setSelection(captured)
    await onSelectionCaptured?.(captured)
  }
  const openArchive = async (): Promise<void> => {
    if (!recordingStatus?.archive || context?.presentation !== 'browser' || archivePending.current)
      return
    archivePending.current = true
    setArchiveOpening(true)
    setArchiveError(false)
    try {
      const opened = await client.openArchive(recordingStatus.archive)
      navigateToArchive(opened.url)
    } catch {
      setArchiveError(true)
    } finally {
      archivePending.current = false
      setArchiveOpening(false)
    }
  }
  const archiveAction =
    context?.presentation === 'browser' && recordingStatus?.archive
      ? () => {
          void openArchive()
        }
      : undefined
  const openProject = async (): Promise<void> => {
    if (
      !context?.canInteract ||
      !snapshot ||
      connection !== 'connected' ||
      snapshot.run?.status !== 'running' ||
      openPending.current
    )
      return
    openPending.current = true
    setOpening(true)
    setProjectError(false)
    try {
      const opened = await client.projectView(snapshot)
      const latest = current.current
      if (
        latest.connection === 'connected' &&
        latest.snapshot?.run?.runId === opened.view.scope.runId &&
        latest.snapshot.run.status === 'running'
      )
        setAccess(opened)
    } catch {
      setProjectError(true)
    } finally {
      openPending.current = false
      setOpening(false)
    }
  }
  const runtimeSurface = useMemo(
    () =>
      access
        ? {
            runId: access.view.scope.runId,
            activationId: access.view.viewId,
            content: (
              <iframe
                key={access.view.viewId}
                data-observation-project-view={access.view.viewId}
                title={access.view.title}
                src={access.url}
                sandbox="allow-scripts allow-forms allow-same-origin"
                referrerPolicy="no-referrer"
                className="min-h-0 w-full flex-1 border-0"
              />
            )
          }
        : undefined,
    [access]
  )
  const reference =
    context && selection ? selectionReference(context.viewerId, selection) : undefined
  if (error === 'authorization')
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorNotice
          title={t('This observation link is no longer authorized.')}
          description={t(
            'Open a new viewer from Open Science or your agent. Existing experiments are not restarted.'
          )}
        />
      </main>
    )
  if (viewerContext?.mode === 'research')
    return <ResearchReplayViewerApp key={viewerContext.viewerId} context={viewerContext} />
  if (context?.mode === 'recorded' && recording)
    return (
      <RecordedViewerApp
        key={context.viewerId}
        client={client}
        context={context}
        payload={recording}
      />
    )
  if (!context || context.mode === 'recorded' || !snapshot || !history)
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorNotice
          tone="teal"
          role="status"
          title={
            context?.mode === 'recorded'
              ? t('Loading archived observation…')
              : t('Connecting to the research run…')
          }
          description={
            error
              ? context?.mode === 'recorded'
                ? t(
                    'The archived observation could not be loaded. Retry to read this saved Version.'
                  )
                : t('The viewer could not connect. The experiment may still be running.')
              : undefined
          }
          primaryButton={
            error ? { label: t('Retry'), onClick: () => setRetry((value) => value + 1) } : undefined
          }
        />
      </main>
    )
  return (
    <main className="flex h-svh min-h-0 flex-col bg-bg-000 text-text-100">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-200 px-3 py-1">
        <div className="min-w-0">
          <span className="text-sm font-medium">{t('Run observation')}</span>
          {recordingStatus ? (
            <ObservationRecordingStatus
              status={recordingStatus}
              onOpenArchive={archiveAction}
              openingArchive={archiveOpening}
            />
          ) : null}
        </div>
        {context.canInteract && access ? (
          <Button
            data-testid="open-project-interface"
            size="sm"
            variant="outline"
            disabled={opening || connection !== 'connected' || snapshot.run?.status !== 'running'}
            onClick={() => {
              void openProject()
            }}
          >
            {opening ? t('Opening project interface…') : t('Reopen project interface')}
          </Button>
        ) : !context.canInteract ? (
          <span className="text-xs text-muted-foreground">
            {t('Project interaction is not enabled for this viewer.')}
          </span>
        ) : null}
      </div>
      {archiveError ? (
        <ErrorNotice
          inline
          title={t('Could not open the research viewer.')}
          description={t(
            'The archived observation could not be loaded. Retry to read this saved Version.'
          )}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              void openArchive()
            },
            disabled: archiveOpening
          }}
        />
      ) : null}
      {projectError ? (
        <ErrorNotice
          inline
          title={t('Could not open the project interface.')}
          description={t('The service may not be ready. Check the execution record and try again.')}
          dismissButton={{ label: t('Dismiss'), onClick: () => setProjectError(false) }}
        />
      ) : null}
      {context.canRecord ? (
        <BrowserRecordingControls
          client={client}
          enabled={connection === 'connected' && snapshot.run?.status === 'running'}
          hostViewOpen={Boolean(access)}
          playbackReady={
            connection === 'connected' &&
            ['completed', 'failed', 'cancelled', 'interrupted', 'timeout'].includes(snapshot.phase)
          }
          onOpen={
            context.presentation === 'browser'
              ? async (status) => {
                  if (status.target)
                    navigateToArchive(
                      (await client.openArchive(status.target, 'web-recording')).url
                    )
                }
              : undefined
          }
        />
      ) : null}
      {reference ? (
        <ReferencePanel
          presentation={context?.presentation}
          key={reference}
          reference={reference}
          observedAt={selection?.snapshot.observedAt}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <LiveReplayView
          title={t('Observe run')}
          sourceIdentity={`${context.viewerId}:${observationSourceIdentity(context.target)}`}
          snapshot={snapshot}
          history={history.snapshots}
          historyTruncated={history.truncated}
          connection={connection}
          readResource={context.canReadArtifacts ? readResource : unavailableResource}
          renderResource={
            context.canReadArtifacts
              ? (resource) => (
                  <BrowserArtifactPreview
                    key={resource.versionId}
                    read={readArtifact}
                    resource={resource}
                  />
                )
              : undefined
          }
          runtimeSurface={runtimeSurface}
          projectActivation={
            context.canInteract ? { opening, onOpen: () => void openProject() } : undefined
          }
          renderRecordedSurface={(record) => {
            const frames = capturesForObservation(captured.captures, record)
            const images = frames.length ? (
              <RecordedProjectImages
                key={`${record.cursor.epoch}:${record.cursor.sequence}`}
                sourceStep={observationRecordId(record)}
                images={frames.map((frame) => ({
                  id: frame.captureId,
                  capture: frame.capture,
                  publication: frame.publication
                }))}
                readImage={captured.readImage}
              />
            ) : undefined
            // The Run owner releases its live image cache at cleanup. Absence from that cache
            // after completion is not evidence that no image was recorded in the archive.
            const ended = snapshot.run?.status !== 'running' && snapshot.run?.status !== 'queued'
            if (!images && !ended) return undefined
            // Keep the frame selector mounted when completion adds the archive controls.
            // A terminal update must not reset a user's selected image within the same step.
            return (
              <div className="space-y-3 text-sm text-muted-foreground">
                {images}
                {ended ? (
                  recordingStatus ? (
                    <ObservationRecordingStatus
                      status={recordingStatus}
                      onOpenArchive={archiveAction}
                      openingArchive={archiveOpening}
                    />
                  ) : (
                    <p role="status">{t('Recording status is unavailable.')}</p>
                  )
                ) : null}
              </div>
            )
          }}
          renderLiveActions={
            context.canCapture
              ? (enabled) => (
                  <ObservationCaptureControls
                    client={client}
                    enabled={enabled}
                    hostViewOpen={Boolean(access)}
                  />
                )
              : undefined
          }
          onAskSelection={ask}
          onStop={context.canCancel ? () => client.cancel() : undefined}
        />
      </div>
    </main>
  )
}
