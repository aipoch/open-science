/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: Settings About · macrostructure: identity + resource list
 * genre: modern-minimal · theme: Open Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (semantic Settings tokens) · slop: pass
 */
import { CircleHelp, Download, FileText, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AppLogo } from '@/components/AppLogo'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../../shared/app-config'
import { SettingsRow, SettingsSection } from './SettingsLayout'

export type AppVersionSectionPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type AppVersionSectionProps = {
  previewState?: AppVersionSectionPreviewState
}

const resourceLinkClassName =
  'flex min-h-14 w-full gap-3 rounded-lg px-1 py-3 text-foreground no-underline transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px'

// App identity + update control in Settings→General. Reads the shared update store so it stays in
// sync with the external capsule; the update button opens the shared dialog (version + notes +
// download), so the download/confirm UX lives in one place.
const AppVersionSection = ({
  previewState = 'default'
}: AppVersionSectionProps): React.JSX.Element => {
  const { t } = useTranslation()
  const appInfo = useUpdateStore((state) => state.appInfo)
  const status = useUpdateStore((state) => state.status)
  const check = useUpdateStore((state) => state.check)
  const openDialog = useUpdateStore((state) => state.openDialog)

  const version = appInfo?.version ?? status.current
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const canCheck = !isChecking && !isDownloading
  const hasUpdate = status.state === 'available' || isDownloading || status.state === 'ready'
  const helpPreviewClassName =
    previewState === 'hover'
      ? 'bg-muted'
      : previewState === 'focus'
        ? 'ring-3 ring-ring/50'
        : previewState === 'active'
          ? 'translate-y-px'
          : ''

  const statusLine = ((): string => {
    switch (status.state) {
      case 'checking':
        return t('Checking for updates…')
      case 'available':
        return t('New version {{version}} is available', { version: status.latest })
      case 'downloading':
        return t('Downloading… {{percent}}%', { percent: status.progress ?? 0 })
      case 'ready':
        return status.applyKind === 'restart'
          ? t('Restart to update')
          : t('Update downloaded — open the installer to finish')
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
    <SettingsSection title={t('About')} aria-label={t('App version')} separated>
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
              {statusLine ? (
                <p
                  className={
                    status.state === 'error'
                      ? 'mt-1 text-xs text-destructive'
                      : 'mt-1 text-xs text-muted-foreground'
                  }
                  role={status.state === 'error' ? 'alert' : 'status'}
                >
                  {statusLine}
                </p>
              ) : null}
            </div>
          </div>
        }
        className="pt-0 sm:grid-cols-[minmax(0,1fr)_auto]"
        controlClassName="w-auto justify-self-end"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void check()} disabled={!canCheck}>
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

      <div className="divide-y divide-border border-t border-border">
        <ExternalTextLink
          href={APP.links.docs}
          aria-label={t('Open Help Center in your browser')}
          className={`${resourceLinkClassName} ${helpPreviewClassName}`}
        >
          <CircleHelp className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block whitespace-nowrap text-sm font-medium">{t('Help Center')}</span>
            <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
              {t('Read setup guides and troubleshooting.')}
            </span>
          </span>
        </ExternalTextLink>

        <ExternalTextLink
          href={APP.links.githubReleases}
          aria-label={t('Open release notes in your browser')}
          className={resourceLinkClassName}
        >
          <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block whitespace-nowrap text-sm font-medium">
              {t('Release notes')}
            </span>
            <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
              {t('See changes and fixes in every version.')}
            </span>
          </span>
        </ExternalTextLink>
      </div>
    </SettingsSection>
  )
}

export { AppVersionSection }
