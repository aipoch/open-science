import { useManualUpdate } from '@/components/use-manual-update'
import { InlineNotice } from '@/components/ui/inline-notice'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: Settings app information · macrostructure: identity + resource list
 * genre: modern-minimal · theme: Open-Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (semantic Settings tokens) · slop: pass
 */
import {
  CircleCheck,
  CircleHelp,
  Download,
  FileText,
  Globe,
  RefreshCw,
  Scale,
  Shield
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef } from 'react'

import { license as licenseId } from '../../../../../package.json'
import { AppLogo } from '@/components/AppLogo'
import { ManualUpdateGuide, ManualUpdateLinks } from '@/components/ManualUpdate'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { useLocaleStore } from '@/stores/locale-store'
import { useUpdateStore } from '@/stores/update-store'
import {
  APP,
  getDocumentationUrl,
  getInstallationDocumentationUrl
} from '../../../../shared/app-config'
import { SettingsRow, SettingsToggle } from './SettingsLayout'
import { SETTINGS_MANUAL_UPDATE_GUIDE_CLOSE } from './settings-manual-update-guide'

export type AppVersionSectionPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type AppVersionSectionProps = {
  previewState?: AppVersionSectionPreviewState
}

const resourceLinkClassName =
  'group flex min-h-20 w-full min-w-0 items-start gap-3 overflow-hidden rounded-lg border border-border bg-muted/40 p-3 text-foreground no-underline transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 dark:hover:bg-background/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px'

const resourceIconClassName =
  'mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 motion-reduce:transition-none group-hover:text-primary group-focus-visible:text-primary group-[.is-hover]:text-primary group-[.is-focus]:text-primary'

const resourceTitleClassName = 'block min-w-0 whitespace-normal break-words text-sm font-medium'

const resourceDescriptionClassName = 'mt-0.5 block text-xs text-muted-foreground'

