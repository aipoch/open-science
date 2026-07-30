import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'

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
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { Project } from '../../../../shared/projects'

type DeleteProjectDialogProps = {
  project: Project | undefined
  sessionCount: number
  hasCompleteSessionCatalog: boolean
  canDelete: boolean
  onCancel: () => void
  onConfirmDelete: () => void
}

const deleteDialogConfirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

// Destructive deletion requires confirmation; the project's sessions are removed with it, artifacts stay.
const DeleteProjectDialog = ({
  project,
  sessionCount,
  hasCompleteSessionCatalog,
  canDelete,
  onCancel,
  onConfirmDelete
}: DeleteProjectDialogProps): React.JSX.Element => {
  const dialogProject = useRetainedDialogValue(project)
  const dialogSessionCount =
    useRetainedDialogValue(project ? sessionCount : undefined) ?? sessionCount
  const dialogHasCompleteSessionCatalog =
    useRetainedDialogValue(project ? hasCompleteSessionCatalog : undefined) ??
    hasCompleteSessionCatalog

  return (
    <AlertDialog.Root
      open={Boolean(project)}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                Delete project?
              </AlertDialog.Title>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                This will permanently delete &quot;{dialogProject?.name}&quot;
                {dialogHasCompleteSessionCatalog
                  ? dialogSessionCount > 0
                    ? ` and its ${dialogSessionCount} ${dialogSessionCount === 1 ? 'session' : 'sessions'}`
                    : ''
                  : ' and all of its saved conversations, including any that could not be loaded during recovery'}
                . Generated artifacts remain on disk. This action cannot be undone.
              </AlertDialog.Description>
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
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                className={deleteDialogConfirmButtonClassName}
                disabled={!canDelete}
                onClick={onConfirmDelete}
              >
                Delete
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DeleteProjectDialog }
