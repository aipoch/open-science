import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../shared/app-config'
import { formatBytes, type ManualInstallInfo, type UpdateStatus } from '../../../shared/update'

type VisibleInfo = Exclude<ManualInstallInfo, { kind: 'blocked' }>
const targetIdentity = (status: UpdateStatus): string =>
  `${status.current}:${status.latest}:${status.state}:${status.manualInstall?.identity}:${status.localPath}:${status.artifactSha512}:${status.manualInstall?.kind === 'blocked' ? 'blocked' : 'eligible'}`

// Main owns eligibility and file access. This view only accepts replies for the currently displayed
// artifact, and a synchronous lock coalesces pointer/keyboard requests before React renders busy.
type ManualUpdatePresentation = {
  visible: boolean
  back: () => boolean
  title: string
  entry: React.JSX.Element | null
  body: React.JSX.Element
  footer: React.JSX.Element
}
export const useManualUpdateInstall = (
  status: UpdateStatus,
  open: boolean
): ManualUpdatePresentation => {
  const { t } = useTranslation()
  const identity = targetIdentity(status)
  const [view, setView] = useState<{ identity: string; info?: VisibleInfo; error?: boolean }>()
  const [checking, setChecking] = useState(false)
  const [newDownload, setNewDownload] = useState(false)
  const [scope, setScope] = useState({ identity, open })
  // Reset transient navigation when its owning dialog or artifact changes. This conditional render
  // adjustment prevents a stale instruction page from flashing when the same dialog is reopened.
  if (scope.identity !== identity || scope.open !== open) {
    setScope({ identity, open })
    setChecking(false)
    setView(undefined)
    setNewDownload(false)
  }
  const pending = useRef(false)
  const generation = useRef(0)
  const entry = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const visible = Boolean(
    open && status.manualInstall?.kind !== 'blocked' && view?.identity === identity
  )
  const visibleRef = useRef(visible)
  useLayoutEffect(() => {
    visibleRef.current = visible
  }, [visible])
  useLayoutEffect(() => {
    generation.current += 1
    pending.current = false
    return () => {
      generation.current += 1
    }
  }, [identity, open])
  useEffect(() => {
    if (visible) backButton.current?.focus()
  }, [visible])
  const back = (): boolean => {
    if (!visibleRef.current) return false
    visibleRef.current = false
    generation.current += 1
    pending.current = false
    setChecking(false)
    setView(undefined)
    setNewDownload(false)
    requestAnimationFrame(() => entry.current?.focus())
    return true
  }
  const eligible = status.manualInstall && status.manualInstall.kind !== 'blocked'
  const run = async (reveal: boolean): Promise<void> => {
    if (pending.current || !eligible) return
    pending.current = true
    setChecking(true)
    const revision = generation.current
    if (!reveal) {
      setNewDownload(false)
      setView({ identity })
    }
    try {
      const info = await (reveal
        ? window.api.update.revealManualInstaller()
        : window.api.update.getManualInstall())
      if (
        revision !== generation.current ||
        targetIdentity(useUpdateStore.getState().status) !== identity
      )
        return
      if (info.kind === 'blocked' || info.identity !== status.manualInstall?.identity) {
        setView(undefined)
        return
      }
      setView({ identity, info })
    } catch {
      if (revision === generation.current)
        setView((previous) => ({ ...previous, identity, error: true }))
    } finally {
      if (revision === generation.current) {
        pending.current = false
        setChecking(false)
      }
    }
  }
  const info = view?.info
  const local = info?.kind === 'local' && !newDownload ? info : undefined
  const platform = info?.platform ?? status.manualInstall?.platform
  const format =
    info?.format ??
    (status.manualInstall?.kind !== 'blocked' ? status.manualInstall?.format : undefined)
  const revealLabel =
    platform === 'darwin'
      ? t('Show in Finder')
      : platform === 'win32'
        ? t('Show in File Explorer')
        : t('Show in file manager')
  const first = local
    ? platform === 'darwin'
      ? format === 'zip'
        ? [
            t('Find and unpack the update'),
            t(
              'Click Show in Finder below, then double-click the selected ZIP to unpack Open-Science.app. Keep the Finder window open.'
            )
          ]
        : [
            t('Find the downloaded installer'),
            t('Click Show in Finder below. Keep the window open with the DMG file selected.')
          ]
      : platform === 'win32'
        ? [
            t('Find the downloaded installer'),
            t(
              'Click Show in File Explorer below. Keep the window open with the setup file selected.'
            )
          ]
        : format === 'deb'
          ? [
              t('Find the downloaded package'),
              t(
                'Click Show in file manager below. Keep the window open with the DEB file selected.'
              )
            ]
          : [
              t('Find the downloaded AppImage'),
              t(
                'Click Show in file manager below. Keep the window open with the AppImage selected.'
              )
            ]
    : [
        t('Download the full installer'),
        platform === 'darwin'
          ? t(
              'Click Download from website below to get the macOS DMG. Wait for the download to finish.'
            )
          : platform === 'win32'
            ? t(
                'Click Download from website below to get the Windows setup file. Wait for the download to finish.'
              )
            : format === 'deb'
              ? t(
                  'Click Download from website below to get the Linux DEB package. Wait for the download to finish.'
                )
              : t(
                  'Click Download from website below to get the Linux AppImage. Wait for the download to finish.'
                )
      ]
  const quit = [
    t('Quit Open-Science'),
    platform === 'darwin'
      ? t(
          'Save your work and stop running tasks. Choose Open-Science → Quit Open-Science from the menu bar (⌘ Q).'
        )
      : t(
          'Save your work and stop running tasks. Choose Quit from the Open-Science tray icon menu.'
        )
  ]
  const install =
    platform === 'darwin'
      ? [
          t('Replace the app and reopen it'),
          local && format === 'zip'
            ? t(
                'Drag the unpacked Open-Science.app to Applications in the Finder sidebar. Choose Replace when asked, then open Open-Science from Applications.'
              )
            : t(
                'Open the downloaded DMG. Drag Open-Science onto Applications and choose Replace when asked. Then open Open-Science from Applications.'
              )
        ]
      : platform === 'win32'
        ? [
            t('Run setup and reopen the app'),
            t(
              'Double-click the setup file, follow the installer, and keep the existing installation location. Open Open-Science when setup finishes.'
            )
          ]
        : format === 'deb'
          ? [
              t('Install the package and reopen'),
              t(
                'Open the DEB in your system software installer. Choose Install or Upgrade and follow the prompts. Then reopen Open-Science.'
              )
            ]
          : [
              t('Replace the AppImage and reopen'),
              t(
                'Move the new AppImage to the folder where you keep Open-Science and replace the old file. Allow it to run as a program in file properties if needed, then open it.'
              )
            ]
  return {
    visible,
    back,
    title: local ? t('Install manually') : t('Download the full installer'),
    entry: eligible ? (
      <button
        ref={entry}
        type="button"
        onClick={() => void run(false)}
        disabled={checking}
        className="mt-2 block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {status.manualInstall?.kind === 'local'
          ? t('Install manually…')
          : status.manualInstall?.kind === 'website' &&
              status.manualInstall.reason === 'download-failed'
            ? t('Download manually…')
            : t('Get the full installer…')}
      </button>
    ) : null,
    body: (
      <div className="space-y-5 text-sm" aria-busy={checking}>
        {checking ? <p role="status">{t('Checking installer…')}</p> : null}
        {view?.error || (info?.kind === 'local' && info.revealError) ? (
          <ErrorNotice
            inline
            role="alert"
            level="warning"
            description={t('Could not show the installer. Try again.')}
          />
        ) : null}
        {info ? (
          <>
            <p className="text-xs text-muted-foreground">
              {platform === 'darwin' ? 'macOS' : platform === 'win32' ? t('Windows') : t('Linux')}
              {' · '}
              {info.arch}
            </p>
            <p>
              {local
                ? t(
                    'Your complete update is ready. Read the steps below before quitting Open-Science.'
                  )
                : newDownload
                  ? t('Get a fresh full installer from the official website.')
                  : info.kind === 'website' && info.reason === 'not-standalone'
                    ? t(
                        'The downloaded update can’t be installed on its own. Get the full installer from the official website.'
                      )
                    : t(
                        'There isn’t a complete, verified installer available on this computer. Get the full installer from the official website.'
                      )}
            </p>
            {local ? (
              <div className="min-w-0 border-y border-border py-3">
                <p className="break-words [overflow-wrap:anywhere]">{local.fileName}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {local.version ? `v${local.version} · ` : ''}
                  {formatBytes(local.size)}
                  {' · '}
                  {t('Verified · Ready for manual installation')}
                </p>
              </div>
            ) : null}
            <ol className="space-y-5">
              {[first, quit, install].map(([title, description], index) => (
                <li key={index} className="flex gap-3">
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div>
                    <strong className="font-medium">{title}</strong>
                    <p className="mt-1 text-muted-foreground">{description}</p>
                  </div>
                </li>
              ))}
            </ol>
            {local ? (
              <button
                type="button"
                disabled={checking}
                onClick={() => setNewDownload(true)}
                className="text-xs text-muted-foreground underline underline-offset-4"
              >
                {t('Use a new download instead')}
              </button>
            ) : null}
          </>
        ) : !checking ? (
          <Button variant="outline" onClick={() => void run(false)}>
            {t('Retry')}
          </Button>
        ) : null}
      </div>
    ),
    footer: (
      <>
        <Button ref={backButton} variant="ghost" onClick={back}>
          {t('Back to update')}
        </Button>
        {local ? (
          <Button disabled={checking} onClick={() => void run(true)}>
            {revealLabel}
          </Button>
        ) : info ? (
          <ExternalTextLink href={APP.update.downloadPage}>
            {t('Download from website')}
          </ExternalTextLink>
        ) : (
          <Button disabled>{t('Checking installer…')}</Button>
        )}
      </>
    )
  }
}
