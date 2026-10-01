import { useTranslation } from 'react-i18next'
import type {
  LiteratureCollectionView,
  LiteratureItemInput,
  LiteratureItemView
} from '../../../../shared/literature'
import type { LiteratureDetailController } from './LiteratureDetailController'
import type { LiteratureSelectionStore } from './literature-selection'

/** Apply detail membership and inline metadata writes with the existing receipt and readback rules. */
export function useLiteratureItemEdits({
  detailController,
  setItems,
  setProjectLinkError,
  setProjectItemCounts,
  projectId,
  closeSelectedItemDetail,
  loadEntries,
  setCollections,
  setCollectionLinkError,
  collectionId,
  selectionStore,
  setEntriesTotalCount,
  refreshItems,
  setError
}: {
  detailController: LiteratureDetailController
  setItems: React.Dispatch<React.SetStateAction<LiteratureItemView[]>>
  setProjectLinkError: React.Dispatch<React.SetStateAction<string | undefined>>
  setProjectItemCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  projectId: string | undefined
  closeSelectedItemDetail: () => void
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  setCollections: React.Dispatch<React.SetStateAction<LiteratureCollectionView[]>>
  setCollectionLinkError: React.Dispatch<React.SetStateAction<string | undefined>>
  collectionId: string | undefined
  selectionStore: LiteratureSelectionStore
  setEntriesTotalCount: React.Dispatch<React.SetStateAction<number>>
  refreshItems: (
    itemIds: string[],
    updatedItems?: LiteratureItemView[],
    includeHidden?: boolean
  ) => Promise<void>
  setError: React.Dispatch<React.SetStateAction<string | undefined>>
}): {
  setProjectLink: (targetProjectId: string, included: boolean) => Promise<boolean>
  setCollectionLink: (targetCollectionId: string, included: boolean) => Promise<boolean>
  persistInlineItem: (
    entry: LiteratureItemView,
    patch: Partial<Pick<LiteratureItemInput, 'itemType' | 'personalNote' | 'rating'>>,
    onPersisted?: (reload: () => Promise<LiteratureItemView>) => void
  ) => Promise<void>
} {
  const { t } = useTranslation()
  const setProjectLink = async (targetProjectId: string, included: boolean): Promise<boolean> => {
    const itemId = detailController.getSnapshot().item?.id
    if (!itemId) return false
    const updateProjectLinkState = (nextIncluded: boolean): void => {
      const updateProjects = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        projectIds: nextIncluded
          ? [...new Set([...item.projectIds, targetProjectId])]
          : item.projectIds.filter((id) => id !== targetProjectId)
      })
      const detailItem = detailController.getSnapshot().item
      if (detailItem?.id === itemId) detailController.replace(updateProjects(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateProjects(item) : item))
      )
    }
    setProjectLinkError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'set-project-item',
        projectId: targetProjectId,
        itemId,
        included,
        source: 'library'
      })
      setProjectItemCounts((current) => ({
        ...current,
        [targetProjectId]: Math.max(0, (current[targetProjectId] ?? 0) + (included ? 1 : -1))
      }))
      if (!included && targetProjectId === projectId) {
        closeSelectedItemDetail()
        await loadEntries(true)
      } else {
        updateProjectLinkState(included)
      }
      return true
    } catch {
      setProjectLinkError(t('Project link could not be updated.'))
      return false
    }
  }
  const setCollectionLink = async (
    targetCollectionId: string,
    included: boolean
  ): Promise<boolean> => {
    const itemId = detailController.getSnapshot().item?.id
    if (!itemId) return false
    const updateCollectionLinkState = (nextIncluded: boolean): void => {
      const updateCollections = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        collectionIds: nextIncluded
          ? [...new Set([...item.collectionIds, targetCollectionId])]
          : item.collectionIds.filter((id) => id !== targetCollectionId)
      })
      const detailItem = detailController.getSnapshot().item
      if (detailItem?.id === itemId) detailController.replace(updateCollections(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateCollections(item) : item))
      )
      setCollections((current) =>
        current.map((collection) =>
          collection.id === targetCollectionId
            ? {
                ...collection,
                itemCount: Math.max(0, collection.itemCount + (nextIncluded ? 1 : -1))
              }
            : collection
        )
      )
    }
    setCollectionLinkError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'set-collection-item',
        collectionId: targetCollectionId,
        itemId,
        included
      })
      updateCollectionLinkState(included)
      if (!included && targetCollectionId === collectionId) {
        selectionStore.remove(itemId)
        setItems((current) => current.filter((item) => item.id !== itemId))
        setEntriesTotalCount((current) => Math.max(0, current - 1))
        await loadEntries(true)
      }
      return true
    } catch {
      setCollectionLinkError(t('Collection link could not be updated.'))
      return false
    }
  }
  const persistInlineItem = async (
    entry: LiteratureItemView,
    patch: Partial<Pick<LiteratureItemInput, 'itemType' | 'personalNote' | 'rating'>>,
    onPersisted?: (reload: () => Promise<LiteratureItemView>) => void
  ): Promise<void> => {
    const item = { ...entry.item, ...patch }
    if (
      item.itemType === entry.item.itemType &&
      (item.personalNote ?? '') === (entry.item.personalNote ?? '') &&
      (item.rating ?? 0) === (entry.item.rating ?? 0)
    )
      return
    let persisted = false
    try {
      await window.api.literature.transact({
        kind: 'update-item',
        itemId: entry.id,
        expectedMetadataRevision: entry.metadataRevision,
        item
      })
      persisted = true
      const reload = async (): Promise<LiteratureItemView> => {
        try {
          const updated = await detailController.read(entry.id)
          if (!updated) throw new Error('Literature Item is unavailable after updating.')
          await refreshItems([updated.id], [updated])
          detailController.replace(updated)
          setError(undefined)
          return updated
        } catch (error) {
          setError(t('The reference was saved, but could not be reloaded.'))
          throw error
        }
      }
      onPersisted?.(reload)
      await reload()
    } catch (error) {
      setError(
        persisted
          ? t('The reference was saved, but could not be reloaded.')
          : t('Literature could not be updated.')
      )
      throw error
    }
  }
  return { setProjectLink, setCollectionLink, persistInlineItem }
}
