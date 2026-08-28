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

type UninstallRuntimeDialogProps = {
  // The framework whose app-managed runtime is being removed; null keeps the dialog closed.
  framework: 'claude' | 'opencode' | 'codex' | 'codebuddy' | null
  isUninstalling: boolean
  onCancel: () => void
  onConfirm: () => void
}

const confirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

const DISPLAY_NAME: Record<'claude' | 'opencode' | 'codex' | 'codebuddy', string> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  codebuddy: 'CodeBuddy'
}

// Confirms removal of an app-managed agent runtime. Only the copy the app downloaded into its own data
// dir is deleted; a system/npm install is never touched. Reinstalling is one click, so this is
// reversible — the confirmation just guards against an accidental click.
const UninstallRuntimeDialog = ({
  framework,
  isUninstalling,
  onCancel,
  onConfirm
}: UninstallRuntimeDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const dialogFramework = useRetainedDialogValue(framework)
  const dialogIsUninstalling =
    useRetainedDialogValue(framework ? isUninstalling : undefined) ?? isUninstalling
  const name = dialogFramework ? DISPLAY_NAME[dialogFramework] : ''

  return (
    <AlertDialog.Root
      open={Boolean(framework)}
      onOpenChange={(open) => {
        if (!open && !isUninstalling) onCancel()
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
                {t('Uninstall {{name}}?', { name })}
              </AlertDialog.Title>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={dialogIsUninstalling}
              onClick={onCancel}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t(
                'This removes the {{name}} runtime this app downloaded and manages. A separate {{name}} you installed yourself is not affected. You can reinstall it here at any time.',
                { name }
              )}
            </AlertDialog.Description>
          </div>

          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={dialogIsUninstalling}
              >
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              className={confirmButtonClassName}
              disabled={dialogIsUninstalling}
              onClick={onConfirm}
            >
              {dialogIsUninstalling ? t('Uninstalling…') : t('Uninstall')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { UninstallRuntimeDialog }
