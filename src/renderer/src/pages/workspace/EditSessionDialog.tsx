import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ChatSession } from '@/stores/session-store'
import {
  SESSION_DETAILS_DESCRIPTION_MAX_LENGTH,
  SESSION_DETAILS_TITLE_MAX_LENGTH
} from '../../../../shared/session-persistence'

type EditSessionDialogProps = {
  session: ChatSession | undefined
  titleDraft: string
  descriptionDraft: string
  isSaving?: boolean
  onTitleDraftChange: (value: string) => void
  onDescriptionDraftChange: (value: string) => void
  onCancel: () => void
  onConfirmEdit: (event: React.FormEvent<HTMLFormElement>) => void
}

const EditSessionDialog = ({
  session,
  titleDraft,
  descriptionDraft,
  isSaving = false,
  onTitleDraftChange,
  onDescriptionDraftChange,
  onCancel,
  onConfirmEdit
}: EditSessionDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const retainedTitleDraft = useRetainedDialogValue(session ? titleDraft : undefined) ?? titleDraft
  const retainedDescriptionDraft =
    useRetainedDialogValue(session ? descriptionDraft : undefined) ?? descriptionDraft
  const titleIsValid = retainedTitleDraft.trim().length > 0

  return (
    <Dialog.Root open={Boolean(session)} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content className={dialogPanelClassName('w-[min(480px,calc(100vw-2rem))] p-0')}>
          <form onSubmit={onConfirmEdit}>
            <div className={dialogHeaderClassName}>
              <Dialog.Title className={dialogTitleClassName}>{t('Edit session')}</Dialog.Title>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger
                    asChild
                    onFocus={(event) => {
                      if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                    }}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Close')}
                      className={dialogCloseButtonClassName}
                      onClick={onCancel}
                      disabled={isSaving}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('Close')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className={`${dialogBodyClassName} space-y-4`}>
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label className={dialogFormLabelClassName} htmlFor="edit-session-title">
                    {t('Title')}
                  </label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {retainedTitleDraft.length}/{SESSION_DETAILS_TITLE_MAX_LENGTH}
                  </span>
                </div>
                <Input
                  id="edit-session-title"
                  value={retainedTitleDraft}
                  maxLength={SESSION_DETAILS_TITLE_MAX_LENGTH}
                  onChange={(event) => onTitleDraftChange(event.target.value)}
                  autoFocus
                  disabled={isSaving}
                  className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label className={dialogFormLabelClassName} htmlFor="edit-session-description">
                    {t('Description')}
                  </label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {retainedDescriptionDraft.length}/{SESSION_DETAILS_DESCRIPTION_MAX_LENGTH}
                  </span>
                </div>
                <Textarea
                  id="edit-session-description"
                  value={retainedDescriptionDraft}
                  maxLength={SESSION_DETAILS_DESCRIPTION_MAX_LENGTH}
                  onChange={(event) => onDescriptionDraftChange(event.target.value)}
                  disabled={isSaving}
                  rows={5}
                  className={`${dialogFormInputClassName} min-h-28 resize-y px-3 py-2 text-sm`}
                />
              </div>
            </div>
            <div className={dialogFooterClassName}>
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
                className={dialogCancelButtonClassName}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!titleIsValid || isSaving}>
                {t('Save')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { EditSessionDialog }
export type { EditSessionDialogProps }
