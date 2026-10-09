import { memo } from 'react'
import type { RecordedExecutionState } from '@/lib/replay/recorded-execution'
import { useReplayTranslation } from './replay-presentation'
import { useObservationPhaseLabel } from './replay-observation-labels'
import { formatReplayRecordedTime } from './replay-recorded-gaps'

/** Read-only samples on the research clock. This component owns neither IO nor playback. */
export const ReplayExecutionState = memo(function ReplayExecutionState({
  state,
  detail = false,
  waiting = false
}: {
  state: RecordedExecutionState
  detail?: boolean
  waiting?: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const phaseLabel = useObservationPhaseLabel()
  const snapshot = state.snapshot
  if (!snapshot)
    return (
      <p className="text-xs text-text-300">
        {t('No execution status has been recorded at this point.')}
      </p>
    )
  const logs = snapshot.run?.logs
  return (
    <section
      className="min-w-0 space-y-2 text-xs"
      aria-label={t('Recorded execution status')}
      data-testid="replay-execution-state"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{phaseLabel(snapshot.phase)}</span>
        <span className="text-text-300">
          {t('Last observed at {{time}}', {
            time: formatReplayRecordedTime(snapshot.observedAt - state.track.origin)
          })}
        </span>
      </div>
      {waiting ? (
        <p className="text-text-300">{t('No newer status record at this playback position.')}</p>
      ) : null}
      {detail ? (
        <>
          <p className="text-text-300">
            {t('This is the last saved observation, not a continuous activity log.')}
          </p>
          {logs
            ? (['stdout', 'stderr', 'traceback'] as const).map((channel) => {
                const log = logs[channel]
                if (!log.text && !log.truncated && !log.redacted) return null
                return (
                  <div key={channel} className="min-w-0 space-y-1">
                    <span className="font-mono text-[10px] text-text-300">{channel}</span>
                    <pre
                      className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200 p-3 font-mono text-xs"
                      data-replay-observation-log={channel}
                    >
                      {log.text}
                    </pre>
                    {log.truncated ? (
                      <p className="text-text-300">{t('Archived output is truncated.')}</p>
                    ) : null}
                    {log.redacted ? (
                      <p className="text-text-300">
                        {t('Sensitive content was removed from this observation.')}
                      </p>
                    ) : null}
                  </div>
                )
              })
            : null}
          {state.track.coverage.droppedEarlierObservations ||
          state.track.coverage.samplingFailures ||
          state.track.coverage.unavailableSamples ||
          state.track.coverage.sourceCursorGaps ? (
            <p className="text-text-300">
              {t('Some observations were not saved. The recorded process may be incomplete.')}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
})
