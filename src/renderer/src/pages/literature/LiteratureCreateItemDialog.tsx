import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureItemInput } from '../../../../shared/literature'
import { LiteratureDuplicatePolicyField } from './LiteratureDuplicatePolicyField'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'
import {
  emptyLiteratureItem,
  titleFromPdfFilename,
  useLiteratureImport
} from './useLiteratureImport'
import { useLiteraturePdfStaging } from './useLiteraturePdfStaging'

export function LiteratureCreateItemDialog({
  isCreatingItem,
  isSavingNewItem,
  closeItemEditor,
  discardMetadataDialog,
  dialogItemEditor,
  pdfStaging,
  trackNewMetadataDirty,
  duplicatePolicy,
  setDuplicatePolicy,
  createdItemId,
  createManualItem
}: {
  isCreatingItem: boolean
  isSavingNewItem: boolean
  closeItemEditor: () => void
  discardMetadataDialog: React.JSX.Element
  dialogItemEditor: ReturnType<typeof useLiteratureImport>['dialogItemEditor']
  pdfStaging: ReturnType<typeof useLiteraturePdfStaging>
  trackNewMetadataDirty: (dirty: boolean) => void
  duplicatePolicy: 'reuse' | 'separate' | 'fill-missing'
  setDuplicatePolicy: React.Dispatch<React.SetStateAction<'reuse' | 'separate' | 'fill-missing'>>
  createdItemId: string | undefined
  createManualItem: (item?: LiteratureItemInput) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={isCreatingItem}
      onOpenChange={(open) => {
        if (!open && !isSavingNewItem) {
          closeItemEditor()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('flex w-[min(640px,calc(100vw-2rem))] flex-col p-0')}
        >
          {discardMetadataDialog}
          <div className={dialogHeaderClassName}>
            <div>
              <Dialog.Title className={dialogTitleClassName}>
                {dialogItemEditor?.file ? t('Import PDF') : t('Add reference')}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {dialogItemEditor?.file
                  ? t('Review reference details before importing {{name}}.', {
                      name: dialogItemEditor?.file.name
                    })
                  : t('Create a reference in your library.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                disabled={isSavingNewItem}
                aria-label={t('Close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {isSavingNewItem ? pdfStaging.notice : null}
          {dialogItemEditor?.file &&
          !dialogItemEditor.reading &&
          dialogItemEditor.metadataNotice ? (
            <p className="px-5 py-2 text-sm text-muted-foreground" role="status">
              {dialogItemEditor.metadataNotice}
            </p>
          ) : null}
          {dialogItemEditor?.file && dialogItemEditor?.reading ? (
            <div
              className="grid min-h-80 place-items-center text-sm text-muted-foreground"
              role="status"
            >
              <span className="inline-flex items-center gap-2">
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t('Reading…')}
              </span>
            </div>
          ) : (
            <LiteratureMetadataEditor
              onDirtyChange={trackNewMetadataDirty}
              className="min-h-0"
              beforeFields={
                <LiteratureDuplicatePolicyField
                  value={dialogItemEditor?.duplicatePolicy ?? duplicatePolicy}
                  onChange={setDuplicatePolicy}
                  disabled={isSavingNewItem || Boolean(dialogItemEditor?.createdItemId)}
                />
              }
              key={dialogItemEditor?.file?.name ?? 'manual-reference'}
              item={
                dialogItemEditor?.draft ?? {
                  ...emptyLiteratureItem(),
                  title: dialogItemEditor?.file
                    ? titleFromPdfFilename(dialogItemEditor?.file.name)
                    : ''
                }
              }
              saving={isSavingNewItem}
              error={dialogItemEditor?.error}
              onRetry={createdItemId ? () => void createManualItem() : undefined}
              onCancel={closeItemEditor}
              onSave={(item) => {
                if (isCreatingItem) void createManualItem(item)
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
