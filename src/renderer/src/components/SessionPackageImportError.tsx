import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { ErrorNotice } from './error-notice'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogCloseButtonClassName,
  dialogBodyClassName,
  dialogFooterClassName
} from './ui/dialog-chrome'

export const SessionPackageImportError = (): React.JSX.Element => {
  const { t } = useTranslation()
  const error = usePackageOperationStore((state) => state.importError)
  const setError = usePackageOperationStore((state) => state.setImportError)
  return (
    <Dialog.Root
      open={error !== undefined}
      onOpenChange={(open) => {
        if (!open) setError(undefined)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('flex w-[min(560px,calc(100vw-2rem))] flex-col p-0')}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {t('Could not import Session package')}
            </Dialog.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              className={dialogCloseButtonClassName}
              aria-label={t('Dismiss')}
              onClick={() => setError(undefined)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={`${dialogBodyClassName} min-h-0 space-y-4 overflow-y-auto`}>
            <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
              {t('Your existing research is unchanged.')}
            </Dialog.Description>
            <ErrorNotice
              role="alert"
              tone="amber"
              description={error}
              className="border-0 bg-transparent p-0 [&_[role=alert]]:basis-0"
            />
          </div>
          <div className={dialogFooterClassName}>
            <Button onClick={() => setError(undefined)}>{t('Close')}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
