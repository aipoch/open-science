import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureDetailController } from '@aipoch/literature-library/client'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type { LiteratureSelectionStore } from '../list/literature-selection'
import { useLiteratureHost } from '../renderer-host'

export type LiteratureReadingStatus = NonNullable<LiteratureItemView['readingStatus']>

/** Resolve the entire selection before writes can change its filtered membership or ordering. */
export function useLiteratureReadingStatus({
  scopeKey,
  selectionStore,
  resolveSelectedItemIds,
  isBatching,
  setIsBatching,
  detailController,
  loadEntries,
  setError
}: {
  scopeKey: string
  selectionStore: LiteratureSelectionStore
  resolveSelectedItemIds: () => Promise<string[]>
  isBatching: boolean
  setIsBatching: (busy: boolean) => void
  detailController: LiteratureDetailController
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  setError: (message: string | undefined) => void
}): {
  setReadingStatus: (status: LiteratureReadingStatus, itemIds?: string[]) => Promise<void>
  readingStatusError: { itemId: string; message: string } | undefined
  readingStatusPending: boolean
} {
  const { api } = useLiteratureHost()
  const { t } = useTranslation()
  const visit = useMemo(() => ({ scopeKey }), [scopeKey])
  const [error, setStatusError] = useState<{
    visit: typeof visit
    itemId: string
    message: string
  }>()
  const currentVisit = useRef<typeof visit | undefined>(visit)
  const pending = useRef(false)
  const [readingStatusPending, setReadingStatusPending] = useState(false)
  useLayoutEffect(() => {
    currentVisit.current = visit
    return () => {
      currentVisit.current = undefined
    }
  }, [visit])

  const setReadingStatus = async (
    readingStatus: LiteratureReadingStatus,
    itemIds?: string[]
  ): Promise<void> => {
    if (isBatching || pending.current || currentVisit.current !== visit) return
    pending.current = true
    setReadingStatusPending(true)
    setIsBatching(true)
    setError(undefined)
    setStatusError(undefined)
    const isCurrent = (): boolean => currentVisit.current === visit
    const isSelection = itemIds === undefined
    let targets: string[] = []
    let completed = 0
    let failure: string | undefined
    try {
      targets = [...new Set(itemIds ?? (await resolveSelectedItemIds()))]
      if (!isCurrent()) return
      for (let offset = 0; offset < targets.length; offset += 200) {
        if (!isCurrent()) return
        const batch = targets.slice(offset, offset + 200)
        await api.literature.transact({
          kind: 'set-reading-status',
          itemIds: batch,
          readingStatus
        })
        completed += batch.length
      }
      if (isCurrent() && isSelection) selectionStore.clear()
    } catch {
      if (isCurrent()) {
        if (isSelection && targets.length) selectionStore.replace(targets.slice(completed))
        failure = targets.length
          ? t('Literature could not be updated.')
          : t('Selected references could not be loaded.')
        setError(failure)
      }
    } finally {
      if (isCurrent() && targets.length) {
        try {
          // Read authoritative state; never resubmit or replace the item's metadata to set status.
          const detail = detailController.getSnapshot()
          const latest =
            detail.item && targets.includes(detail.item.id)
              ? await detailController.read(detail.item.id)
              : undefined
          if (isCurrent()) {
            if (latest && detailController.getSnapshot().generation === detail.generation)
              detailController.replace(latest)
            const loaded = await loadEntries(true, true)
            if (isCurrent() && loaded === false && !failure)
              failure = t('The reference was saved, but could not be reloaded.')
          }
        } catch {
          if (isCurrent() && !failure)
            failure = t('The reference was saved, but could not be reloaded.')
        }
      }
      if (isCurrent() && failure) {
        setError(failure)
        if (!isSelection && targets[0])
          setStatusError({ visit, itemId: targets[0], message: failure })
      }
      pending.current = false
      if (currentVisit.current) {
        setReadingStatusPending(false)
        setIsBatching(false)
      }
    }
  }
  return {
    setReadingStatus,
    readingStatusError: error?.visit === visit ? error : undefined,
    readingStatusPending
  }
}
