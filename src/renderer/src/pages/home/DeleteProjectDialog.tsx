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
import type { Project } from '../../../../shared/projects'

type DeleteProjectDialogProps = {
  project: Project | undefined
  sessionCount: number
  hasCompleteSessionCatalog: boolean
  canDelete: boolean
  isDeleting: boolean
  error: string | undefined
  onCancel: () => void
  onConfirmDelete: () => void
}

const deleteDialogConfirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

// Destructive deletion requires confirmation and reports the app-managed data removed with the Project.
const DeleteProjectDialog = ({
  project,
  sessionCount,
  hasCompleteSessionCatalog,
  canDelete,
  isDeleting,
  error,
  onCancel,
  onConfirmDelete
}: DeleteProjectDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
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
        if (!open && !isDeleting) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Delete project?')}
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
              {/* Whole sentences per branch rather than a spliced-in clause: the session count
                    sits mid-sentence in English but not in every language. */}
              {dialogHasCompleteSessionCatalog
                ? dialogSessionCount > 0
                  ? t(
                      'This will permanently delete "{{name}}" and its {{count}} sessions. Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. Retained managed Session workspaces remain available in Settings → Storage. This action cannot be undone.',
                      {
                        defaultValue_one:
                          'This will permanently delete "{{name}}" and its {{count}} session. Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. Retained managed Session workspaces remain available in Settings → Storage. This action cannot be undone.',
                        name: dialogProject?.name,
                        count: dialogSessionCount
                      }
                    )
                  : t(
                      'This will permanently delete "{{name}}". Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. Retained managed Session workspaces remain available in Settings → Storage. This action cannot be undone.',
                      { name: dialogProject?.name }
                    )
                : t(
                    'This will permanently delete "{{name}}" and all of its saved conversations, including any that could not be loaded during recovery. Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. Retained managed Session workspaces remain available in Settings → Storage. This action cannot be undone.',
                    {
                      name: dialogProject?.name
                    }
                  )}{' '}
              {t('Deleting this project will stop its running tasks and notebooks.')}
            </AlertDialog.Description>
            {error ? (
              <p className="mt-4 text-sm text-danger-000" role="alert">
                {error}
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
            {/* Async confirmation owns dialog closure so a failed deletion remains visible. */}
            <Button
              type="button"
              className={deleteDialogConfirmButtonClassName}
              disabled={!canDelete || isDeleting}
              onClick={onConfirmDelete}
            >
              {isDeleting ? t('Deleting…') : t('Delete')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DeleteProjectDialog }
