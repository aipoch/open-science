import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ChatSession } from '@/stores/session-store'

type DeleteSessionDialogProps = {
  session: ChatSession | undefined
  canDelete: boolean
  isDeleting?: boolean
  error?: 'runtime' | 'persistence'
  onCancel: () => void
  onConfirmDelete: () => void
}

const deleteDialogConfirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

// Destructive deletion requires confirmation before the session is removed from memory.
const DeleteSessionDialog = ({
  session,
  canDelete,
  isDeleting = false,
  error,
  onCancel,
  onConfirmDelete
}: DeleteSessionDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const dialogSession = useRetainedDialogValue(session)

  return (
    <AlertDialog.Root
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (!open && !isDeleting) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
          aria-busy={isDeleting}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Delete Session?')}
              </AlertDialog.Title>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={isDeleting}
              onClick={onCancel}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t(
                'This will permanently delete "{{title}}". Artifacts created in this session will remain in the project. Messages and execution evidence attached to those Artifacts will remain available in Provenance. Files in its working folder are not deleted. This action cannot be undone.',
                { title: dialogSession?.title ?? '' }
              )}
            </AlertDialog.Description>
            {isDeleting ? (
              <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">
                {t('Deleting…')}
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error === 'persistence'
                  ? t(
                      "The agent was stopped, but Open Science couldn't delete the saved Session. The Session, draft, and attachments were kept. Please try again."
                    )
                  : t(
                      "Open Science couldn't stop the agent for this Session. The Session was not deleted. Please try again."
                    )}
              </p>
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={isDeleting}
              >
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              className={deleteDialogConfirmButtonClassName}
              disabled={!canDelete || isDeleting}
              onClick={onConfirmDelete}
            >
              {isDeleting ? t('Deleting…') : error ? t('Retry') : t('Delete')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DeleteSessionDialog }