// App identity + update control in Settings→General. Reads the shared update store so it stays in
// sync with the external capsule; the update button opens the shared dialog (version + notes +
// download), so the download/confirm UX lives in one place.
const AppVersionSection = ({
  previewState = 'default'
}: AppVersionSectionProps): React.JSX.Element => {
  const { t } = useTranslation()
  const locale = useLocaleStore((state) => state.locale)
  const appInfo = useUpdateStore((state) => state.appInfo)
  const status = useUpdateStore((state) => state.status)
  const check = useUpdateStore((state) => state.check)
  const openDialog = useUpdateStore((state) => state.openDialog)
  const setAutomaticDownloads = useUpdateStore((state) => state.setAutomaticDownloads)
  const manual = useManualUpdate(true)
  const sectionRef = useRef<HTMLDivElement>(null)
  const { closeGuide, guideOpenRef } = manual
  useEffect(() => {
    const section = sectionRef.current
    const returnFromGuide = (): void => {
      if (guideOpenRef.current) closeGuide()
    }
    section?.addEventListener(SETTINGS_MANUAL_UPDATE_GUIDE_CLOSE, returnFromGuide)
    return () => section?.removeEventListener(SETTINGS_MANUAL_UPDATE_GUIDE_CLOSE, returnFromGuide)
  }, [closeGuide, guideOpenRef])

  const version = appInfo?.version ?? status.current
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const hasUpdate = status.state === 'available' || isDownloading || status.state === 'ready'
  const helpPreviewClassName =
    previewState === 'hover'
      ? 'is-hover bg-muted'
      : previewState === 'focus'
        ? 'is-focus ring-3 ring-ring/50'
        : previewState === 'active'
          ? 'translate-y-px'
          : ''

  const statusLine = ((): string => {
    if (status.error) return status.error
    switch (status.state) {
      case 'checking':
        return t('Checking for updates…')
      case 'available':
        return t('New version {{version}} is available', { version: status.latest })
      case 'downloading':
        return t('Downloading… {{percent}}%', { percent: status.progress ?? 0 })
      case 'ready':
        return status.applyKind === 'installer'
          ? t('Update downloaded — open the installer to finish')
          : t('Update ready')
      case 'applying':
        return t('Installing…')
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
    <div
      ref={sectionRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && manual.guideOpenRef.current) {
          event.preventDefault()
          event.stopPropagation()
          manual.closeGuide()
        }
      }}
    >
      {manual.guideOpen ? (
        <ManualUpdateGuide manual={manual} status={status} backLabel={t('Back to settings')} />
      ) : null}
      <div hidden={manual.guideOpen} className={manual.guideOpen ? 'hidden' : 'contents'}>
        <div role="region" data-settings-anchor="general.about" aria-label={t('App version')}>
          <div className="flex items-center gap-3 pb-3 pt-2">
            <AppLogo className="size-14 shrink-0 rounded-xl" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold text-foreground">{APP.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">v{version}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{APP.copyright}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void check()}
              className="ml-auto shrink-0"
              disabled={isChecking || isDownloading || status.state === 'applying'}
            >
              <RefreshCw
                className={isChecking ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'}
                aria-hidden="true"
              />
              {isChecking ? t('Checking…') : t('Check now')}
            </Button>
          </div>

          <div data-testid="about-resource-grid" className="grid gap-3 pt-2 sm:grid-cols-2">
            <ExternalTextLink
              href={APP.update.downloadPage}
              data-settings-anchor="general.download"
              data-slot="about-resource-card"
              aria-label={t('Download from website')}
              className={resourceLinkClassName}
            >
              <Globe
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Download from website')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {t('Download the installer')}
                </span>
              </span>
            </ExternalTextLink>

            <ExternalTextLink
              href={getInstallationDocumentationUrl(locale)}
              data-settings-anchor="general.manual-install"
              data-slot="about-resource-card"
              aria-label={t('Open manual installation and update guidance in your browser')}
              className={resourceLinkClassName}
            >
              <Download
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Manual install or update')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {t(
                    'If an update runs into a problem, try replacing the current installation manually.'
                  )}
                </span>
              </span>
            </ExternalTextLink>

            <ExternalTextLink
              href={getDocumentationUrl(locale)}
              data-settings-anchor="general.help-center"
              data-slot="about-resource-card"
              aria-label={t('Open Help Center in your browser')}
              className={`${resourceLinkClassName} ${helpPreviewClassName}`}
            >
              <CircleHelp
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Help Center')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {t('Read setup guides and troubleshooting.')}
                </span>
              </span>
            </ExternalTextLink>

            <ExternalTextLink
              href={APP.links.githubReleases}
              data-slot="about-resource-card"
              aria-label={t('Open release notes in your browser')}
              className={resourceLinkClassName}
            >
              <FileText
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Release notes')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {t('See changes and fixes in every version.')}
                </span>
              </span>
            </ExternalTextLink>
            <ExternalTextLink
              href={APP.links.license}
              data-slot="about-resource-card"
              aria-label={t('Open-source license')}
              className={resourceLinkClassName}
            >
              <Scale
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Open-source license')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {licenseId}
                </span>
              </span>
            </ExternalTextLink>
            <ExternalTextLink
              href={APP.links.security}
              data-slot="about-resource-card"
              aria-label={t('Security')}
              className={resourceLinkClassName}
            >
              <Shield
                data-slot="about-resource-icon"
                className={resourceIconClassName}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span data-slot="about-resource-title" className={resourceTitleClassName}>
                  {t('Security')}
                </span>
                <span
                  data-slot="about-resource-description"
                  className={resourceDescriptionClassName}
                >
                  {t('Read the security policy and report vulnerabilities.')}
                </span>
              </span>
            </ExternalTextLink>
          </div>
          <div className="mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card empty:hidden">
            {statusLine && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {status.error || status.state === 'error' ? (
                    <InlineNotice level="error" role="alert">
                      {statusLine}
                    </InlineNotice>
                  ) : (
                    <p
                      role="status"
                      className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground"
                    >
                      {(status.state === 'ready' || status.state === 'up-to-date') && (
                        <CircleCheck
                          className="size-4 self-center text-primary"
                          aria-hidden="true"
                        />
                      )}
                      {statusLine}
                      {status.state === 'ready' && status.latest && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          v{status.latest}
                        </span>
                      )}
                    </p>
                  )}
                  {(status.error || status.state === 'error') &&
                    (manual.installer || manual.feedback) && (
                      <ManualUpdateLinks
                        manual={manual}
                        align="start"
                        showGuide={false}
                        showDownload={false}
                      />
                    )}
                </div>
                {hasUpdate ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => openDialog()}>
                    {status.state === 'ready'
                      ? status.applyKind === 'restart'
                        ? t('Restart to update')
                        : t('Open installer')
                      : isDownloading
                        ? t('View details')
                        : t('Update to {{version}}', { version: status.latest })}
                  </Button>
                ) : null}
              </div>
            )}

            {status.automaticDownloads !== undefined && (
              <SettingsRow
                label={t('Automatically download updates')}
                className="min-h-11 px-4 py-2.5 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <SettingsToggle
                  aria-label={t('Automatically download updates')}
                  enabled={status.automaticDownloads}
                  onToggle={() => void setAutomaticDownloads(!status.automaticDownloads)}
                />
              </SettingsRow>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export { AppVersionSection }
