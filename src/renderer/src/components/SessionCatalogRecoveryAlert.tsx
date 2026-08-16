import { useTranslation } from 'react-i18next'

import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { SessionPersistenceAlert } from './SessionPersistenceAlert'

type SessionCatalogRecoveryAlertProps = {
  recovery: SessionCatalogRecovery
  inline?: boolean
  onRetry?: () => void
}

// Catalog recovery is a storage concern shown before a Project command is attempted. Keep it
// distinct from command failures and from the Project Files index, which cannot restore Session JSON.
const SessionCatalogRecoveryAlert = ({
  recovery,
  inline,
  onRetry
}: SessionCatalogRecoveryAlertProps): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (recovery.kind === 'ready') return null
  if (recovery.kind === 'project-deletion-recovery') {
    return (
      <SessionPersistenceAlert
        title={t('Project recovery needs attention')}
        message={t(
          'Open Science could not finish recovering a previous project deletion. Retry recovery before archiving or deleting projects.'
        )}
        inline={inline}
        onRetry={onRetry}
        retryLabel={t('Retry recovery')}
      />
    )
  }
  if (recovery.kind === 'damaged-authority') {
    return (
      <SessionPersistenceAlert
        title={t('Project archive needs attention')}
        message={t(
          '{{count}} damaged saved conversations were moved aside. Project archive stays unavailable because their state cannot be verified. You can still permanently delete the project.',
          {
            count: recovery.affectedFileCount,
            defaultValue_one:
              'A damaged saved conversation was moved aside. Project archive stays unavailable because its state cannot be verified. You can still permanently delete the project.'
          }
        )}
        variant="warning"
        inline={inline}
      />
    )
  }

  return (
    <SessionPersistenceAlert
      title={t('Project index needs repair')}
      message={
        recovery.reason === 'startup-reconciliation'
          ? t(
              'Saved conversations loaded, but the project index could not be rebuilt. Repair the index before archiving projects.'
            )
          : t(
              'Some saved conversations could not be indexed. Repair the index before archiving projects.'
            )
      }
      inline={inline}
      onRetry={onRetry}
      retryLabel={t('Repair index')}
    />
  )
}

export { SessionCatalogRecoveryAlert }
