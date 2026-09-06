import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { useSettingsStore } from '@/stores/settings-store'

export function DeviceCredentialLoadNotice({
  saved = false
}: {
  saved?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const loaded = useSettingsStore((state) => state.deviceCredentialsLoaded)
  const loading = useSettingsStore((state) => state.deviceCredentialsLoading)
  const error = useSettingsStore((state) => state.deviceCredentialsError)
  const load = useSettingsStore((state) => state.loadDeviceCredentials)
  if (error) {
    return (
      <div role="alert" className="mb-4">
        <ErrorNotice
          showBrand={false}
          icon={AlertTriangle}
          tone="amber"
          title={
            saved
              ? t('Credential saved. The list could not refresh.')
              : t('Could not load credentials.')
          }
          description={t('The credential list is unavailable. Try loading it again.')}
          primaryButton={{
            label: t('Retry'),
            loading,
            onClick: () => {
              void load(true).catch(() => undefined)
            }
          }}
        />
      </div>
    )
  }
  return !loaded ? (
    <p role="status" className="mb-4 text-sm text-muted-foreground">
      {t('Loading…')}
    </p>
  ) : null
}
