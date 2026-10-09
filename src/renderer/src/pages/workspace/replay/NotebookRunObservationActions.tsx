import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { NotebookRunStatus } from '../../../../../shared/notebook'
import type { RunObservationTarget } from '../../../../../shared/run-observation'
import { showRecordedObservation, showRunObservation } from './open-run-observation'
import { useObservationRecordingStatus } from './use-observation-recording-status'
import { ObservationRecordingStatus } from './ObservationRecordingStatus'

/** One exact Run admission. Off-screen Notebook rows do not poll recording metadata. */
export const NotebookRunObservationActions = ({
  target,
  runStatus
}: {
  target: RunObservationTarget
  runStatus: NotebookRunStatus
}): React.JSX.Element => {
  const { t } = useTranslation()
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  const { projectId, sessionId, runId, operationId, executionInvocationId } = target
  const read = useCallback(
    () =>
      window.api.observations.recordingStatus({
        target: { projectId, sessionId, runId, operationId, executionInvocationId }
      }),
    [projectId, sessionId, runId, operationId, executionInvocationId]
  )
  const running = runStatus === 'queued' || runStatus === 'running'
  const { status, failed } = useObservationRecordingStatus({
    target,
    read,
    active: visible && typeof window.api?.observations?.recordingStatus === 'function',
    running,
    retry
  })
  return (
    <div ref={element} className="mt-2 space-y-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          showRunObservation(
            target,
            `${t('Run observation')} · ${(runId ?? executionInvocationId ?? operationId ?? '').slice(0, 8)}`
          )
        }
      >
        {running ? t('Observe run') : t('View run record')}
      </Button>
      {status ? (
        <ObservationRecordingStatus
          status={status}
          onOpenArchive={
            status.archive
              ? () => showRecordedObservation(status.archive!, t('Archived observation'))
              : undefined
          }
        />
      ) : null}
      {failed ? (
        <div className="flex items-center gap-2 text-xs">
          <span>{t('Recording status is unavailable.')}</span>
          <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            {t('Retry')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
