import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { APP } from '../../../shared/app-config'
import type { UpdateInstaller, UpdateStatus } from '../../../shared/update'
import type { ManualUpdateController } from './use-manual-update'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { ExternalTextLink } from './ExternalTextLink'
import { ErrorNotice } from './error-notice'
import { dialogHeaderClassName, dialogTitleClassName } from './ui/dialog-chrome'

const textLink =
  'cursor-pointer rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

type ManualUpdate = ManualUpdateController

const useRevealLabel = (installer: UpdateInstaller | null): string => {
  const { t } = useTranslation()
  const platform = installer?.platform ?? window.api?.platform
  return platform === 'darwin'
    ? t('Show in Finder')
    : platform === 'win32'
      ? t('Show in File Explorer')
      : t('Show in file manager')
}

export const ManualUpdateLinks = ({
  manual,
  align = 'end'
}: {
  manual: ManualUpdate
  align?: 'start' | 'end'
}): React.JSX.Element => {
  const { t } = useTranslation()
  const revealLabel = useRevealLabel(manual.installer)
  return (
    <div data-testid="manual-update-links" className="min-w-0">
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground',
          align === 'end' ? 'justify-end text-right' : 'justify-start text-left'
        )}
      >
        {manual.installer ? (
          <button
            type="button"
            className={cn(textLink, 'min-h-8')}
            onClick={() => void manual.reveal()}
          >
            {revealLabel}
          </button>
        ) : null}
        <ExternalTextLink
          href={APP.update.downloadPage}
          className="min-h-8 text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('Download from website')}
        </ExternalTextLink>
        <button
          type="button"
          className={cn(textLink, 'min-h-8')}
          onClick={manual.openGuide}
          data-manual-update-origin={`${manual.originId}-links`}
        >
          {t('Installation instructions')}
        </button>
      </div>
      {manual.feedback ? (
        <ErrorNotice inline role="alert" description={manual.feedback} className="mt-1 text-xs" />
      ) : null}
    </div>
  )
}

export const ManualUpdateFailure = ({
  manual,
  status
}: {
  manual: ManualUpdate
  status: UpdateStatus
}): React.JSX.Element => {
  const { t } = useTranslation()
  const r = status.recovery
  const pending =
    status.state === 'applying' || r?.installation === 'pending' || r?.installation === 'unknown'
  const preparing =
    status.reason === 'install-failed' &&
    r?.phase === 'preparing' &&
    r.runtime === 'running' &&
    r.installation === 'unchanged'
  return (
    <p className="mt-2 text-xs leading-5 text-muted-foreground">
      {pending
        ? t('An installer may still be running. Wait before installing manually.') + ' '
        : null}
      {preparing ? t('Save your work before updating manually.') + ' ' : null}
      {manual.installer ? (
        <Trans
          i18nKey="You can <packageAction>locate the downloaded package</packageAction> and follow the <instructionsAction>installation instructions</instructionsAction>."
          components={{
            packageAction: (
              <button type="button" className={textLink} onClick={() => void manual.reveal()} />
            ),
            instructionsAction: (
              <button
                type="button"
                className={textLink}
                onClick={manual.openGuide}
                data-manual-update-origin={`${manual.originId}-failure`}
              />
            )
          }}
        />
      ) : (
        <Trans
          i18nKey="You can <websiteAction>download from the website</websiteAction> and follow the <instructionsAction>installation instructions</instructionsAction>."
          components={{
            websiteAction: <ExternalTextLink href={APP.update.downloadPage}>{''}</ExternalTextLink>,
            instructionsAction: (
              <button
                type="button"
                className={textLink}
                onClick={manual.openGuide}
                data-manual-update-origin={`${manual.originId}-failure`}
              />
            )
          }}
        />
      )}
    </p>
  )
}

