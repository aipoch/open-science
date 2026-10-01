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
import { LoaderCircle, X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView } from '../../../../../shared/literature'
import { useLiteratureCollectionDeletion } from './useLiteratureCollectionDeletion'

export function LiteratureCollectionDeleteDialog({
  collectionPendingDelete,
  isDeletingCollection,
  setCollectionPendingDelete,
  dialogCollectionDeletion,
  promotedCollections,
  conflictingCollections,
  openEditCollection,
  collectionDeleteError,
  deleteCollection
}: {
  collectionPendingDelete: LiteratureCollectionView | undefined
  isDeletingCollection: boolean
  setCollectionPendingDelete: React.Dispatch<
    React.SetStateAction<LiteratureCollectionView | undefined>
  >
  dialogCollectionDeletion: ReturnType<
    typeof useLiteratureCollectionDeletion
  >['dialogCollectionDeletion']
  promotedCollections: LiteratureCollectionView[]
  conflictingCollections: LiteratureCollectionView[]
  openEditCollection: (collection: LiteratureCollectionView) => void
  collectionDeleteError: string | undefined
  deleteCollection: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog.Root
      open={Boolean(collectionPendingDelete)}
      onOpenChange={(open) => {
        if (!open && !isDeletingCollection) setCollectionPendingDelete(undefined)
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Delete “{{name}}”?', {
                name: dialogCollectionDeletion?.collection.name ?? ''
              })}
            </AlertDialog.Title>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={dialogCloseButtonClassName}
              aria-label={t('Close')}
              disabled={isDeletingCollection}
              onClick={() => setCollectionPendingDelete(undefined)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t(
                'References in this collection will remain in All references. This action cannot be undone.'
              )}
            </AlertDialog.Description>
            {promotedCollections.length ? (
              <div className="mt-3 space-y-2 text-sm">
                <p>{t('Child collections will move to the top level.')}</p>
                <ul className="space-y-2">
                  {promotedCollections.map((child) => (
                    <li
                      key={child.id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="min-w-0 break-words">{child.name}</span>
                      {conflictingCollections.some(({ id }) => id === child.id) ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isDeletingCollection}
                          onClick={() => {
                            setCollectionPendingDelete(undefined)
                            openEditCollection(child)
                          }}
                        >
                          {t('Rename conflicting collection')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {conflictingCollections.length ? (
                  <p role="alert">
                    {t(
                      'A child collection would duplicate a top-level name. Rename it before deleting this collection.'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
            {collectionDeleteError ? (
              <p className="mt-3 text-sm text-danger-000" role="alert">
                {collectionDeleteError}
              </p>
            ) : null}
          </div>
          <div
            className={`${dialogFooterClassName} flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
          >
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={isDeletingCollection}
              >
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeletingCollection || conflictingCollections.length > 0}
              onClick={() => void deleteCollection()}
            >
              {isDeletingCollection ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {t('Delete collection')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
