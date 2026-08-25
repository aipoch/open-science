import { useState } from 'react'
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
  const [isOverlayDismissed, setIsOverlayDismissed] = useState(false)

  if (recovery.kind === 'ready') return null
  if (!inline && isOverlayDismissed) return null

  // Overlay dismissal is session-local: archive remains blocked and Settings still shows the
  // inline reminder. Restarting the app re-derives catalog recovery and shows the overlay again.
  const onDismiss = inline ? undefined : () => setIsOverlayDismissed(true)

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
        onDismiss={onDismiss}
      />
    )
  }
  if (recovery.kind === 'unsupported-version') {
    return (
      <SessionPersistenceAlert
        title={t('Open Science update required')}
        message={t(
          '{{count}} saved conversations require a newer version of Open Science. Update the app before creating or saving conversations so those files stay unchanged.',
          {
            count: recovery.affectedFileCount,
            defaultValue_one:
              'A saved conversation requires a newer version of Open Science. Update the app before creating or saving conversations so those files stay unchanged.'
          }
        )}
        variant="warning"
        inline={inline}
        onDismiss={onDismiss}
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
        onDismiss={onDismiss}
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
      onDismiss={onDismiss}
    />
  )
}

export { SessionCatalogRecoveryAlert }
