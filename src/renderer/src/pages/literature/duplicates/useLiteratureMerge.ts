import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView, LiteratureItemView } from '../../../../../shared/literature'
import { buildLiteratureMergeItem } from './literature-merge'
import type { LiteratureSelectionStore } from '../list/literature-selection'
import { isLiteratureItemSelected } from '../list/literature-selection'

/** Own reviewed merge choices and commit recovery behind the shared batch gate. */
export function useLiteratureMerge({
  selectionStore,
  items,
  isBatching,
  setIsBatching,
  setError,
  setDuplicatesRevision,
  clearSelection,
  loadEntries,
  loadCollections,
  loadProjectCounts
}: {
  selectionStore: LiteratureSelectionStore
  items: LiteratureItemView[]
  isBatching: boolean
  setIsBatching: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | undefined>>
  setDuplicatesRevision: React.Dispatch<React.SetStateAction<number>>
  clearSelection: () => void
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  loadCollections: () => Promise<LiteratureCollectionView[] | undefined>
  loadProjectCounts: () => Promise<void>
}): {
  mergeOpen: boolean
  setMergeOpen: React.Dispatch<React.SetStateAction<boolean>>
  mergeError: string | undefined
  setMergeError: React.Dispatch<React.SetStateAction<string | undefined>>
  setDuplicateMergeItems: React.Dispatch<React.SetStateAction<LiteratureItemView[] | undefined>>
  mergeSurvivorId: string
  setMergeSurvivorId: React.Dispatch<React.SetStateAction<string>>
  mergeFieldSources: Record<string, string>
  setMergeFieldSources: React.Dispatch<React.SetStateAction<Record<string, string>>>
  selectedItems: LiteratureItemView[]
  mergeSelectedItems: () => Promise<void>
} {
  const { t } = useTranslation()
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeError, setMergeError] = useState<string>()
  const [duplicateMergeItems, setDuplicateMergeItems] = useState<LiteratureItemView[]>()
  const [mergeSurvivorId, setMergeSurvivorId] = useState('')
  const [mergeFieldSources, setMergeFieldSources] = useState<Record<string, string>>({})
  const renderedSelection = selectionStore.getSnapshot()
  const selectedItems =
    duplicateMergeItems ??
    items.filter((item) => isLiteratureItemSelected(renderedSelection, item.id))
  const mergeSelectedItems = async (): Promise<void> => {
    const survivor = selectedItems.find((item) => item.id === mergeSurvivorId)
    if (!survivor || selectedItems.length < 2 || isBatching) return
    const duplicates = selectedItems.filter((item) => item.id !== survivor.id)
    const merged = buildLiteratureMergeItem(selectedItems, survivor.id, mergeFieldSources)
    setIsBatching(true)
    setMergeError(undefined)
    setError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: duplicates.map((item) => item.id),
        expectedItems: selectedItems.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        })),
        expectedMetadataRevision: survivor.metadataRevision,
        item: merged
      })
      setMergeOpen(false)
      setDuplicateMergeItems(undefined)
      setDuplicatesRevision((value) => value + 1)
      clearSelection()
      await Promise.all([loadEntries(true), loadCollections(), loadProjectCounts()])
    } catch (error) {
      setMergeError(
        error instanceof Error && error.message.includes('changed after review')
          ? t(
              'References changed after review. Reopen the merge dialog to compare the latest metadata.'
            )
          : t('Literature could not be merged.')
      )
    } finally {
      setIsBatching(false)
    }
  }
  return {
    mergeOpen,
    setMergeOpen,
    mergeError,
    setMergeError,
    setDuplicateMergeItems,
    mergeSurvivorId,
    setMergeSurvivorId,
    mergeFieldSources,
    setMergeFieldSources,
    selectedItems,
    mergeSelectedItems
  }
}
