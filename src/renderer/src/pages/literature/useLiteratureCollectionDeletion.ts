import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  type LiteratureCollectionView
} from '../../../../shared/literature'

type CollectionDeletion = {
  collection: LiteratureCollectionView
  promoted: LiteratureCollectionView[]
  conflicting: LiteratureCollectionView[]
}

/** Keep the promotion preview and deletion receipt in the same collection lifecycle. */
export function useLiteratureCollectionDeletion({
  collections,
  setCollections,
  collectionId,
  selectLibrary,
  loadCollections
}: {
  collections: LiteratureCollectionView[]
  setCollections: React.Dispatch<React.SetStateAction<LiteratureCollectionView[]>>
  collectionId?: string
  selectLibrary: () => void
  loadCollections: () => Promise<unknown>
}): {
  collectionPendingDelete: LiteratureCollectionView | undefined
  setCollectionPendingDelete: React.Dispatch<
    React.SetStateAction<LiteratureCollectionView | undefined>
  >
  isDeletingCollection: boolean
  collectionDeleteError: string | undefined
  setCollectionDeleteError: React.Dispatch<React.SetStateAction<string | undefined>>
  dialogCollectionDeletion: CollectionDeletion | undefined
  promotedCollections: LiteratureCollectionView[]
  conflictingCollections: LiteratureCollectionView[]
  deleteCollection: () => Promise<void>
} {
  const { t } = useTranslation()
  const [collectionPendingDelete, setCollectionPendingDelete] = useState<LiteratureCollectionView>()
  const [isDeletingCollection, setIsDeletingCollection] = useState(false)
  const [collectionDeleteError, setCollectionDeleteError] = useState<string>()
  const collectionDeletion = useMemo(() => {
    if (!collectionPendingDelete) return undefined
    const promoted = collections.filter(({ parentId }) => parentId === collectionPendingDelete.id)
    const rootNames = new Set(
      collections.filter(({ parentId }) => !parentId).map(({ name }) => name.toLowerCase())
    )
    return {
      collection: collectionPendingDelete,
      promoted,
      conflicting: promoted.filter(({ name }) => rootNames.has(name.toLowerCase()))
    }
  }, [collectionPendingDelete, collections])
  const dialogCollectionDeletion = useRetainedDialogValue(collectionDeletion)
  const promotedCollections = dialogCollectionDeletion?.promoted ?? []
  const conflictingCollections = dialogCollectionDeletion?.conflicting ?? []

  const deleteCollection = async (): Promise<void> => {
    if (!collectionPendingDelete || isDeletingCollection || collectionDeletion?.conflicting.length)
      return
    const deletingCollection = collectionPendingDelete
    setIsDeletingCollection(true)
    setCollectionDeleteError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'delete-collection',
        collectionId: deletingCollection.id
      })
      setCollections((current) =>
        current.filter((collection) => collection.id !== deletingCollection.id)
      )
      if (collectionId === deletingCollection.id) selectLibrary()
      setCollectionPendingDelete(undefined)
    } catch (error) {
      setCollectionDeleteError(
        error instanceof Error && error.message.includes(LITERATURE_COLLECTION_NAME_CONFLICT)
          ? t(
              'A child collection would duplicate a top-level name. Rename it before deleting this collection.'
            )
          : t('Collection could not be deleted.')
      )
      await loadCollections().catch(() => undefined)
    } finally {
      setIsDeletingCollection(false)
    }
  }

  return {
    collectionPendingDelete,
    setCollectionPendingDelete,
    isDeletingCollection,
    collectionDeleteError,
    setCollectionDeleteError,
    dialogCollectionDeletion,
    promotedCollections,
    conflictingCollections,
    deleteCollection
  }
}
