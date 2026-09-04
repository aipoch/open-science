import { LoaderCircle } from 'lucide-react'
import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type ConfirmActionDialogProps = {
  open: boolean
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  loadingLabel?: string
  loading?: boolean
  destructive?: boolean
  testId?: string
  onCancel: () => void
  onConfirm: () => void
}

const ConfirmActionDialog = ({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  loadingLabel,
  loading = false,
  destructive = false,
  testId,
  onCancel,
  onConfirm
}: ConfirmActionDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={open}
    onOpenChange={(nextOpen) => {
      if (!nextOpen && !loading) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className={`${dialogOverlayClassName} z-[70]`} />
      <AlertDialog.Content
        className={dialogPanelClassName('z-[70] w-[min(420px,calc(100vw-2rem))] p-0')}
        data-testid={testId}
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault()
        }}
      >
        <div className={dialogHeaderClassName}>
          <AlertDialog.Title className={dialogTitleClassName}>{title}</AlertDialog.Title>
        </div>
        <div className={dialogBodyClassName}>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            {description}
          </AlertDialog.Description>
        </div>
        <div className={dialogFooterClassName}>
          <AlertDialog.Cancel asChild>
            <Button
              type="button"
              variant="ghost"
              className={dialogCancelButtonClassName}
              disabled={loading}
            >
              {cancelLabel}
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button
              type="button"
              variant={destructive ? 'destructive' : 'default'}
              disabled={loading}
              onClick={(event) => {
                event.preventDefault()
                onConfirm()
              }}
            >
              {loading ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {loading ? (loadingLabel ?? confirmLabel) : confirmLabel}
            </Button>
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

export { ConfirmActionDialog }
