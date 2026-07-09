import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ChatSession } from '@/stores/session-store'

type RenameSessionDialogProps = {
  session: ChatSession | undefined
  renameDraft: string
  onRenameDraftChange: (value: string) => void
  onCancel: () => void
  onConfirmRename: (event: React.FormEvent<HTMLFormElement>) => void
}

const renameDialogCancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'

const renameDialogConfirmButtonClassName =
  'border-transparent bg-text-000 text-bg-000 hover:bg-text-100 hover:text-bg-000'

const renameDialogInputClassName =
  'h-9 rounded-lg border-border-200 bg-bg-000 px-3 text-sm text-text-000 shadow-none placeholder:text-text-100 focus-visible:border-border-200 focus-visible:ring-2 focus-visible:ring-border-200/25'

// Rename dialog updates only the session title; messages and run status stay untouched.
const RenameSessionDialog = ({
  session,
  renameDraft,
  onRenameDraftChange,
  onCancel,
  onConfirmRename
}: RenameSessionDialogProps): React.JSX.Element => (
  <Dialog.Root
    open={Boolean(session)}
    onOpenChange={(open) => {
      if (open) return

      onCancel()
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
        <form onSubmit={onConfirmRename}>
          <Dialog.Title className="text-base font-semibold text-text-000">
            Rename session
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
            Update the name shown in the session list.
          </Dialog.Description>
          <div className="mt-4">
            <Input
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              aria-label="Session name"
              autoFocus
              className={renameDialogInputClassName}
            />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className={renameDialogCancelButtonClassName}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={renameDraft.trim().length === 0}
              className={renameDialogConfirmButtonClassName}
            >
              Rename
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)

export { RenameSessionDialog }
