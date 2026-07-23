import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
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
  'border-border bg-card text-foreground hover:bg-muted hover:text-foreground'

const renameDialogInputClassName =
  'h-9 rounded-lg border-border bg-card px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25'

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
      <Dialog.Overlay className={dialogOverlayClassName} />
      <Dialog.Content
        onInteractOutside={(event) => event.preventDefault()}
        className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))]')}
      >
        <form onSubmit={onConfirmRename}>
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>Rename session</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                Update the name shown in the session list.
              </Dialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className={dialogCloseButtonClassName}
              onClick={onCancel}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-4">
            <Input
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              aria-label="Session name"
              autoFocus
              className={renameDialogInputClassName}
            />
          </div>
          <div className={dialogFooterClassName}>
            <Button
              type="button"
              variant="outline"
              className={renameDialogCancelButtonClassName}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={renameDraft.trim().length === 0}>
              Rename
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)

export { RenameSessionDialog }
