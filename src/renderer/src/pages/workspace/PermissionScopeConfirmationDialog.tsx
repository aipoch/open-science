import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
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
  const retainedConfirmation = useRetainedDialogValue(confirmation)
  const scope = retainedConfirmation?.scope ?? 'project'
  const subject = retainedConfirmation?.subject ?? 'this permission'
  const isProject = scope === 'project'
  const scopePhrase = isProject ? 'for this project' : 'globally'
  const coveragePhrase = isProject
    ? 'for every session in this project'
    : 'for every session in every project'
  const effect = retainedConfirmation?.codeExecution
    ? `Code will run without preview ${coveragePhrase}.`
    : `Matching actions can run without another approval ${coveragePhrase}.`

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
          className={dialogPanelClassName('z-[70] w-[min(420px,calc(100vw-2rem))]')}
          data-testid="permission-scope-confirmation"
        >
          <AlertDialog.Title className={`${dialogTitleClassName} min-w-0 [overflow-wrap:anywhere]`}>
            Allow {subject} {scopePhrase}?
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            {effect} You can revoke it in{' '}
            <strong className="font-semibold text-foreground">Settings → Permissions</strong>.
          </AlertDialog.Description>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" data-testid="permission-scope-cancel">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                variant="destructive"
                data-testid="permission-scope-confirm"
                onClick={onConfirm}
              >
                {isProject ? 'Allow for this project' : 'Allow globally'}
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
