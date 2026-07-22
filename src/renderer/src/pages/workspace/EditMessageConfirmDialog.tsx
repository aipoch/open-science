import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'

type EditMessageConfirmDialogProps = {
  open: boolean
  subsequentTurns: number
  onCancel: () => void
  onConfirm: () => void
}

const cancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'
const confirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

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
      <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
        <AlertDialog.Title className="text-base font-semibold text-text-000">
          Resend and overwrite later turns?
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
          Sending this edited prompt will overwrite the {subsequentTurns}{' '}
          {subsequentTurns === 1 ? 'turn' : 'turns'} that follow it in this conversation. This
          action cannot be undone.
        </AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-2">
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
