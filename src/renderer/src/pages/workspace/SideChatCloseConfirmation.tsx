import { useEffect, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import { previewCloseGuards } from '@/stores/preview-close-guard'
import { sideChatTabId } from '@/stores/preview-workbench-store'

export function SideChatCloseConfirmation({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [approve, setApprove] = useState<(() => void) | undefined>()
  useEffect(
    () =>
      previewCloseGuards.register(sideChatTabId(sessionId), (action) => setApprove(() => action)),
    [sessionId]
  )
  return (
    <AlertDialog.Root
      open={Boolean(approve)}
      onOpenChange={(open) => {
        if (!open) setApprove(undefined)
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-6')}
        >
          <AlertDialog.Title className={dialogTitleClassName}>
            {t('Close Side chat?')}
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            {t(
              'Closing this Side chat tab will stop it and delete its saved conversation. This cannot be undone.'
            )}
          </AlertDialog.Description>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{t('Cancel')}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                onClick={() => {
                  setApprove(undefined)
                  approve?.()
                }}
              >
                {t('Close Side chat')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
