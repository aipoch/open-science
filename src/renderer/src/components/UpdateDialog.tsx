import { Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Trans, useTranslation } from 'react-i18next'

import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../shared/app-config'
import { isLocale } from '../../../shared/locale'
import { formatBytes } from '../../../shared/update'

const UPDATE_BACKGROUND_PROCESS_ERROR =
  'Could not stop background processes before updating. Please try again.'
const UPDATE_BACKGROUND_PROCESS_DEGRADED_ERROR =
  'Could not fully stop background processes before updating. Please try again.'
const UPDATE_SETTINGS_INSTALL_ERROR =
  'An Agent Runtime is still installing. Wait for it to finish before restarting to update.'

// Update confirmation dialog: shows the target version and release notes so the user can decide
// before a large download. Opened from the external capsule and the settings About section. When the
// manifest carries no notes, it links to the matching GitHub release so the user can still read them.
const UpdateDialog = ({ active = true }: { active?: boolean }): React.JSX.Element | null => {
  const { t, i18n } = useTranslation()
  const status = useUpdateStore((state) => state.status)
  const isOpen = useUpdateStore((state) => state.isDialogOpen)
  const closeDialog = useUpdateStore((state) => state.closeDialog)
  const download = useUpdateStore((state) => state.download)
  const apply = useUpdateStore((state) => state.apply)

  const open = Boolean(active && isOpen && status.latest)
  const dialogStatus = useRetainedDialogValue(open ? status : undefined)
  const releaseUrl = `${APP.links.githubReleases}/tag/v${dialogStatus?.latest ?? ''}`
  const isDownloading = dialogStatus?.state === 'downloading'
  const isReady = dialogStatus?.state === 'ready'
  const isApplying = dialogStatus?.state === 'applying'
  const isBackgroundProcessError =
    dialogStatus?.error === UPDATE_BACKGROUND_PROCESS_ERROR ||
    dialogStatus?.error === UPDATE_BACKGROUND_PROCESS_DEGRADED_ERROR
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language
  const locale = isLocale(activeLanguage) ? activeLanguage : 'en'
  const localizedNotes = locale === 'en' ? undefined : dialogStatus?.localizedNotes?.[locale]
  const releaseNotes = localizedNotes ?? dialogStatus?.notes
  const isEnglishFallback = locale !== 'en' && !localizedNotes && Boolean(dialogStatus?.notes)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open && !isApplying) closeDialog()
      }}
    >
      {dialogStatus ? (
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <Dialog.Content
            onInteractOutside={(event) => event.preventDefault()}
            className={dialogPanelClassName('z-[60] w-[min(560px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div>
                <Dialog.Title className={dialogTitleClassName}>
                  {t('Update available')}
                </Dialog.Title>
                <Dialog.Description
                  className={cn(dialogDescriptionClassName, 'text-xs tabular-nums')}
                >
                  {t('v{{current}} → v{{latest}}', {
                    current: dialogStatus.current,
                    latest: dialogStatus.latest
                  })}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  disabled={isApplying}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>

            <div className={dialogBodyClassName}>
              {releaseNotes ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t("What's new")}
                  </p>
                  {isEnglishFallback ? (
                    <p className="mb-2 text-xs text-muted-foreground">
                      {t('Localized release notes are unavailable; showing English.')}
                    </p>
                  ) : null}
                  <div className="max-h-96 overflow-auto rounded-lg bg-muted px-3 py-2">
                    <AgentMarkdown content={releaseNotes} />
                  </div>
                  <ExternalTextLink href={releaseUrl} className="mt-2 text-xs">
                    {t('View full release notes on GitHub')}
                  </ExternalTextLink>
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
                  {t("Release notes aren't available in-app for this version.")}{' '}
                  <ExternalTextLink href={releaseUrl} className="text-xs">
                    {t('View release notes on GitHub')}
                  </ExternalTextLink>
                </div>
              )}

              {isDownloading ? (
                <div className="mt-4">
                  <DownloadProgressLine
                    progress={
                      dialogStatus.downloadProgress ?? {
                        phase: 'downloading',
                        transferred: dialogStatus.downloadedBytes ?? 0,
                        total: dialogStatus.totalBytes,
                        percent: dialogStatus.progress ?? 0,
                        bytesPerSecond: 0,
                        attempt: 0
                      }
                    }
                  />
                </div>
              ) : null}

              {isApplying ? (
                <div className="mt-4 rounded-lg border border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
                  {t(
                    "Open Science is stopping background tasks and will close to finish installing. The update may take a moment; please don't reopen the app during this step. The updated app will reopen automatically."
                  )}
                </div>
              ) : null}

              {dialogStatus.error ? (
                <div className="mt-3" role="alert">
                  <p className="text-xs text-destructive">
                    {dialogStatus.error === UPDATE_BACKGROUND_PROCESS_ERROR
                      ? t('Could not stop background processes before updating. Please try again.')
                      : dialogStatus.error === UPDATE_BACKGROUND_PROCESS_DEGRADED_ERROR
                        ? t(
                            'Could not fully stop background processes before updating. Please try again.'
                          )
                        : dialogStatus.error === UPDATE_SETTINGS_INSTALL_ERROR
                          ? t(
                              'An Agent Runtime is still installing. Wait for it to finish before restarting to update.'
                            )
                          : (dialogStatus.error ?? t('Update failed'))}
                  </p>
                  {isBackgroundProcessError ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      <Trans
                        i18nKey="Cancel this update, then use Reveal in Settings → General → Diagnostics to locate the log file. Quit and reopen Open Science, then try the update again. If the problem returns, review the log for local file paths and give it to a developer or <issueLink>open a GitHub issue</issueLink>."
                        components={{
                          issueLink: (
                            <ExternalTextLink href={APP.links.githubIssues}>{''}</ExternalTextLink>
                          )
                        }}
                      />
                    </p>
                  ) : null}
                  {/* Fallback when the in-app update fails (e.g. a blocked/failed in-place install): let the
                    user grab the installer by hand, mirroring the macOS manual-reinstall path. */}
                  <ExternalTextLink href={APP.update.downloadPage} className="mt-1 text-xs">
                    {t('Download manually')}
                  </ExternalTextLink>
                </div>
              ) : null}
            </div>

            <div className={dialogFooterClassName}>
              <button
                type="button"
                onClick={() => closeDialog()}
                disabled={isApplying}
                className={cn(
                  dialogCancelButtonClassName,
                  'rounded-lg px-3 py-1.5 text-sm font-medium text-foreground transition-colors'
                )}
              >
                {isReady ? t('Close') : t('Cancel')}
              </button>
              {isApplying ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground opacity-70"
                >
                  <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                  {t('Preparing update…')}
                </button>
              ) : isReady ? (
                <button
                  type="button"
                  onClick={() => void apply()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {dialogStatus.applyKind === 'restart' ? (
                    <>
                      <RefreshCw className="size-4" aria-hidden="true" />
                      {t('Restart to update')}
                    </>
                  ) : (
                    <>
                      <ExternalLink className="size-4" aria-hidden="true" />
                      {t('Open installer')}
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void download()}
                  disabled={isDownloading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Download className="size-4" aria-hidden="true" />
                  {isDownloading
                    ? t('Downloading {{percent}}%', { percent: dialogStatus.progress ?? 0 })
                    : dialogStatus.totalBytes
                      ? t('Download update ({{size}})', {
                          size: formatBytes(dialogStatus.totalBytes)
                        })
                      : t('Download update')}
                </button>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}

export { UpdateDialog }