export const ManualUpdateGuide = ({
  manual,
  status,
  backLabel,
  onBack
}: {
  manual: ManualUpdate
  status: UpdateStatus
  backLabel?: string
  onBack?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const back = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    back.current?.focus()
  }, [])
  const installer = manual.installer
  const platform = installer?.platform ?? window.api?.platform
  // Without a confirmed package, describe the formats published on the official download page.
  const format =
    installer?.format ??
    (platform === 'darwin'
      ? 'dmg'
      : platform === 'win32'
        ? 'exe'
        : platform === 'linux'
          ? 'deb'
          : 'unknown')
  const revealLabel = useRevealLabel(installer)
  const installStep = (packageFormat: UpdateInstaller['format']): string => {
    switch (packageFormat) {
      case 'dmg':
        return t(
          'Open the DMG. Drag Open-Science to Applications and choose Replace. Open it from Applications.'
        )
      case 'zip':
        return t(
          'Unzip the file. Drag Open-Science to Applications and choose Replace. Open it from Applications.'
        )
      case 'exe':
        return t(
          'Run the installer and keep the existing installation folder. Open Open-Science when installation is complete.'
        )
      case 'deb':
        return t(
          'Open the DEB with your system’s software installer. Install the update, then open Open-Science.'
        )
      case 'appimage':
        return t(
          'Replace the existing AppImage with the new file. Allow it to run as a program if required, then open it.'
        )
      default:
        return t(
          'Follow the instructions for your package on the official download page, then reopen Open-Science.'
        )
    }
  }
  const unknown =
    status.recovery?.installation === 'unknown' || status.recovery?.installation === 'pending'
  return (
    <div data-manual-update-guide className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className={cn(dialogHeaderClassName, 'justify-start')}>
        <Button
          ref={back}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={backLabel ?? t('Back to update')}
          onClick={onBack ?? manual.closeGuide}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <h2 className={cn(dialogTitleClassName, 'text-base')}>{t('Installation instructions')}</h2>
        <p className="ml-auto shrink-0 text-xs text-muted-foreground">
          {platform === 'darwin'
            ? 'macOS'
            : platform === 'win32'
              ? t('Windows')
              : platform === 'linux'
                ? t('Linux')
                : null}
        </p>
      </header>
      {unknown || status.state === 'applying' ? (
        <p role="status" className="shrink-0 bg-muted px-5 py-3 text-xs text-muted-foreground">
          {unknown
            ? t('An installer may still be running. Wait before installing manually.')
            : t('Update in progress. Wait before installing manually.')}
        </p>
      ) : null}
      <div className="min-h-0 overflow-y-auto overscroll-contain p-5 text-[13px] leading-relaxed text-muted-foreground">
        {manual.feedback ? (
          <ErrorNotice role="alert" inline description={manual.feedback} className="mb-4" />
        ) : null}
        <ol className="list-decimal space-y-6 pl-5 marker:text-muted-foreground [&>li]:pl-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground [&_p]:mt-1.5">
          <li>
            <h3>{installer ? t('Locate the downloaded package') : t('Download the installer')}</h3>
            {installer ? (
              <>
                <p className="break-all text-xs">{installer.fileName}</p>
                <p>{t('Keep the installer folder open when you quit.')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void manual.reveal()}
                >
                  {revealLabel}
                </Button>
              </>
            ) : (
              <>
                <p>{t('Choose the installer for your computer.')}</p>
                <ExternalTextLink href={APP.update.downloadPage} className="mt-3">
                  {t('Download from website')}
                </ExternalTextLink>
              </>
            )}
          </li>
          <li>
            <h3>{t('Quit Open-Science')}</h3>
            <p>
              {platform === 'darwin'
                ? t(
                    'Save your work and finish or stop running tasks. Choose Open-Science → Quit Open-Science (⌘Q). Closing the window does not quit the app.'
                  )
                : platform === 'win32'
                  ? t(
                      'Save your work and finish or stop running tasks. Choose Quit from the Open-Science tray menu. Closing the window does not quit the app.'
                    )
                  : t(
                      'Save your work and finish or stop running tasks, then quit Open-Science completely. Make sure the app has exited before replacing its files.'
                    )}
            </p>
          </li>
          <li>
            <h3>{t('Install and reopen')}</h3>
            <p>{installStep(format)}</p>
            <p>{t('Check the version in Settings → General → About after reopening.')}</p>
          </li>
        </ol>
        {installer ? (
          <details className="mt-6 border-t border-border pt-4 text-xs">
            <summary className={cn(textLink, 'w-fit')}>
              {platform === 'darwin' && format === 'zip'
                ? t('For a website download (DMG)')
                : t('Download another installer')}
            </summary>
            <ExternalTextLink href={APP.update.downloadPage} className="mt-3">
              {t('Download from website')}
            </ExternalTextLink>
            {platform === 'darwin' && format === 'zip' ? (
              <p className="mt-2">{installStep('dmg')}</p>
            ) : null}
            {platform === 'linux' ? (
              <p className="mt-2">
                {t('For an AppImage, use the GitHub Releases linked on the download page.')}
              </p>
            ) : null}
          </details>
        ) : platform === 'linux' ? (
          <p className="mt-4 text-xs">
            {t('For an AppImage, use the GitHub Releases linked on the download page.')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
