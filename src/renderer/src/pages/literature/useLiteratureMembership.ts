import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  type LiteratureCatalogCommand
} from '../../../../shared/literature'
import type { LiteratureDetailController } from './LiteratureDetailController'
import type { LiteratureSelectionStore } from './literature-selection'

const LITERATURE_BATCH_COMMAND_SIZE = 200

type LinkFailure = {
  command:
    | Omit<Extract<LiteratureCatalogCommand, { kind: 'move-collection-items' }>, 'itemIds'>
    | Omit<Extract<LiteratureCatalogCommand, { kind: 'set-project-items' }>, 'itemIds'>
  itemIds: readonly string[]
  completed: number
  scopeKey: string
  skipped: number
}

/** One owner for association receipts and retries across selection and scope changes. */
export function useLiteratureMembership({
  collectionId,
  selectionStore,
  detailController,
  entriesKey,
  linkScopeRef,
  isBatching,
  setIsBatching,
  setError,
  resolveSelectedItemIds,
  loadEntries,
  loadCollections,
  loadProjectCounts
}: {
  collectionId?: string
  selectionStore: LiteratureSelectionStore
  detailController: LiteratureDetailController
  entriesKey: string
  linkScopeRef: React.RefObject<string>
  isBatching: boolean
  setIsBatching: (busy: boolean) => void
  setError: (message: string | undefined) => void
  resolveSelectedItemIds: () => Promise<string[]>
  loadEntries: (force?: boolean) => Promise<unknown>
  loadCollections: () => Promise<unknown>
  loadProjectCounts: () => Promise<void>
}): {
  linkFailure: LinkFailure | undefined
  setLinkFailure: React.Dispatch<React.SetStateAction<LinkFailure | undefined>>
  runLinkBatch: (
    command: LinkFailure['command'],
    itemIds?: readonly string[],
    previousCompleted?: number,
    previousSkipped?: number,
    reconcile?: boolean
  ) => Promise<void>
  moveSelectedItems: (collectionId: string) => Promise<void>
  createCollectionForSelection: (name: string) => Promise<boolean>
  addSelectedItemsToProject: (projectId: string) => Promise<void>
} {
  const { t } = useTranslation()
  const [linkFailure, setLinkFailure] = useState<LinkFailure>()
  const clearSelection = (): void => selectionStore.clear()
  const runLinkBatch = async (
    command: NonNullable<typeof linkFailure>['command'],
    itemIds?: readonly string[],
    previousCompleted = 0,
    previousSkipped = 0,
    reconcile = false
  ): Promise<void> => {
    const scopeKey = entriesKey
    setIsBatching(true)
    setError(undefined)
    setLinkFailure(undefined)
    let resolvedIds: readonly string[] = itemIds ?? []
    let completed = 0
    let skipped = previousSkipped
    try {
      resolvedIds = itemIds ?? (await resolveSelectedItemIds())
      if (reconcile) {
        const activeIds: string[] = []
        for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
          const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
          const entries = await Promise.all(batch.map((id) => detailController.read(id)))
          entries.forEach((entry, index) => {
            // get resolves merged aliases; never redirect the original association intent.
            if (
              entry?.id === batch[index] &&
              entry.deletedAt === undefined &&
              entry.mergedIntoItemId === undefined
            )
              activeIds.push(batch[index])
          })
        }
        skipped += resolvedIds.length - activeIds.length
        resolvedIds = activeIds
      }
      for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
        await window.api.literature.transact({ ...command, itemIds: [...batch] })
        completed += batch.length
      }
      if (linkScopeRef.current === scopeKey) {
        clearSelection()
        if (skipped)
          setLinkFailure({
            command,
            itemIds: [],
            completed: previousCompleted + completed,
            scopeKey,
            skipped
          })
      }
    } catch {
      if (linkScopeRef.current === scopeKey) {
        if (resolvedIds.length) {
          const remaining = resolvedIds.slice(completed)
          selectionStore.replace(remaining)
          setLinkFailure({
            command,
            itemIds: remaining,
            completed: previousCompleted + completed,
            skipped,
            scopeKey
          })
        } else {
          setError(t('Selected references could not be loaded.'))
        }
      }
    } finally {
      const refreshed = await Promise.allSettled([
        ...(linkScopeRef.current === scopeKey ? [loadEntries(true)] : []),
        loadCollections(),
        loadProjectCounts()
      ])
      if (
        linkScopeRef.current === scopeKey &&
        refreshed.some((result) => result.status === 'rejected')
      ) {
        setError(t('Literature could not be loaded.'))
      }
      setIsBatching(false)
    }
  }

  const moveSelectedItems = async (targetCollectionId: string): Promise<void> => {
    if (!targetCollectionId || isBatching) return
    await runLinkBatch({
      kind: 'move-collection-items',
      targetCollectionId,
      ...(collectionId ? { sourceCollectionId: collectionId } : {})
    })
  }

  const createCollectionForSelection = async (name: string): Promise<boolean> => {
    const selection = selectionStore.getSnapshot()
    if (!name || (!selection.allMatchingSelected && selection.selectedIds.size === 0) || isBatching)
      return false
    setIsBatching(true)
    setError(undefined)
    const scopeKey = entriesKey
    try {
      // Resolve before creating so every continuation has a fixed reference set.
      const itemIds = await resolveSelectedItemIds()
      if (linkScopeRef.current !== scopeKey) return false
      const receipt = await window.api.literature.transact({ kind: 'create-collection', name })
      void loadCollections().catch(() => undefined)
      await runLinkBatch(
        {
          kind: 'move-collection-items',
          targetCollectionId: receipt.id,
          ...(collectionId ? { sourceCollectionId: collectionId } : {})
        },
        itemIds
      )
      // Creation succeeded even if association needs Retry; retire the creation form.
      return true
    } catch (error) {
      if (linkScopeRef.current === scopeKey)
        setError(
          error instanceof Error && error.message.includes(LITERATURE_COLLECTION_NAME_CONFLICT)
            ? t('A collection with this name already exists at this level. Choose another name.')
            : t('Collection could not be created.')
        )
      return false
    } finally {
      setIsBatching(false)
    }
  }

  const addSelectedItemsToProject = async (projectId: string): Promise<void> => {
    if (!projectId || isBatching) return
    await runLinkBatch({ kind: 'set-project-items', projectId, included: true, source: 'library' })
  }

  return {
    linkFailure,
    setLinkFailure,
    runLinkBatch,
    moveSelectedItems,
    createCollectionForSelection,
    addSelectedItemsToProject
  }
}
