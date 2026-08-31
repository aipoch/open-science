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

type BroadPermissionScope = 'project' | 'global'

type PermissionScopeConfirmation = {
  scope: BroadPermissionScope
  subject: string
  codeExecution: boolean
  settingsTarget?: 'network'
}

type PermissionScopeConfirmationDialogProps = {
  confirmation: PermissionScopeConfirmation | undefined
  onCancel: () => void
  onConfirm: () => void
}

const PermissionScopeConfirmationDialog = ({
  confirmation,
  onCancel,
  onConfirm
}: PermissionScopeConfirmationDialogProps): React.JSX.Element => {
  const { t } = useTranslation()

  const retainedConfirmation = useRetainedDialogValue(confirmation)
  const scope = retainedConfirmation?.scope ?? 'project'
  const subject = retainedConfirmation?.subject ?? 'this permission'
  const isProject = scope === 'project'
  const scopePhrase = isProject ? t('for this project') : t('globally')
  const effect = retainedConfirmation?.codeExecution
    ? isProject
      ? t('Code will run without preview for every session in this project.')
      : t('Code will run without preview for every session in every project.')
    : isProject
      ? t('Matching actions can run without another approval for every session in this project.')
      : t('Matching actions can run without another approval for every session in every project.')
  const settingsTarget = retainedConfirmation?.settingsTarget
    ? `${t('Settings')} → ${t('Network')} → ${t('Allowed domains')}`
    : t('Settings → Permissions')

  return (
    <AlertDialog.Root
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={`${dialogOverlayClassName} z-[70]`} />
        <AlertDialog.Content
          className={dialogPanelClassName('z-[70] w-[min(420px,calc(100vw-2rem))] p-0')}
          data-testid="permission-scope-confirmation"
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title
                className={`${dialogTitleClassName} min-w-0 [overflow-wrap:anywhere]`}
              >
                {t('Allow {{subject}} {{scope}}?', { subject, scope: scopePhrase })}
              </AlertDialog.Title>
            </div>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={dialogCloseButtonClassName}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </AlertDialog.Cancel>
          </div>

          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {effect} {t('You can revoke it in')}{' '}
              <strong className="font-semibold text-foreground">{settingsTarget}</strong>
            </AlertDialog.Description>
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                data-testid="permission-scope-cancel"
              >
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                variant="destructive"
                data-testid="permission-scope-confirm"
                onClick={onConfirm}
              >
                {isProject ? t('Allow for this project') : t('Allow globally')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope,
  type PermissionScopeConfirmation
}
