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

type EditMessageConfirmDialogProps = {
  open: boolean
  subsequentTurns: number
  onCancel: () => void
  onConfirm: () => void
}

const confirmButtonClassName =
  'border-transparent bg-amber-500 text-white hover:bg-amber-500/90 hover:text-white'

// Confirms that editing starts a new selectable branch while retaining the original downstream path.
const EditMessageConfirmDialog = ({
  open,
  subsequentTurns,
  onCancel,
  onConfirm
}: EditMessageConfirmDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Resend on a new branch?')}
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
              {t(
                'Sending this edited prompt starts a new branch from here. The {{count}} turns that currently follow remain available from the message revision controls.',
                {
                  defaultValue_one:
                    'Sending this edited prompt starts a new branch from here. The {{count}} turn that currently follows remains available from the message revision controls.',
                  count: subsequentTurns
                }
              )}
            </AlertDialog.Description>
          </div>

          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button type="button" className={confirmButtonClassName} onClick={onConfirm}>
                {t('Branch and resend')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { EditMessageConfirmDialog }
