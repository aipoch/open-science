import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'

type SwitchFrameworkDialogProps = {
  // Display name of the framework being switched to; null keeps the dialog closed.
  targetName: string | null
  onCancel: () => void
  onConfirm: () => void
}

// Confirms switching the active agent backend. A conversation can't be resumed on a different backend,
// so switching starts a fresh agent session; open conversations keep their messages and have their
// transcript replayed to the new backend, but live tool state is not carried over.
const SwitchFrameworkDialog = ({
  targetName,
  onCancel,
  onConfirm
}: SwitchFrameworkDialogProps): React.JSX.Element => {
  const dialogTargetName = useRetainedDialogValue(targetName)

  return (
    <AlertDialog.Root
      open={Boolean(targetName)}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <AlertDialog.Content
          className={dialogPanelClassName('z-[60] w-[min(440px,calc(100vw-2rem))]')}
        >
          <AlertDialog.Title className={dialogTitleClassName}>
            Switch to {dialogTargetName}?
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            A conversation can&apos;t be resumed on a different backend, so switching starts a fresh
            agent session. Open conversations keep their existing messages, and their transcript is
            replayed to {dialogTargetName} so it can pick up where you left off (tool state is not
            carried over). New conversations are unaffected.
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button type="button" onClick={onConfirm}>
                Switch
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { SwitchFrameworkDialog }
