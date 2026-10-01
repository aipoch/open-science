import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView } from '../../../../../shared/literature'
import type { SmartCollectionView } from '../../../../../shared/literature-smart-collections'
import type { LiteratureDetailController } from '../detail/LiteratureDetailController'
import { shouldConfirmSmartReevaluation } from './smart-collection-preferences'
import type { SmartCollectionState } from './smart-collection-state'
type SingleReevaluation = { collectionId: string; itemId: string; previousRunId?: string }
type Reevaluation = { collectionId: string; ids: string[]; detailItemId?: string }

/** Re-evaluation owns run progress and completion receipts without publishing stale scope results. */
export function useLiteratureSmartReevaluation({
  collectionId,
  selectedCollection,
  smartState,
  smartView,
  currentCollectionId,
  collectionsGenerationRef,
  setCollections,
  detailController,
  pendingDecisionsRef,
  isBatching,
  setIsBatching,
  setError,
  resolveSelectedItemIds,
  loadEntries,
  loadCollections,
  clearSelection,
  setSmartBatchResult
}: {
  collectionId?: string
  selectedCollection?: LiteratureCollectionView
  smartState: SmartCollectionState
  smartView?: SmartCollectionView
  currentCollectionId: React.RefObject<string | undefined>
  collectionsGenerationRef: React.RefObject<number>
  setCollections: React.Dispatch<React.SetStateAction<LiteratureCollectionView[]>>
  detailController: LiteratureDetailController
  pendingDecisionsRef: React.RefObject<Set<string>>
  isBatching: boolean
  setIsBatching: (busy: boolean) => void
  setError: (message: string | undefined) => void
  resolveSelectedItemIds: () => Promise<string[]>
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  loadCollections: () => Promise<unknown>
  clearSelection: () => void
  setSmartBatchResult: (value: undefined) => void
}): {
  smartResultSnapshot: React.RefObject<string | undefined>
  smartRunningCollection: string | undefined
  singleReevaluation: SingleReevaluation | undefined
  completedReevaluation: SingleReevaluation | undefined
  smartReevaluation: Reevaluation | undefined
  setSmartReevaluation: React.Dispatch<React.SetStateAction<Reevaluation | undefined>>
  smartReevaluationRemember: boolean
  setSmartReevaluationRemember: React.Dispatch<React.SetStateAction<boolean>>
  refreshSmartSummary: () => Promise<boolean>
  receiveSmartView: (view: SmartCollectionView | undefined, updating: boolean) => void
  updateSmartEvidence: () => Promise<void>
  prepareSmartReevaluation: (ids?: string[], detailItemId?: string) => Promise<void>
  runSmartReevaluation: (request?: Reevaluation) => Promise<void>
} {
  const { t } = useTranslation()
  const smartResultSnapshot = useRef<string | undefined>(undefined)
  const [smartRunningCollection, setSmartRunningCollection] = useState<string>()
  const [singleReevaluation, setSingleReevaluation] = useState<{
    collectionId: string
    itemId: string
    previousRunId?: string
  }>()
  const [completedReevaluation, setCompletedReevaluation] = useState<typeof singleReevaluation>()
  useEffect(() => {
    if (!completedReevaluation) return
    const timer = setTimeout(() => setCompletedReevaluation(undefined), 1600)
    return () => clearTimeout(timer)
  }, [completedReevaluation])
  const singleReevaluationRef = useRef<typeof singleReevaluation>(undefined)
  const [smartReevaluation, setSmartReevaluation] = useState<{
    collectionId: string
    ids: string[]
    detailItemId?: string
  }>()
  const [smartReevaluationRemember, setSmartReevaluationRemember] = useState(false)

  const refreshSmartSummary = useCallback(async () => {
    if (!collectionId) return false
    const token = smartState.beginRead()
    const receipt = await window.api.literature.transact({
      kind: 'smart-collection',
      collectionId,
      action: 'read',
      summaryOnly: true,
      offset: 0
    })
    return Boolean(receipt.smart) && smartState.acceptRead(token, receipt.smart)
  }, [collectionId, smartState])
  const receiveSmartView = useCallback(
    (view: SmartCollectionView | undefined, updating: boolean): void => {
      if (!collectionId || currentCollectionId.current !== collectionId) return
      setSmartRunningCollection(updating ? collectionId : undefined)
      if (!updating && singleReevaluationRef.current?.collectionId === collectionId) {
        if (
          view?.run?.state === 'completed' &&
          !view.run.failure &&
          view.run.id !== singleReevaluationRef.current.previousRunId
        )
          setCompletedReevaluation(singleReevaluationRef.current)
        singleReevaluationRef.current = undefined
        setSingleReevaluation(undefined)
      }
      if (updating) {
        smartResultSnapshot.current = collectionId
        return
      }

      if (view) {
        collectionsGenerationRef.current++
        setCollections((current) => {
          const index = current.findIndex((collection) => collection.id === collectionId)
          if (index < 0 || current[index].itemCount === view.counts.match) return current
          const next = [...current]
          next[index] = { ...current[index], itemCount: view.counts.match }
          return next
        })
      }
      if (smartResultSnapshot.current === collectionId) {
        smartResultSnapshot.current = undefined
        void Promise.all([loadEntries(true, true), loadCollections()]).catch(() =>
          setError(t('Literature could not be loaded.'))
        )
      }
    },
    [
      collectionId,
      loadEntries,
      loadCollections,
      t,
      collectionsGenerationRef,
      currentCollectionId,
      setCollections,
      setError
    ]
  )

  const updateSmartEvidence = async (): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      pendingDecisionsRef.current.size > 0 ||
      smartRunningCollection === selectedCollection.id
    )
      return
    setIsBatching(true)
    smartState.beginWrite()
    try {
      const receipt = await window.api.literature.transact({
        kind: 'smart-collection',
        collectionId: selectedCollection.id,
        action: 'refresh',
        offset: 0
      })
      smartState.finishWrite(receipt.smart)
    } catch {
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  const prepareSmartReevaluation = async (ids?: string[], detailItemId?: string): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      pendingDecisionsRef.current.size > 0 ||
      smartRunningCollection === selectedCollection.id
    )
      return
    setIsBatching(true)
    let request: typeof smartReevaluation
    try {
      setSmartBatchResult(undefined)
      const detail = detailController.getSnapshot()
      request = {
        collectionId: selectedCollection.id,
        ids: ids ?? (await resolveSelectedItemIds()),
        detailItemId:
          detailItemId ??
          (detail.open && ids?.length === 1 && ids[0] === detail.item?.id
            ? detail.item.id
            : undefined)
      }
    } catch {
      setError(t('Literature could not be loaded.'))
    } finally {
      setIsBatching(false)
    }
    if (!request || currentCollectionId.current !== request.collectionId) return
    if (request.ids.length === 1 || !shouldConfirmSmartReevaluation()) {
      void runSmartReevaluation(request)
    } else {
      setSmartReevaluationRemember(false)
      setSmartReevaluation(request)
    }
  }
  const runSmartReevaluation = async (request = smartReevaluation): Promise<void> => {
    if (
      !request ||
      currentCollectionId.current !== request.collectionId ||
      (isBatching && request === smartReevaluation)
    )
      return
    setIsBatching(true)
    smartState.beginWrite()
    const single =
      request.ids.length === 1
        ? {
            collectionId: request.collectionId,
            itemId: request.ids[0],
            previousRunId: smartView?.run?.id
          }
        : undefined
    setCompletedReevaluation(undefined)
    singleReevaluationRef.current = single
    setSingleReevaluation(single)
    receiveSmartView(smartView, true)
    try {
      const receipt = await window.api.literature.transact({
        kind: 'smart-collection',
        collectionId: request.collectionId,
        action: 'recompute',
        itemIds: request.ids,
        offset: 0
      })
      smartState.finishWrite(receipt.smart)
      if (receipt.smart?.run?.state !== 'running' && receipt.smart?.run?.state !== 'queued')
        receiveSmartView(receipt.smart, false)
      setSmartReevaluation(undefined)
      if (
        currentCollectionId.current === request.collectionId &&
        !request.detailItemId &&
        request.ids.length > 1
      )
        clearSelection()
    } catch {
      receiveSmartView(smartView, false)
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  return {
    smartResultSnapshot,
    smartRunningCollection,
    singleReevaluation,
    completedReevaluation,
    smartReevaluation,
    setSmartReevaluation,
    smartReevaluationRemember,
    setSmartReevaluationRemember,
    refreshSmartSummary,
    receiveSmartView,
    updateSmartEvidence,
    prepareSmartReevaluation,
    runSmartReevaluation
  }
}
