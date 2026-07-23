import { AlertDialog } from 'radix-ui'
import { FolderInput, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

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
  const [isRetrying, setIsRetrying] = useState(false)
  const [stillMissing, setStillMissing] = useState(false)
  const [isChoosing, setIsChoosing] = useState(false)
  const [chooseError, setChooseError] = useState<string | undefined>(undefined)

  const handleRetry = async (): Promise<void> => {
    setIsRetrying(true)
    setStillMissing(false)
    const info = await window.api.storage.getInfo()
    setIsRetrying(false)
    if (info.dataRootMissing) {
      setStillMissing(true)
      return
    }
    onResolved()
  }

  const handleChooseAnotherLocation = async (): Promise<void> => {
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return

    setIsChoosing(true)
    setChooseError(undefined)

    const inspection = await window.api.storage.inspectDataRoot(picked)
    if (inspection.kind === 'invalid') {
      setIsChoosing(false)
      setChooseError(inspection.error ?? 'The selected folder is not usable.')
      return
    }

    // Both 'move' (empty - nothing to move, the old data is gone) and 'adopt' (already has our
    // data) apply as a plain pointer switch + relaunch; this is recovery, not onboarding.
    const result = await window.api.storage.setDataRootAndRelaunch(picked, false)
    if (!result.ok) {
      setIsChoosing(false)
      setChooseError(result.error ?? 'Could not switch to this folder.')
    }
    // On success the app relaunches; nothing left to update here.
  }

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))]')}>
          <AlertDialog.Title className={dialogTitleClassName}>
            Data folder not found
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            Your data folder <span className="font-mono">{dataRoot}</span> can&apos;t be found. It
            may have been deleted, or it&apos;s on a drive that isn&apos;t connected.
          </AlertDialog.Description>

          {stillMissing ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              Still not found. Reconnect the drive and try again, or choose another location.
            </p>
          ) : null}

          {chooseError ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {chooseError}
            </p>
          ) : null}

          <div className="mt-6 flex flex-col gap-2">
            <Button
              type="button"
              disabled={isRetrying || isChoosing}
              onClick={() => void handleRetry()}
            >
              <RefreshCw aria-hidden="true" />
              {isRetrying ? 'Checking…' : 'Reconnect & retry'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isRetrying || isChoosing}
              onClick={() => void handleChooseAnotherLocation()}
            >
              <FolderInput aria-hidden="true" />
              {isChoosing ? 'Switching…' : 'Choose another location'}
            </Button>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={isRetrying || isChoosing}
                onClick={onResolved}
              >
                Continue with an empty folder
              </Button>
            </AlertDialog.Cancel>
            <p className="text-xs text-muted-foreground">
              Open Science will recreate the folder as you use it. Files from the old location
              won&apos;t be available until it&apos;s reconnected.
            </p>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DataRootMissingDialog }
