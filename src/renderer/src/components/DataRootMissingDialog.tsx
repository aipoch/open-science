import { AlertDialog } from 'radix-ui'
import { FolderInput, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'

type DataRootMissingDialogProps = {
  open: boolean
  dataRoot: string
  // Called once the situation is resolved: the folder reconnected, or the user chose to continue
  // with an empty one. "Choose another location" instead relaunches the app via IPC and never
  // calls this.
  onResolved: () => void
}

// Startup guard for design §20.4: settings.dataRoot points at a folder that no longer exists
// (deleted, or an unmounted external/network drive). Non-dismissable by outside click/Escape -
// no onOpenChange is wired, so the dialog only closes via one of its three explicit actions.
const DataRootMissingDialog = ({
  open,
  dataRoot,
  onResolved
}: DataRootMissingDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [isRetrying, setIsRetrying] = useState(false)
  const [stillMissing, setStillMissing] = useState(false)
  const [isChoosing, setIsChoosing] = useState(false)
  const [isAcceptingEmpty, setIsAcceptingEmpty] = useState(false)
  const [operationError, setOperationError] = useState<string | undefined>(undefined)
  const dialogDataRoot = useRetainedDialogValue(open ? dataRoot : undefined) ?? dataRoot
  const isRemoteWebSurface =
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'remote'

  const handleRetry = async (): Promise<void> => {
    setIsRetrying(true)
    setStillMissing(false)
    setOperationError(undefined)
    try {
      const info = await window.api.storage.getInfo()
      if (info.dataRootMissing) {
        setStillMissing(true)
        return
      }
      onResolved()
    } catch {
      setOperationError(t('Could not check the data folder. Try again.'))
    } finally {
      setIsRetrying(false)
    }
  }

  const handleChooseAnotherLocation = async (): Promise<void> => {
    setOperationError(undefined)
    let relaunchRequested = false
    try {
      const picked = await window.api.storage.pickDirectory()
      if (!picked) return

      setIsChoosing(true)
      const inspection = await window.api.storage.inspectDataRoot(picked)
      if (inspection.kind !== 'move' && inspection.kind !== 'adopt') {
        setOperationError(inspection.error ?? t('The selected folder is not usable.'))
        return
      }

      // Both 'move' (empty - nothing to move, the old data is gone) and 'adopt' (already has our
      // data) apply as a plain pointer switch + relaunch; this is recovery, not onboarding.
      const result = await window.api.storage.setDataRootAndRelaunch(picked, false)
      if (!result.ok) {
        setOperationError(result.error ?? t('Could not switch to this folder.'))
        return
      }
      // app.quit() can return while teardown is still in progress. Keep every action disabled so
      // the user cannot submit a competing data-root change before the renderer exits.
      relaunchRequested = true
    } catch {
      setOperationError(t('Could not switch to this folder.'))
    } finally {
      if (!relaunchRequested) setIsChoosing(false)
    }
  }

  const handleContinueWithEmpty = async (): Promise<void> => {
    setIsAcceptingEmpty(true)
    setOperationError(undefined)
    try {
      // Older protocol-v1 Main processes predate the explicit write gate and do not expose this
      // RPC. Preserve their original renderer-only resolution path while requiring acceptance on
      // every Main version that advertises the command.
      if (typeof window.api.storage.acceptMissingDataRoot === 'function') {
        await window.api.storage.acceptMissingDataRoot()
      }
      onResolved()
    } catch {
      setOperationError(t('Could not continue with an empty folder. Try again.'))
    } finally {
      setIsAcceptingEmpty(false)
    }
  }

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Data folder not found')}
            </AlertDialog.Title>
          </div>

          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              <Trans
                i18nKey="Your data folder <path>{{path}}</path> can't be found. It may have been deleted, or it's on a drive that isn't connected."
                values={{ path: dialogDataRoot }}
                components={{ path: <span className="font-mono" /> }}
              />
            </AlertDialog.Description>

            {stillMissing ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {isRemoteWebSurface
                  ? t('Still not found. Reconnect the drive and try again.')
                  : t(
                      'Still not found. Reconnect the drive and try again, or choose another location.'
                    )}
              </p>
            ) : null}

            {operationError ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {operationError}
              </p>
            ) : null}
          </div>

          <div className={cn(dialogFooterClassName, 'flex-col items-stretch')}>
            <Button
              type="button"
              disabled={isRetrying || isChoosing || isAcceptingEmpty}
              onClick={() => void handleRetry()}
            >
              <RefreshCw aria-hidden="true" />
              {isRetrying ? t('Checking…') : t('Reconnect & retry')}
            </Button>
            {!isRemoteWebSurface ? (
              <Button
                type="button"
                variant="outline"
                disabled={isRetrying || isChoosing || isAcceptingEmpty}
                onClick={() => void handleChooseAnotherLocation()}
              >
                <FolderInput aria-hidden="true" />
                {isChoosing ? t('Switching…') : t('Choose another location')}
              </Button>
            ) : null}
            {!isRemoteWebSurface ? (
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isRetrying || isChoosing || isAcceptingEmpty}
                  onClick={() => void handleContinueWithEmpty()}
                >
                  {t('Continue with an empty folder')}
                </Button>
              </AlertDialog.Cancel>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {isRemoteWebSurface
                ? t(
                    'To choose another location or continue with an empty folder, use Open Science on the home computer.'
                  )
                : t(
                    "Open Science will recreate the folder as you use it. Files from the old location won't be available until it's reconnected."
                  )}
            </p>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DataRootMissingDialog }
