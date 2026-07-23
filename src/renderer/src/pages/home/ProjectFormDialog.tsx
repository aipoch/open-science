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
  'border-border bg-card text-foreground hover:bg-muted hover:text-foreground'

const dialogInputClassName =
  'h-9 rounded-lg border-border bg-card px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25'

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
      <Dialog.Overlay className={dialogOverlayClassName} />
      <Dialog.Content
        onInteractOutside={(event) => event.preventDefault()}
        className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))]')}
      >
        <form onSubmit={onConfirm}>
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {description}
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
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="project-form-name"
              >
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
                className="text-xs font-medium text-muted-foreground"
                htmlFor="project-form-description"
              >
                Description <span className="text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id="project-form-description"
                value={descriptionDraft}
                onChange={(event) => onDescriptionChange(event.target.value)}
                placeholder="What is this project about?"
                rows={3}
                className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
              />
            </div>
          </div>
          {error ? (
            <p className="mt-3 text-sm text-danger-000" role="alert">
              {error}
            </p>
          ) : null}
          <div className={dialogFooterClassName}>
            <Button
              type="button"
              variant="outline"
              className={dialogCancelButtonClassName}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={nameDraft.trim().length === 0 || isSubmitting}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)

export { ProjectFormDialog }
