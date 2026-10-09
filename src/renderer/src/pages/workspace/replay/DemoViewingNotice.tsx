import { useTranslation } from 'react-i18next'
import type {
  RunObservationExecutionContext,
  RunObservationPhase
} from '../../../../../shared/run-observation'

/** An admitted upper bound, not a promise that an arbitrary project process stays alive. */
export const DemoViewingNotice = ({
  context,
  phase,
  recorded
}: {
  context?: RunObservationExecutionContext
  phase: RunObservationPhase
  recorded?: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (
    recorded ||
    context?.purpose !== 'offline-demo' ||
    !['preparing', 'queued', 'running'].includes(phase)
  )
    return null
  const viewing = context.demoViewing
  return (
    <div
      className="shrink-0 space-y-1 border-b border-border-200 px-3 py-2 text-xs text-text-300"
      data-testid="demo-viewing-notice"
    >
      <p>
        {viewing?.mode === 'until-stop-or-timeout'
          ? t(
              'This run keeps the project page open after its actions finish. Stop the run when you are done viewing.'
            )
          : t('The project page closes when this run ends.')}
      </p>
      {viewing ? (
        <p>
          {t('Maximum execution time: {{minutes}} min. The program may finish earlier.', {
            minutes: Math.ceil(viewing.timeoutMs / 60_000)
          })}
        </p>
      ) : (
        <p>{t('The viewing time limit was not recorded for this run.')}</p>
      )}
    </div>
  )
}
