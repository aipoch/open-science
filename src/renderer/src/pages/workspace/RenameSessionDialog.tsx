import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Input } from '@/components/ui/input'
import type { ChatSession } from '@/stores/session-store'

type RenameSessionDialogProps = {
  session: ChatSession | undefined
  renameDraft: string
  onRenameDraftChange: (value: string) => void
  onCancel: () => void
  onConfirmRename: (event: React.FormEvent<HTMLFormElement>) => void
}

// Rename dialog updates only the session title; messages and run status stay untouched.
const RenameSessionDialog = ({
  session,
  renameDraft,
  onRenameDraftChange,
  onCancel,
  onConfirmRename
}: RenameSessionDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const dialogRenameDraft = useRetainedDialogValue(session ? renameDraft : undefined) ?? renameDraft

  return (
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
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
        >
          <form onSubmit={onConfirmRename}>
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>{t('Rename session')}</Dialog.Title>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={dialogCloseButtonClassName}
                onClick={onCancel}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className={`${dialogBodyClassName} space-y-3`}>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Update the name shown in the session list.')}
              </Dialog.Description>
              <label
                className={`${dialogFormLabelClassName} sr-only`}
                htmlFor="rename-session-name"
              >
                {t('Session name')}
              </label>
              <Input
                id="rename-session-name"
                value={dialogRenameDraft}
                onChange={(event) => onRenameDraftChange(event.target.value)}
                aria-label={t('Session name')}
                autoFocus
                className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
              />
            </div>
            <div className={dialogFooterClassName}>
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                className={dialogCancelButtonClassName}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={dialogRenameDraft.trim().length === 0}>
                {t('Rename')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { RenameSessionDialog }
