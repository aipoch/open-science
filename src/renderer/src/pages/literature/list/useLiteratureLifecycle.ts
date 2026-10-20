import { useLiteratureHost } from '../renderer-host'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  parseLiteratureDeletionError,
  type LiteratureDeletionDiagnostic
} from '../../../../../shared/literature-deletion'
import { useLiteratureClient } from '../literature-read-pages'

import type {
  LiteratureCatalogReceipt,
  LiteratureCatalogSearchRequest,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'

import type { LiteratureSelectionStore } from './literature-selection'
type RestorePreview = { itemIds: string[]; skipped: number }
type DeletionResult = { scope: string; cleanupPending: boolean; refreshFailed: boolean }
type LifecycleFailure = { itemIds: string[]; state: 'active' | 'deleted'; completed: number }

const LITERATURE_BATCH_COMMAND_SIZE = 200
const isItem = (entry: unknown): entry is LiteratureItemView =>
  typeof entry === 'object' && entry !== null && 'item' in entry && 'metadataRevision' in entry

/** Trash/recovery owns partial batch receipts; refresh failures never roll back committed writes. */
export function useLiteratureLifecycle({
  scope,
  selection: selectionStore,
  batch: { busy: isBatching, setBusy: setIsBatching },
  query: {
    key: entriesKey,
    currentKey: linkScopeRef,
    build: buildEntriesRequest,
    resolveSelectedItemIds
  },
  refresh: {
    entries: loadEntries,
    collections: loadCollections,
    projects: loadProjectCounts,
    tags: loadTags
  },
  onError: setError
}: {
  scope: string
  selection: LiteratureSelectionStore
  batch: { busy: boolean; setBusy: (busy: boolean) => void }
  query: {
    key: string
    currentKey: React.RefObject<string>
    build: (offset?: number) => LiteratureCatalogSearchRequest
    resolveSelectedItemIds: () => Promise<string[]>
  }
  refresh: {
    entries: (force?: boolean) => Promise<unknown>
    collections: () => Promise<unknown>
    projects: () => Promise<void>
    tags: () => Promise<void>
  }
  onError: (message: string | undefined) => void
}): {
  restorePreview: RestorePreview | undefined
  setRestorePreview: React.Dispatch<React.SetStateAction<RestorePreview | undefined>>
  dialogRestorePreview: RestorePreview | undefined
  permanentDeleteIds: string[]
  setPermanentDeleteIds: React.Dispatch<React.SetStateAction<string[]>>
  permanentDeleteFailed: boolean
  permanentDeletionDiagnostic: LiteratureDeletionDiagnostic | undefined
  permanentDeleteResult: DeletionResult | undefined
  lifecycleFailure: LifecycleFailure | undefined
  setLifecycleFailure: React.Dispatch<React.SetStateAction<LifecycleFailure | undefined>>
  previewRestoreSelection: () => Promise<void>
  setItemsLifecycle: (
    itemIds: readonly string[] | undefined,
    state: 'active' | 'deleted'
  ) => Promise<void>
  runLifecycleAction: (state: 'active' | 'deleted') => Promise<void>
  requestPermanentDeletion: (itemIds: string[]) => void
  refreshAfterPermanentDeletion: () => Promise<void>
  deleteItemsPermanently: () => Promise<void>
} {
  const { readLiteratureSelectionPage } = useLiteratureClient()

  const { useTagStore } = useLiteratureHost()

  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const clearSelection = (): void => selectionStore.clear()
  const [restorePreview, setRestorePreview] = useState<RestorePreview>()
  const dialogRestorePreview = useRetainedDialogValue(restorePreview)
  const [permanentDeleteIds, setPermanentDeleteIds] = useState<string[]>([])
  const [permanentDeleteFailed, setPermanentDeleteFailed] = useState(false)
  const [permanentDeletionDiagnostic, setPermanentDeletionDiagnostic] =
    useState<LiteratureDeletionDiagnostic>()
  const [permanentDeleteResult, setPermanentDeleteResult] = useState<DeletionResult>()
  const permanentDeleteScope = scope
  if (permanentDeleteResult && permanentDeleteResult.scope !== permanentDeleteScope) {
    setPermanentDeleteResult(undefined)
  }
  const [lifecycleFailure, setLifecycleFailure] = useState<LifecycleFailure>()
  // A query key can recur after navigating away and back. Completion authority belongs to the
  // original visit, not just a matching key; retained commands also lose authority on unmount.
  const lifecycleContext = useMemo(() => ({ entriesKey }), [entriesKey])
  const currentLifecycleContext = useRef<typeof lifecycleContext | undefined>(lifecycleContext)
  useLayoutEffect(() => {
    currentLifecycleContext.current = lifecycleContext
    return () => {
      currentLifecycleContext.current = undefined
    }
  }, [lifecycleContext])
  const previewRestoreSelection = async (): Promise<void> => {
    if (isBatching) return
    const scopeKey = entriesKey
    setIsBatching(true)
    setError(undefined)
    try {
      const selectedIds = new Set(await resolveSelectedItemIds())
      const restorable = new Set<string>()
      const skipped = new Set<string>()
      const seenOffsets = new Set<number>()
      let offset = 0
      for (;;) {
        if (seenOffsets.has(offset)) throw new Error('Repeated Literature page.')
        seenOffsets.add(offset)
        const page = await readLiteratureSelectionPage({
          ...buildEntriesRequest(offset),
          limit: 100
        })
        if (linkScopeRef.current !== scopeKey) return
        for (const entry of page.entries.filter(isItem)) {
          if (!selectedIds.has(entry.id)) continue
          if (entry.mergedIntoItemId) skipped.add(entry.id)
          else restorable.add(entry.id)
        }
        if (page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      if (restorable.size + skipped.size !== selectedIds.size)
        throw new Error('Selected Literature membership changed.')
      setRestorePreview({ itemIds: [...restorable], skipped: skipped.size })
    } catch {
      if (linkScopeRef.current === scopeKey) setError(t('Selected references could not be loaded.'))
    } finally {
      setIsBatching(false)
    }
  }

  const setItemsLifecycle = async (
    itemIds: readonly string[] | undefined,
    state: 'active' | 'deleted'
  ): Promise<void> => {
    const { allMatchingSelected } = selectionStore.getSnapshot()
    if ((!allMatchingSelected && (itemIds?.length ?? 0) === 0) || isBatching) return
    setIsBatching(true)
    setError(undefined)
    setLifecycleFailure(undefined)
    let resolvedIds: readonly string[] = []
    let completed = 0
    const isCurrent = (): boolean => currentLifecycleContext.current === lifecycleContext
    try {
      resolvedIds = itemIds ?? (await resolveSelectedItemIds())
      for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
        await hostApi.literature.transact({ kind: 'set-item-lifecycle', itemIds: batch, state })
        completed += batch.length
      }
      if (isCurrent()) clearSelection()
    } catch {
      if (isCurrent()) {
        if (resolvedIds.length) {
          const remaining = resolvedIds.slice(completed)
          selectionStore.replace(remaining)
          setLifecycleFailure({ itemIds: remaining, state, completed })
        } else {
          setError(t('Literature could not be updated.'))
        }
      }
    } finally {
      if (resolvedIds.length) {
        // Refresh even after a failed command: earlier batches may already be committed.
        const refreshed = await Promise.allSettled([
          loadEntries(true),
          loadCollections(),
          loadProjectCounts()
        ])
        if (isCurrent() && refreshed.some((result) => result.status === 'rejected')) {
          setError(t('Literature could not be loaded.'))
        }
      }
      setIsBatching(false)
    }
  }

  const runLifecycleAction = async (state: 'active' | 'deleted'): Promise<void> => {
    const { allMatchingSelected, selectedIds } = selectionStore.getSnapshot()
    return setItemsLifecycle(allMatchingSelected ? undefined : [...selectedIds], state)
  }

  const requestPermanentDeletion = (itemIds: string[]): void => {
    setPermanentDeleteFailed(false)
    setPermanentDeletionDiagnostic(undefined)
    setPermanentDeleteIds(itemIds)
  }

  const refreshAfterPermanentDeletion = async (): Promise<void> => {
    setIsBatching(true)
    try {
      const refreshed = await Promise.allSettled([
        loadEntries(true),
        loadCollections(),
        loadProjectCounts(),
        loadTags()
      ])
      setPermanentDeleteResult(
        (current) =>
          current && {
            ...current,
            refreshFailed:
              refreshed.some((result) => result.status === 'rejected') ||
              useTagStore.getState().status === 'error'
          }
      )
    } finally {
      setIsBatching(false)
    }
  }

  const deleteItemsPermanently = async (): Promise<void> => {
    if (permanentDeleteIds.length === 0 || isBatching || permanentDeleteFailed) return
    setIsBatching(true)
    setError(undefined)
    setPermanentDeleteResult(undefined)
    let receipt: LiteratureCatalogReceipt
    try {
      receipt = await hostApi.literature.transact({
        kind: 'delete-items-permanently',
        itemIds: permanentDeleteIds
      })
    } catch (error) {
      setPermanentDeletionDiagnostic(parseLiteratureDeletionError(error))
      setPermanentDeleteFailed(true)
      setIsBatching(false)
      return
    }
    clearSelection()
    setPermanentDeleteIds([])
    setPermanentDeleteResult({
      scope: permanentDeleteScope,
      cleanupPending: receipt.cleanupPending === true,
      refreshFailed: false
    })
    await refreshAfterPermanentDeletion()
  }

  return {
    restorePreview,
    setRestorePreview,
    dialogRestorePreview,
    permanentDeleteIds,
    setPermanentDeleteIds,
    permanentDeleteFailed,
    permanentDeletionDiagnostic,
    permanentDeleteResult,
    lifecycleFailure,
    setLifecycleFailure,
    previewRestoreSelection,
    setItemsLifecycle,
    runLifecycleAction,
    requestPermanentDeletion,
    refreshAfterPermanentDeletion,
    deleteItemsPermanently
  }
}
