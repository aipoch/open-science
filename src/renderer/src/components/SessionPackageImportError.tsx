import { useTranslation } from 'react-i18next'
import { Dialog } from 'radix-ui'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { ErrorNotice } from './error-notice'
import { dialogOverlayClassName, dialogPanelClassName } from './ui/dialog-chrome'

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
        <Dialog.Content className={dialogPanelClassName('w-[min(480px,calc(100vw-2rem))] p-6')}>
          <Dialog.Title className="sr-only">{t('Could not import Session package')}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {t('The package could not be imported. Your existing research is unchanged.')}
          </Dialog.Description>
          <ErrorNotice
            title={t('Could not import Session package')}
            description={error}
            primaryButton={{ label: t('Close'), onClick: () => setError(undefined) }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
