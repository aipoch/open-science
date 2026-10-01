import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Merge, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureItemType, LiteratureItemView } from '../../../../shared/literature'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { LiteratureMergeReview } from './LiteratureMergeReview'
import { fullCreatorLabel } from './literature-item-display'
import { mergeScalarFields } from './literature-merge'

export function LiteratureMergeDialog({
  mergeOpen,
  isBatching,
  setMergeOpen,
  setDuplicateMergeItems,
  mergeError,
  selectedItems,
  mergeSurvivorId,
  setMergeSurvivorId,
  mergeFieldSources,
  setMergeFieldSources,
  mergeFieldLabel,
  itemTypeLabels,
  mergeSelectedItems
}: {
  mergeOpen: boolean
  isBatching: boolean
  setMergeOpen: React.Dispatch<React.SetStateAction<boolean>>
  setDuplicateMergeItems: React.Dispatch<React.SetStateAction<LiteratureItemView[] | undefined>>
  mergeError: string | undefined
  selectedItems: LiteratureItemView[]
  mergeSurvivorId: string
  setMergeSurvivorId: React.Dispatch<React.SetStateAction<string>>
  mergeFieldSources: Record<string, string>
  setMergeFieldSources: React.Dispatch<React.SetStateAction<Record<string, string>>>
  mergeFieldLabel: (field: (typeof mergeScalarFields)[number]) => string
  itemTypeLabels: Record<LiteratureItemType, string>
  mergeSelectedItems: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={mergeOpen}
      onOpenChange={(open) => {
        if (isBatching) return
        setMergeOpen(open)
        if (!open) setDuplicateMergeItems(undefined)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('flex w-[min(960px,calc(100vw-2rem))] flex-col p-0')}
        >
          <div className={dialogHeaderClassName}>
            <div>
              <Dialog.Title className={dialogTitleClassName}>{t('Merge references')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Choose the reference to keep and resolve conflicting fields.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="relative min-h-0 max-h-[60vh] space-y-5 overflow-y-auto p-5">
            {mergeError ? <LiteratureErrorNotice tone="amber" title={mergeError} /> : null}
            <LiteratureMergeReview
              entries={selectedItems}
              survivorId={mergeSurvivorId}
              onSurvivorChange={setMergeSurvivorId}
              sources={mergeFieldSources}
              onSourceChange={(field, id) =>
                setMergeFieldSources((current) => ({ ...current, [field]: id }))
              }
              fieldLabel={mergeFieldLabel}
              creatorLabel={fullCreatorLabel}
              itemTypeLabels={itemTypeLabels}
              disabled={isBatching}
            />
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border-300/80 px-5 py-4">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                {t('Cancel')}
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              disabled={!mergeSurvivorId || isBatching}
              onClick={() => void mergeSelectedItems()}
            >
              <Merge className="size-4" aria-hidden="true" />
              {t('Merge references')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
