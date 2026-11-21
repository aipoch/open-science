import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionToast } from '@/components/ActionToast'
import { useSettingsStore } from '@/stores/settings-store'
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

export const InterruptedUpdateOpenNotice = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(
    () =>
      window.api?.platform === 'darwin' &&
      window.location.protocol === 'file:' &&
      window.location.hash === '#update-open-interrupted'
  )
  if (!visible) return null
  const dismiss = (): void => {
    window.location.replace('#')
    setVisible(false)
  }
  return (
    <ActionToast
      title={t('The update did not finish. Reopen your file or link after updating.')}
      actionLabel={t('View updates')}
      onAction={() => {
        dismiss()
        useSettingsStore.getState().openSettingsToPanel('general')
      }}
      dismissLabel={t('Dismiss')}
      onDismiss={dismiss}
    />
  )
}
