import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSettingsStore } from '@/stores/settings-store'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import { ActionToast } from './ActionToast'

const StorageCleanupToast = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const cleanupPending = useStorageInfoStore((state) => state.status?.cleanupPending === true)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)
  const [dismissed, setDismissed] = useState(false)

  if (!cleanupPending || dismissed) return null

  return (
    <ActionToast
      title={t('Old data location needs cleanup')}
      detail={t(
        'Your data is using the new location, but some files remain in the old one. Open Science will try again the next time it starts.'
      )}
      actionLabel={t('Open Storage')}
      dismissLabel={t('Close')}
      onAction={() => {
        setDismissed(true)
        openSettingsToPanel('storage')
      }}
      onDismiss={() => setDismissed(true)}
      className="top-32"
      testId="storage-cleanup-toast"
    />
  )
}

export { StorageCleanupToast }
