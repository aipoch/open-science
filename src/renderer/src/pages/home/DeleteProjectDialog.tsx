import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import type { Project } from '../../../../shared/projects'

type DeleteProjectDialogProps = {
  project: Project | undefined
  sessionCount: number
  onCancel: () => void
  onConfirmDelete: () => void
}

const deleteDialogCancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'

const deleteDialogConfirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

// Destructive deletion requires confirmation; the project's sessions are removed with it, artifacts stay.
const DeleteProjectDialog = ({
  project,
  sessionCount,
  onCancel,
  onConfirmDelete
}: DeleteProjectDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={Boolean(project)}
    onOpenChange={(open) => {
      if (!open) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
        <AlertDialog.Title className="text-base font-semibold text-text-000">
          Delete project?
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
          This will permanently delete &quot;{project?.name}&quot;
          {sessionCount > 0
            ? ` and its ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`
            : ''}
          . Generated artifacts remain on disk. This action cannot be undone.
        </AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="outline" className={deleteDialogCancelButtonClassName}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button
              type="button"
              className={deleteDialogConfirmButtonClassName}
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

export { DeleteProjectDialog }
