import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'

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
}: SwitchFrameworkDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={Boolean(targetName)}
    onOpenChange={(open) => {
      if (!open) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 text-foreground shadow-menu">
        <AlertDialog.Title className="text-base font-semibold text-foreground">
          Switch to {targetName}?
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
          A conversation can&apos;t be resumed on a different backend, so switching starts a fresh
          agent session. Open conversations keep their existing messages, and their transcript is
          replayed to {targetName} so it can pick up where you left off (tool state is not carried
          over). New conversations are unaffected.
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

export { SwitchFrameworkDialog }
