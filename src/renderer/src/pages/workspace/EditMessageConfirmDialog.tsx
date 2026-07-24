import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type EditMessageConfirmDialogProps = {
  open: boolean
  subsequentTurns: number
  onCancel: () => void
  onConfirm: () => void
}

const cancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'
const confirmButtonClassName =
  'border-transparent bg-amber-500 text-white hover:bg-amber-500/90 hover:text-white'

// Confirms the destructive half of an inline edit: the turns after the edited message are
// permanently dropped before the adjusted prompt is resent.
const EditMessageConfirmDialog = ({
  open,
  subsequentTurns,
  onCancel,
  onConfirm
}: EditMessageConfirmDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={open}
    onOpenChange={(nextOpen) => {
      if (!nextOpen) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className={dialogOverlayClassName} />
      <AlertDialog.Content className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))]')}>
        <AlertDialog.Title className={dialogTitleClassName}>
          Resend and overwrite later turns?
        </AlertDialog.Title>
        <AlertDialog.Description className={dialogDescriptionClassName}>
          Sending this edited prompt will overwrite the {subsequentTurns}{' '}
          {subsequentTurns === 1 ? 'turn' : 'turns'} that follow it in this conversation. This
          action cannot be undone.
        </AlertDialog.Description>
        <div className={dialogFooterClassName}>
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="outline" className={cancelButtonClassName}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button type="button" className={confirmButtonClassName} onClick={onConfirm}>
              Overwrite and resend
            </Button>
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

export { EditMessageConfirmDialog }
