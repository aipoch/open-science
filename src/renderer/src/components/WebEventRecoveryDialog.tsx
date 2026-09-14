import { useEffect, useState } from 'react'
import { flushComposerDrafts } from '@/pages/workspace/composer-draft-storage'
import { AlertDialog } from 'radix-ui'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WebEventConnectionPhase } from '../../../shared/web-event-connection'
import { Button } from '@/components/ui/button'
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

const WebEventRecoveryDialog = ({
  active,
  phase
}: WebEventRecoveryDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState({ failed: false, text: '', count: 0 })
  const [savedCopy, setSavedCopy] = useState(false)
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
  const reloadAvailable = phase === 'reconnecting' || reloadRequired
  const title = authorizationRequired
    ? t('Pairing required')
    : phase === 'connecting'
      ? t('Connecting to Open Science')
      : phase === 'reconnecting'
        ? t('Reconnecting to Open Science')
        : phase === 'replaying'
          ? t('Restoring missed updates')
          : t('Reload required')
  const description = authorizationRequired
    ? t(
        'Access authorization has expired. Reopen the Web link from Open Science on the host computer, or return to the remote access entry page to pair again.'
      )
    : reloadRequired
      ? t(
          'Open Science could not restore a complete, current view. Reload this page to reconnect safely.'
        )
      : t(
          'Controls are paused while Open Science restores updates that may have arrived during the interruption.'
        )

  return (
    <AlertDialog.Root open={active}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              <span className="inline-flex items-center gap-2">
                <RefreshCw
                  aria-hidden="true"
                  className={
                    reloadRequired || authorizationRequired ? 'size-4' : 'size-4 animate-spin'
                  }
                />
                {title}
              </span>
            </AlertDialog.Title>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {description}
            </AlertDialog.Description>
            <p className="mt-3 break-all text-sm text-muted-foreground">
              {t('Host')}: {window.location.host}
            </p>
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
          </div>
          {reloadAvailable ? (
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
