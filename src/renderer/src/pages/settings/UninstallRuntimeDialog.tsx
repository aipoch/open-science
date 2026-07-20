import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'

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
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
          <AlertDialog.Title className="text-base font-semibold text-text-000">
            Uninstall {name}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
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
