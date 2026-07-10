import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'

type ProviderSwitchDialogProps = {
  open: boolean
  // Number of sessions with an in-flight turn that would be interrupted by the switch.
  runningCount: number
  onCancel: () => void
  onConfirm: () => void
}

const switchDialogCancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'

const switchDialogConfirmButtonClassName =
  'border-transparent bg-text-000 text-bg-000 hover:bg-text-100 hover:text-bg-000'

// Confirms interrupting in-flight turns before switching the active provider. The interrupted turn is
// not resumed automatically; the user continues by sending a new message afterward.
const ProviderSwitchDialog = ({
  open,
  runningCount,
  onCancel,
  onConfirm
}: ProviderSwitchDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={open}
    onOpenChange={(next) => {
      if (!next) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
        <AlertDialog.Title className="text-base font-semibold text-text-000">
          Switch active provider?
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
          {runningCount === 1
            ? 'A session is currently running. Switching will interrupt the in-progress turn. You can continue that conversation afterward by sending a new message.'
            : `${runningCount} sessions are currently running. Switching will interrupt their in-progress turns. You can continue those conversations afterward by sending a new message.`}
        </AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="outline" className={switchDialogCancelButtonClassName}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button
              type="button"
              className={switchDialogConfirmButtonClassName}
              onClick={onConfirm}
            >
              Interrupt and switch
            </Button>
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

export { ProviderSwitchDialog }
