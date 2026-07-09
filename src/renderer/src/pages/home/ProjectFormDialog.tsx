import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type ProjectFormDialogProps = {
  open: boolean
  title: string
  description: string
  submitLabel: string
  nameDraft: string
  descriptionDraft: string
  isSubmitting: boolean
  error: string | undefined
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onCancel: () => void
  onConfirm: (event: React.FormEvent<HTMLFormElement>) => void
}

const dialogCancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'

const dialogConfirmButtonClassName =
  'border-transparent bg-text-000 text-bg-000 hover:bg-text-100 hover:text-bg-000'

const dialogInputClassName =
  'h-9 rounded-lg border-border-200 bg-bg-000 px-3 text-sm text-text-000 shadow-none placeholder:text-text-100 focus-visible:border-border-200 focus-visible:ring-2 focus-visible:ring-border-200/25'

// Shared name + description form for creating and editing a project. Both are stored in the project DB.
const ProjectFormDialog = ({
  open,
  title,
  description,
  submitLabel,
  nameDraft,
  descriptionDraft,
  isSubmitting,
  error,
  onNameChange,
  onDescriptionChange,
  onCancel,
  onConfirm
}: ProjectFormDialogProps): React.JSX.Element => (
  <Dialog.Root
    open={open}
    onOpenChange={(nextOpen) => {
      if (nextOpen) return

      onCancel()
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
        <form onSubmit={onConfirm}>
          <Dialog.Title className="text-base font-semibold text-text-000">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
            {description}
          </Dialog.Description>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-100" htmlFor="project-form-name">
                Name
              </label>
              <Input
                id="project-form-name"
                value={nameDraft}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="e.g. Reproduction of published research"
                autoFocus
                className={dialogInputClassName}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-text-100"
                htmlFor="project-form-description"
              >
                Description <span className="text-text-300">(optional)</span>
              </label>
              <textarea
                id="project-form-description"
                value={descriptionDraft}
                onChange={(event) => onDescriptionChange(event.target.value)}
                placeholder="What is this project about?"
                rows={3}
                className="w-full resize-none rounded-lg border border-border-200 bg-bg-000 px-3 py-2 text-sm text-text-000 shadow-none outline-none placeholder:text-text-100 focus-visible:border-border-200 focus-visible:ring-2 focus-visible:ring-border-200/25"
              />
            </div>
          </div>
          {error ? (
            <p className="mt-3 text-sm text-danger-000" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className={dialogCancelButtonClassName}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={nameDraft.trim().length === 0 || isSubmitting}
              className={dialogConfirmButtonClassName}
            >
              {submitLabel}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)

export { ProjectFormDialog }
