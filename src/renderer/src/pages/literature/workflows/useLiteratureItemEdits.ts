import { useLiteratureHost } from '../renderer-host'
import type { LiteratureDetailController } from '@aipoch/literature-library/client'
import { useLayoutEffect, useMemo, useRef } from 'react'
import type {
  LiteratureCollectionView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import { useTranslation } from 'react-i18next'
import type { LiteratureSelectionStore } from '../list/literature-selection'

/** Apply detail membership and inline metadata writes with the existing receipt and readback rules. */
export function useLiteratureItemEdits({
  detailController,
  scopeKey,
  setItems,
  setProjectLinkError,
  loadProjectCounts,
  projectId,
  closeSelectedItemDetail,
  loadEntries,
  loadCollections,
  setCollectionLinkError,
  collectionId,
  selectionStore,
  refreshItems,
  setError
}: {
  detailController: LiteratureDetailController
  scopeKey: string
  setItems: React.Dispatch<React.SetStateAction<LiteratureItemView[]>>
  setProjectLinkError: React.Dispatch<React.SetStateAction<string | undefined>>
  loadProjectCounts: () => Promise<void>
  projectId: string | undefined
  closeSelectedItemDetail: () => void
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  loadCollections: () => Promise<LiteratureCollectionView[] | undefined>
  setCollectionLinkError: React.Dispatch<React.SetStateAction<string | undefined>>
  collectionId: string | undefined
  selectionStore: LiteratureSelectionStore
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
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  // Each query visit owns an identity; locale/callback changes keep that visit intact.
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey])
  const currentScope = useRef<typeof scope | undefined>(scope)
  const refresh = useRef({ loadEntries, loadProjectCounts, loadCollections, t })
  useLayoutEffect(() => {
    refresh.current = { loadEntries, loadProjectCounts, loadCollections, t }
  }, [loadEntries, loadProjectCounts, loadCollections, t])
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      currentScope.current = undefined
    }
  }, [scope])
  const setProjectLink = async (targetProjectId: string, included: boolean): Promise<boolean> => {
    const detail = detailController.getSnapshot()
    const itemId = detail.item?.id
    if (!itemId) return false
    const updateProjectLinkState = (nextIncluded: boolean): void => {
      const updateProjects = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        projectIds: nextIncluded
          ? [...new Set([...item.projectIds, targetProjectId])]
          : item.projectIds.filter((id) => id !== targetProjectId)
      })
      const detailItem = detailController.getSnapshot().item
      if (
        detailItem?.id === itemId &&
        detailController.getSnapshot().generation === detail.generation
      )
        detailController.replace(updateProjects(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateProjects(item) : item))
      )
    }
    setProjectLinkError(undefined)
    try {
      await hostApi.literature.transact({
        kind: 'set-project-item',
        projectId: targetProjectId,
        itemId,
        included,
        source: 'library'
      })
      if (!currentScope.current) return true
      updateProjectLinkState(included)
      if (!included && targetProjectId === projectId && currentScope.current === scope) {
        const currentDetail = detailController.getSnapshot()
        if (currentDetail.item?.id === itemId && currentDetail.generation === detail.generation)
          closeSelectedItemDetail()
        await refresh.current.loadEntries(true)
      }
      // A broadcast may already have read the committed count before this receipt arrives.
      await refresh.current
        .loadProjectCounts()
        .catch(() => setError(refresh.current.t('Literature could not be loaded.')))
      return true
    } catch {
      if (
        currentScope.current === scope &&
        detailController.getSnapshot().generation === detail.generation
      )
        setProjectLinkError(refresh.current.t('Project link could not be updated.'))
      return false
    }
  }
  const setCollectionLink = async (
    targetCollectionId: string,
    included: boolean
  ): Promise<boolean> => {
    const detail = detailController.getSnapshot()
    const itemId = detail.item?.id
    if (!itemId) return false
    const updateCollectionLinkState = (nextIncluded: boolean): void => {
      const updateCollections = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        collectionIds: nextIncluded
          ? [...new Set([...item.collectionIds, targetCollectionId])]
          : item.collectionIds.filter((id) => id !== targetCollectionId)
      })
      const detailItem = detailController.getSnapshot().item
      if (
        detailItem?.id === itemId &&
        detailController.getSnapshot().generation === detail.generation
      )
        detailController.replace(updateCollections(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateCollections(item) : item))
      )
    }
    setCollectionLinkError(undefined)
    try {
      await hostApi.literature.transact({
        kind: 'set-collection-item',
        collectionId: targetCollectionId,
        itemId,
        included
      })
      if (!currentScope.current) return true
      updateCollectionLinkState(included)
      if (!included && targetCollectionId === collectionId && currentScope.current === scope) {
        selectionStore.remove(itemId)
        setItems((current) => current.filter((item) => item.id !== itemId))
        await refresh.current.loadEntries(true)
      }
      await refresh.current
        .loadCollections()
        .catch(() => setError(refresh.current.t('Literature could not be loaded.')))
      return true
    } catch {
      if (
        currentScope.current === scope &&
        detailController.getSnapshot().generation === detail.generation
      )
        setCollectionLinkError(refresh.current.t('Collection link could not be updated.'))
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
      await hostApi.literature.transact({
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
