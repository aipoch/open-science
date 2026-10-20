import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionToast } from '@/components/ActionToast'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../shared/update'

// Completion is feedback in the workspace, not a modal request. Main alone certifies outcomes.
export const RuntimeUpdateOutcomeNotice = (): React.JSX.Element | null => {
  const status = useUpdateStore((state) => state.status)
  return status.outcome ? (
    <RuntimeUpdateCompletedNotice
      key={`${status.recovery?.operationId ?? status.latest}:${status.outcome}`}
      status={status}
    />
  ) : null
}

const RuntimeUpdateCompletedNotice = ({
  status
}: {
  status: UpdateStatus
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  if (!status.outcome || dismissed) return null
  const id = { cancelled: 'S15', recovered: 'S28', installed: 'S27' }[status.outcome]
  const title =
    status.outcome === 'installed'
      ? t(
          'Update verified. The app, service, and existing work data are ready. Interrupted tasks will not restart automatically.'
        )
      : status.outcome === 'recovered'
        ? t(
            'Update cancelled and the app recovered. The download is kept. Interrupted tasks will not restart automatically.'
          )
        : t('Update cancelled. The service is still running and the download is kept.')
  return (
    <div data-runtime-update-state={id}>
      <ActionToast
        level="success"
        title={t('Update')}
        detail={title}
        dismissLabel={t('Dismiss')}
        onDismiss={() => setDismissed(true)}
      />
    </div>
  )
}
