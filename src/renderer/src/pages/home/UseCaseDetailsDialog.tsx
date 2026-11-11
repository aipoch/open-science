import { UseCaseDetailsContent, type UseCaseDetailsContentProps } from './UseCaseDetailsContent'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import {
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type Props = UseCaseDetailsContentProps & {
  opener: HTMLElement
  onClose: () => void
}

export const UseCaseDetailsDialog = ({
  item,
  introductions,
  opener,
  onClose,
  onOpenMarketplace,
  renderImport,
  renderDownloadStatus
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const importDialogOpen = usePackageOperationStore((state) => state.open)
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onInteractOutside={(event) => {
            // The global import dialog is a sibling portal, not a child of these details.
            // Radix may deliver the closing gesture after its open state has changed.
            const fromDialog =
              event.target instanceof Element && event.target.closest('[role="dialog"]')
            if (importDialogOpen || fromDialog) event.preventDefault()
          }}
          className={dialogPanelClassName(
            'flex h-[min(780px,88svh)] w-[min(960px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          aria-describedby={undefined}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>{t('Case details')}</Dialog.Title>
            <Dialog.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('Close')}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <UseCaseDetailsContent
            item={item}
            introductions={introductions}
            onOpenMarketplace={onOpenMarketplace}
            renderImport={renderImport}
            renderDownloadStatus={renderDownloadStatus}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
