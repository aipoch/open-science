import { useEffect, useRef, useState } from 'react'
import { flushComposerDrafts } from '@/pages/workspace/composer-draft-storage'
import * as AlertDialog from '@/components/ui/alert-dialog'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WebEventConnectionPhase } from '../../../shared/web-event-connection'
import { Button } from '@/components/ui/button'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type WebEventRecoveryDialogProps = {
  active: boolean
  phase: WebEventConnectionPhase
}

// Mount one timer per uninterrupted recovery episode; phase changes and higher-priority
// presentations must not restart it. Becoming live unmounts all recovery content immediately.
const WebEventRecoveryDialog = (props: WebEventRecoveryDialogProps): React.JSX.Element | null => {
  // This page has one initial connection; later interruptions must retain the current context.
  const [hasConnected, setHasConnected] = useState(props.phase === 'live')
  if (props.phase === 'live') {
    if (!hasConnected) setHasConnected(true)
    return null
  }
  return <WebEventRecovery {...props} initialConnection={!hasConnected} />
}

const WebEventRecovery = ({
  active,
  phase,
  initialConnection
}: WebEventRecoveryDialogProps & { initialConnection: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  // Capture before the App Shell makes the background inert in the same commit.
  const previousFocus = useRef(document.activeElement)
  const contentRef = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState({ failed: false, text: '', count: 0 })
  const [savedCopy, setSavedCopy] = useState(false)
  const [waitExpired, setWaitExpired] = useState(false)
  useEffect(() => {
    const timeout = window.setTimeout(() => setWaitExpired(true), 5000)
    return () => window.clearTimeout(timeout)
  }, [])
  useEffect(() => {
    if (!active) return
    const snapshot = flushComposerDrafts()
    let disposed = false
    queueMicrotask(() => {
      if (disposed) return
      setDrafts(snapshot)
      setSavedCopy(false)
    })
    return () => {
      disposed = true
    }
  }, [active, phase])
  const authorizationRequired = phase === 'authorization-required'
  const reloadRequired = phase === 'reload-required'
  const showDetails = waitExpired || authorizationRequired || reloadRequired
  const showStartupLogo = initialConnection && !showDetails
  const reloadAvailable = phase === 'reconnecting' || reloadRequired
  const title = authorizationRequired
    ? t('Pairing required')
    : phase === 'connecting'
      ? t('Connecting to Open-Science')
      : phase === 'reconnecting'
        ? t('Reconnecting to Open-Science')
        : phase === 'replaying'
          ? t('Restoring missed updates')
          : t('Reload required')
  const description = authorizationRequired
    ? t(
        'Access authorization has expired. Reopen the Web link from Open-Science on the host computer, or return to the remote access entry page to pair again.'
      )
    : reloadRequired
      ? t(
          'Open-Science could not restore a complete, current view. Reload this page to reconnect safely.'
        )
      : t(
          'Controls are paused while Open-Science restores updates that may have arrived during the interruption.'
        )

  return (
    <AlertDialog.Root open={active}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={
            showDetails
              ? dialogOverlayClassName
              : showStartupLogo
                ? 'fixed inset-0 z-50 bg-background'
                : 'fixed inset-0 z-50 bg-background/80'
          }
        />
        <AlertDialog.Content
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = previousFocus.current
            if (target instanceof HTMLElement && target.isConnected && !target.closest('[inert]')) {
              target.focus({ preventScroll: true })
            }
          }}
          role={showDetails ? 'alertdialog' : 'dialog'}
          className={
            showDetails
              ? dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')
              : 'fixed inset-0 z-50 flex items-center justify-center p-6 text-foreground outline-none'
          }
        >
          <div
            className={
              showDetails
                ? dialogHeaderClassName
                : showStartupLogo
                  ? 'flex flex-col items-center gap-14'
                  : undefined
            }
          >
            {showStartupLogo ? <OpenScienceLogoLoader /> : null}
            <AlertDialog.Title
              className={
                showDetails
                  ? dialogTitleClassName
                  : showStartupLogo
                    ? 'text-sm font-normal text-muted-foreground'
                    : 'text-sm font-normal'
              }
            >
              <span
                className="inline-flex items-center gap-2"
                role={showDetails ? undefined : 'status'}
              >
                {!showStartupLogo ? (
                  <RefreshCw
                    aria-hidden="true"
                    className={
                      reloadRequired || authorizationRequired ? 'size-4' : 'size-4 animate-spin'
                    }
                  />
                ) : null}
                {title}
              </span>
            </AlertDialog.Title>
          </div>
          <div className={showDetails ? dialogBodyClassName : 'sr-only'}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {description}
            </AlertDialog.Description>
            {showDetails ? (
              <>
                <p className="mt-3 break-all text-sm text-muted-foreground">
                  {t('Host')}: {window.location.host}
                </p>
                {!authorizationRequired ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t(
                      'If recovery keeps failing, check that Open-Science is running on the host computer and that both devices are connected. Save a copy of unsent drafts before leaving this page.'
                    )}
                  </p>
                ) : null}
                {drafts.count > 0 || drafts.failed ? (
                  <div className="mt-3 space-y-3 text-sm">
                    <p>
                      {drafts.failed
                        ? t('Draft storage is unavailable. Save a copy below before reloading.')
                        : t(
                            'Unsent drafts will be restored in this tab. Mentions return as text; check attachments before sending.'
                          )}
                    </p>
                    <label className="block" htmlFor="recovery-drafts">
                      {t('Unsent drafts')}
                    </label>
                    <textarea
                      id="recovery-drafts"
                      className="max-h-48 w-full rounded border p-2"
                      readOnly
                      value={drafts.text}
                      rows={5}
                    />
                    {drafts.failed ? (
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={savedCopy}
                          onChange={(event) => setSavedCopy(event.target.checked)}
                        />
                        {t('I saved a copy of my drafts.')}
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          {showDetails && reloadAvailable ? (
            <div className={dialogFooterClassName}>
              <Button
                type="button"
                disabled={drafts.failed && !savedCopy}
                onClick={() =>
                  previewLeaveGuards.requestAll(() => {
                    const latest = flushComposerDrafts()
                    if (latest.failed && (!savedCopy || latest.text !== drafts.text)) {
                      setDrafts(latest)
                      setSavedCopy(false)
                      return
                    }
                    // Let the confirmed editor discards commit before beforeunload runs.
                    window.setTimeout(() => window.location.reload(), 0)
                  })
                }
              >
                <RefreshCw aria-hidden="true" />
                {t('Reload', { context: 'window', ns: 'common' })}
              </Button>
            </div>
          ) : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { WebEventRecoveryDialog }
