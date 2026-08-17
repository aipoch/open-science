import { Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AppLogo } from '@/components/AppLogo'
import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../../shared/app-config'
import { SettingsRow, SettingsSection } from './SettingsLayout'

// App identity + update control in Settings→General. Reads the shared update store so it stays in
// sync with the external capsule; the update button opens the shared dialog (version + notes +
// download), so the download/confirm UX lives in one place.
const AppVersionSection = (): React.JSX.Element => {
  const { t } = useTranslation()
  const appInfo = useUpdateStore((state) => state.appInfo)
  const status = useUpdateStore((state) => state.status)
  const check = useUpdateStore((state) => state.check)
  const openDialog = useUpdateStore((state) => state.openDialog)

  const version = appInfo?.version ?? status.current
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const hasUpdate = status.state === 'available' || isDownloading || status.state === 'ready'

  const statusLine = ((): string => {
    switch (status.state) {
      case 'checking':
        return t('Checking for updates…')
      case 'available':
        return t('New version {{version}} is available', { version: status.latest })
      case 'downloading':
        return t('Downloading… {{percent}}%', { percent: status.progress ?? 0 })
      case 'ready':
        return t('Update downloaded — open the installer to finish')
      case 'up-to-date':
        return t('You are on the latest version')
      case 'error':
        // Backend-supplied failure text passes through verbatim in every locale.
        return status.error ?? t('Update check failed')
      default:
        return ''
    }
  })()

  return (
    <SettingsSection title={t('About')} aria-label={t('App version')}>
      <SettingsRow
        label={
          <div className="flex min-w-0 items-center gap-3">
            <AppLogo className="size-12 rounded-lg" />
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-foreground">{APP.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">v{version}</span>
              </p>
              <p className="mt-0.5 text-xs font-normal text-muted-foreground">{APP.copyright}</p>
            </div>
          </div>
        }
        controlClassName="w-auto justify-self-end"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void check()}
            disabled={isChecking}
          >
            <RefreshCw
              className={isChecking ? 'size-4 animate-spin' : 'size-4'}
              aria-hidden="true"
            />
            {isChecking ? t('Checking…') : t('Check now')}
          </Button>

          {hasUpdate ? (
            <Button type="button" onClick={() => openDialog()}>
              <Download className="size-4" aria-hidden="true" />
              {isDownloading
                ? t('Downloading {{percent}}%', { percent: status.progress ?? 0 })
                : status.state === 'ready'
                  ? t('Update ready')
                  : t('Update to {{version}}', { version: status.latest })}
            </Button>
          ) : null}
        </div>
      </SettingsRow>

      {statusLine ? (
        <p
          className={
            status.state === 'error'
              ? 'mt-2 text-xs text-destructive'
              : 'mt-2 text-xs text-muted-foreground'
          }
          role={status.state === 'error' ? 'alert' : undefined}
        >
          {statusLine}
        </p>
      ) : null}
    </SettingsSection>
  )
}

export { AppVersionSection }
