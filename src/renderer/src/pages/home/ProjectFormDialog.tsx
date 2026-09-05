import { LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { DiagnosticDetails } from '@/components/diagnostic-details'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFormHelpClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogFormTextareaClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Input } from '@/components/ui/input'
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH
} from '../../../../shared/projects'

type ProjectFormDialogProps = {
  open: boolean
  title: string
  description: string
  submitLabel: string
  nameDraft: string
  descriptionDraft: string
  agentContextDraft: string
  isSubmitting: boolean
  error: string | undefined
  errorDetail?: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onAgentContextChange: (value: string) => void
  onCancel: () => void
  onConfirm: (event: React.FormEvent<HTMLFormElement>) => void
}

// Shared name + description + agent context form for creating and editing a project. All are
// stored in the project DB.
const ProjectFormDialog = ({
  open,
  title,
  description,
  submitLabel,
  nameDraft,
  descriptionDraft,
  agentContextDraft,
  isSubmitting,
  error,
  errorDetail,
  onNameChange,
  onDescriptionChange,
  onAgentContextChange,
  onCancel,
  onConfirm
}: ProjectFormDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const dialogTitle = useRetainedDialogValue(open ? title : undefined) ?? title
  const dialogDescription = useRetainedDialogValue(open ? description : undefined) ?? description
  const dialogSubmitLabel = useRetainedDialogValue(open ? submitLabel : undefined) ?? submitLabel

  return (
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
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <form onSubmit={onConfirm} aria-busy={isSubmitting}>
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>{dialogTitle}</Dialog.Title>
                <Dialog.Description className="sr-only">{dialogDescription}</Dialog.Description>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={dialogCloseButtonClassName}
                onClick={onCancel}
                disabled={isSubmitting}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className={`${dialogBodyClassName} space-y-4`}>
              <div>
                <label className={dialogFormLabelClassName} htmlFor="project-form-name">
                  {t('Name')}
                </label>
                <Input
                  id="project-form-name"
                  aria-required={true}
                  value={nameDraft}
                  onChange={(event) => onNameChange(event.target.value)}
                  placeholder={t('e.g. Reproduction of published research')}
                  autoFocus
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
                />
              </div>
              <div>
                <label className={dialogFormLabelClassName} htmlFor="project-form-description">
                  {t('Description')}
                </label>
                <p id="project-form-description-help" className={dialogFormHelpClassName}>
                  {t(
                    "Shown in the project list for your reference — not included in the agent's prompt."
                  )}
                </p>
                <textarea
                  id="project-form-description"
                  aria-describedby="project-form-description-help"
                  value={descriptionDraft}
                  onChange={(event) => onDescriptionChange(event.target.value)}
                  placeholder={t('Describe what this project is about…')}
                  rows={3}
                  maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                  className={dialogFormTextareaClassName}
                />
              </div>
              <div>
                <label className={dialogFormLabelClassName} htmlFor="project-form-agent-context">
                  {t('Agent Context')}
                </label>
                <p id="project-form-agent-context-help" className={dialogFormHelpClassName}>
                  {t(
                    'Injected into the system prompt of every agent session in this project, including resumed ones. Sent to the model provider with every session — do not include secrets.'
                  )}
                </p>
                <textarea
                  id="project-form-agent-context"
                  aria-describedby="project-form-agent-context-help"
                  value={agentContextDraft}
                  onChange={(event) => onAgentContextChange(event.target.value)}
                  placeholder={t(
                    'e.g. Always cite sources with DOIs. Prefer Python for analysis. Report p-values with effect sizes.'
                  )}
                  rows={4}
                  maxLength={16000}
                  className={dialogFormTextareaClassName}
                />
              </div>
            </div>
            {error ? (
              <p className="px-5 pb-4 text-sm text-danger-000" role="alert">
                {error}
              </p>
            ) : null}
            {errorDetail ? (
              <div className="px-5 pb-4">
                <DiagnosticDetails detail={errorDetail} />
              </div>
            ) : null}
            <div className={dialogFooterClassName}>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                onClick={onCancel}
                disabled={isSubmitting}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={nameDraft.trim().length === 0 || isSubmitting}>
                {isSubmitting ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {dialogSubmitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ProjectFormDialog }
