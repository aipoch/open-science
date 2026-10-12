import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../src/components/ui/button'
import { ErrorNotice } from '../src/components/error-notice'
import type {
  BrowserRecordingInspection,
  BrowserRecordingStatus,
  BrowserRecordingControlRequest
} from '../../shared/browser-recording'
import { recordingTime } from '../src/pages/workspace/replay/browser-recording-playback'
import type { ReplayViewerClient } from './client'

type Method = 'start' | 'pause' | 'resume' | 'stop'
export const BrowserRecordingControls = ({
  client,
  enabled,
  hostViewOpen,
  playbackReady = false,
  onOpen
}: {
  client: ReplayViewerClient
  enabled: boolean
  hostViewOpen: boolean
  /** True only after the live execution has settled its artifact publication. */
  playbackReady?: boolean
  onOpen?: (status: BrowserRecordingStatus) => void | Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [inspection, setInspection] = useState<BrowserRecordingInspection>()
  const [status, setStatus] = useState<BrowserRecordingStatus>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [retry, setRetry] = useState(0)
  const attempt = useRef<{ method: Method; request: BrowserRecordingControlRequest } | undefined>(
    undefined
  )
  const pending = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const atRevision = revision.current
      try {
        const inspected = await client.inspectBrowserRecording(controller.signal)
        const latest = inspected.active ?? (await client.browserRecordingStatus(controller.signal))
        if (!controller.signal.aborted && atRevision === revision.current) {
          setInspection(inspected)
          setStatus(latest)
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [client, hostViewOpen, retry])
  const control = async (method: Method): Promise<void> => {
    if (pending.current) return
    const current = attempt.current ?? {
      method,
      request: {
        requestId: crypto.randomUUID(),
        ...(method === 'start' ? {} : { recordingId: status?.recordingId })
      }
    }
    attempt.current = current
    setUncertain(true)
    revision.current += 1
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      setStatus(await client.controlBrowserRecording(current.method, current.request))
      attempt.current = undefined
      setUncertain(false)
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const terminal = !status || ['idle', 'finalized', 'partial', 'failed'].includes(status.state)
  const stateLabel =
    status?.state === 'recording'
      ? t('Recording webpage')
      : status?.state === 'paused'
        ? t('Web recording paused')
        : status?.state === 'starting'
          ? t('Preparing web recording…')
          : status?.state === 'finalizing'
            ? t('Saving web recording…')
            : status?.state === 'finalized'
              ? t('Web recording saved')
              : status?.state === 'partial'
                ? t('Web recording partially saved')
                : status?.state === 'failed'
                  ? t('Web recording failed')
                  : undefined
  return (
    <div
      className="h-28 shrink-0 space-y-2 overflow-y-auto border-b border-border-200 px-3 py-2"
      data-testid="browser-recording-controls"
    >
      <div className="flex flex-wrap items-center gap-2">
        {terminal ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!enabled || !hostViewOpen || !inspection?.supported || busy || uncertain}
            onClick={() => void control('start')}
          >
            {t('Record webpage')}
          </Button>
        ) : null}
        {status?.state === 'recording' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || uncertain}
            onClick={() => void control('pause')}
          >
            {t('Pause recording')}
          </Button>
        ) : null}
        {status?.state === 'paused' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!enabled || !hostViewOpen || busy || uncertain}
            onClick={() => void control('resume')}
          >
            {t('Resume recording')}
          </Button>
        ) : null}
        {status && ['recording', 'paused'].includes(status.state) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || uncertain}
            onClick={() => void control('stop')}
          >
            {t('Stop and save recording')}
          </Button>
        ) : null}
        {stateLabel ? (
          <span role="status" className="text-xs">
            {stateLabel} · {recordingTime(status?.elapsedMs ?? 0)}
          </span>
        ) : null}
        {status?.target && onOpen ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !playbackReady}
            onClick={() => {
              setBusy(true)
              void Promise.resolve(onOpen(status))
                .catch(() => setFailed(true))
                .finally(() => setBusy(false))
            }}
          >
            {t('View recording')}
          </Button>
        ) : null}
      </div>
      {status?.target && terminal && !playbackReady ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('Recording saved. Playback will be available when this run finishes.')}
        </p>
      ) : null}
      {status && ['recording', 'paused'].includes(status.state) ? (
        <p className="text-xs text-muted-foreground">
          {t('Stopping recording does not stop the experiment.')}
        </p>
      ) : null}
      {status?.state === 'partial' && status.target ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'Recording ended early. Saved footage remains available. You can start a new recording.'
          )}
        </p>
      ) : null}
      {inspection?.reason === 'desktop-required' ? (
        <p className="text-xs text-muted-foreground">
          {t('Open the project page in Open Science to record it.')}
        </p>
      ) : !hostViewOpen ? (
        <p className="text-xs text-muted-foreground">
          {t('Open the project interface before recording it.')}
        </p>
      ) : inspection && !inspection.supported ? (
        <p className="text-xs text-muted-foreground">
          {t('This project page is not currently available for recording.')}
        </p>
      ) : null}
      {failed ? (
        <ErrorNotice
          inline
          title={t('Could not confirm the web recording status.')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              if (attempt.current) void control(attempt.current.method)
              else {
                setFailed(false)
                setRetry((value) => value + 1)
              }
            },
            disabled: busy
          }}
        />
      ) : null}
    </div>
  )
}
