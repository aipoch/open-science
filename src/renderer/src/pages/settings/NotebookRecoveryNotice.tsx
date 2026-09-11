import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import type { NotebookRecoveryStatus } from '../../../../shared/notebook-env'

export const NotebookRecoveryNotice = ({
  recovery
}: {
  recovery?: NotebookRecoveryStatus
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  if (!recovery || (!recovery.corruptJournal && recovery.operations.length === 0)) return null
  const reason = (value: NotebookRecoveryStatus['operations'][number]['reason']): string => {
    switch (value) {
      case 'child-unconfirmed':
        return t(
          'The previous worker may still be running. Wait for it to exit, then use Recheck. Restarting the app does not prove it stopped.'
        )
      case 'child-unrecorded':
        return t(
          'The worker identity was not recorded. Automatic recovery cannot prove it stopped on this platform. Keep the journal and contact support; do not delete the environment.'
        )
      case 'archive-unconfirmed':
        return t(
          'Package changes may be complete, but archive publication is unconfirmed. Keep the environment and cache for repair.'
        )
      case 'recovery-failed':
        return t(
          'Recovery could not finish. Check disk space and file access, then use Recheck. The journal is retained.'
        )
    }
  }
  return (
    <ErrorNotice
      tone="amber"
      title={t('Runtime recovery blocked')}
      description={t(
        'Use Recheck to retry safe recovery. Only confirmed stopped operations can be reconciled; permissions and repair requirements remain in force.'
      )}
    >
      {recovery.checkedAt !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {t('Recovery last checked {{time}}', {
            time: formatDate(recovery.checkedAt, 'dateTime')
          })}
        </p>
      ) : null}
      {recovery.corruptJournal ? (
        <p>
          {t(
            'The operation journal is unreadable. Keep it for diagnosis; automatic recovery cannot determine which environments are safe.'
          )}
        </p>
      ) : null}
      {recovery.operations.map((operation) => (
        <div key={operation.operationId} className="mt-2 text-xs">
          <p>{reason(operation.reason)}</p>
          <code className="block break-all">
            {operation.runtimeId} · {operation.operationId}
          </code>
          {operation.targetPath ? (
            <code className="block break-all">{operation.targetPath}</code>
          ) : null}
        </div>
      ))}
    </ErrorNotice>
  )
}
