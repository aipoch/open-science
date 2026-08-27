import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useSettingsStore } from '@/stores/settings-store'
import { ActionToast } from './ActionToast'

const AUTO_DISMISS_MS = 8000

// Starts the existing Connector runtime subscription at app scope and projects only actionable
// reauthentication transitions. The durable recovery state remains the Connector row in Settings.
const ConnectorAuthToast = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const notice = useSettingsStore((state) => state.connectorAuthNotice)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const dismissConnectorAuthNotice = useSettingsStore((state) => state.dismissConnectorAuthNotice)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)

  useEffect(() => {
    void loadConnectors().catch(() => undefined)
  }, [loadConnectors])

  if (!notice) return null

  return (
    <ActionToast
      key={notice.id}
      title={t('{{name}} needs sign-in', { name: notice.displayName })}
      detail={t(
        'Authorization expired or was revoked. Sign in again to keep this Connector available.'
      )}
      actionLabel={t('Open Connectors')}
      dismissLabel={t('Close')}
      onAction={() => {
        dismissConnectorAuthNotice()
        openSettingsToPanel('connectors')
      }}
      onDismiss={dismissConnectorAuthNotice}
      autoDismissMs={AUTO_DISMISS_MS}
      className="top-20"
      testId="connector-auth-toast"
    />
  )
}

export { ConnectorAuthToast }
