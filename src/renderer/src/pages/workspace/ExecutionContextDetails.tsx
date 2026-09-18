import { useTranslation } from 'react-i18next'
import { notebookExecutionContextSchema } from '../../../../shared/notebook-execution-context'

export const ExecutionContextDetails = ({
  value
}: {
  value: unknown
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const context = notebookExecutionContextSchema.safeParse(value)
  if (!context.success) return null
  return (
    <details className="border-b border-border-300/60 pb-3 text-xs">
      <summary className="cursor-pointer font-medium text-text-200">
        {t('Execution context')}
      </summary>
      <p className="mt-2 text-text-300">
        {t('Recorded for diagnostics; random generator states are not restored.')}
      </p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-text-200">
        {JSON.stringify(context.data, null, 2)}
      </pre>
    </details>
  )
}
