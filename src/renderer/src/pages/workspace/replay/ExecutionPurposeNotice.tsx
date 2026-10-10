import { useTranslation } from 'react-i18next'
import type { RunObservationExecutionContext } from '../../../../../shared/run-observation'

/** Main supplies this context independently of the archive. Missing legacy context stays unknown. */
export const ExecutionPurposeNotice = ({
  context
}: {
  context?: RunObservationExecutionContext
}): React.JSX.Element => {
  const { t } = useTranslation()
  const purpose = context?.purpose ?? 'unknown'
  const known = purpose !== 'unknown'
  return (
    <div
      className="shrink-0 space-y-1 border-b border-border-200 px-3 py-2 text-xs"
      data-testid="execution-purpose"
    >
      <p className="font-medium">
        {purpose === 'offline-demo'
          ? t('Offline run')
          : purpose === 'research'
            ? t('Research execution')
            : t('Execution purpose not recorded')}
      </p>
      {known ? (
        <p className="text-text-300">
          {purpose === 'offline-demo'
            ? t(
                'This run uses packaged offline inputs. It does not reproduce the original external environment.'
              )
            : t('A research execution is not, by itself, evidence of successful reproduction.')}
        </p>
      ) : null}
      {known && (context?.profileName || context?.conditionChanges.length) ? (
        <details>
          <summary className="cursor-pointer text-text-300">{t('Execution conditions')}</summary>
          <div className="mt-2 max-h-40 space-y-2 overflow-y-auto break-words">
            {context.profileName ? (
              <p>{t('Recorded configuration: {{name}}', { name: context.profileName })}</p>
            ) : null}
            {context.conditionChanges.length ? (
              <div>
                <p className="font-medium">{t('Changes from the original experiment')}</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {context.conditionChanges.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}
