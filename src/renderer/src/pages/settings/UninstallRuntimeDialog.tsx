import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type UninstallRuntimeDialogProps = {
  // The framework whose app-managed runtime is being removed; null keeps the dialog closed.
  framework: 'claude' | 'opencode' | 'codex' | null
  isUninstalling: boolean
  onCancel: () => void
  onConfirm: () => void
}

const cancelButtonClassName =
  'border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000'

const confirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

const DISPLAY_NAME: Record<'claude' | 'opencode' | 'codex', string> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex'
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
  const name = framework ? DISPLAY_NAME[framework] : ''

  return (
    <AlertDialog.Root
      open={Boolean(framework)}
      onOpenChange={(open) => {
        if (!open && !isUninstalling) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
          <AlertDialog.Title className={dialogTitleClassName}>Uninstall {name}?</AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            This removes the {name} runtime this app downloaded and manages. A separate {name} you
            installed yourself is not affected. You can reinstall it here at any time.
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="outline"
                className={cancelButtonClassName}
                disabled={isUninstalling}
              >
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              className={confirmButtonClassName}
              disabled={isUninstalling}
              onClick={onConfirm}
            >
              {isUninstalling ? 'Uninstalling…' : 'Uninstall'}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { UninstallRuntimeDialog }
