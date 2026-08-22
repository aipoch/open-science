import { useTranslation } from 'react-i18next'

import type { ExternalSessionNotice } from '@/hooks/useLifecycleSync'
import { ActionToast } from './ActionToast'

const AUTO_DISMISS_MS = 6000

const LifecycleToast = ({
  notice,
  onDismiss,
  onView
}: {
  notice: ExternalSessionNotice | undefined
  onDismiss: () => void
  onView: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (!notice) return null

  return (
    <ActionToast
      key={`${notice.projectId}:${notice.sessionId}`}
      title={t('Session created externally')}
      detail={notice.title}
      actionLabel={t('View')}
      dismissLabel={t('Dismiss')}
      onAction={onView}
      onDismiss={onDismiss}
      autoDismissMs={AUTO_DISMISS_MS}
      testId="lifecycle-toast"
    />
  )
}

export { LifecycleToast }
