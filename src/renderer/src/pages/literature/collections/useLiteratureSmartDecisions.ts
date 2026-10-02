import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView } from '../../../../../shared/literature'
import type { LiteratureDetailController } from '../detail/LiteratureDetailController'
import type { LiteratureSelectionStore } from '../list/literature-selection'
import type { SmartCollectionState } from './smart-collection-state'
import type { useSmartDecisionBatch } from './useSmartDecisionBatch'
type DecisionFailure = { key: string; collection: string; retry: () => void }
type BatchResult = {
  collectionId: string
  done: number
  failed: string[]
  remaining: string[]
  decision: 'include' | 'exclude' | 'automatic'
}

/** Serialize row decisions and retain acknowledged batch progress independently of query refreshes. */
export function useLiteratureSmartDecisions({
  selectedCollection,
  smartState,
  currentSmartState,
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
  smartRunningCollection,
  consumePendingCollectionChange,
  currentEntriesReload,
  smartDecisionBatch,
  selectionStore,
  refreshSmartSummary
}: {
  selectedCollection?: LiteratureCollectionView
  smartState: SmartCollectionState
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
  currentSmartState: React.RefObject<SmartCollectionState>
  smartRunningCollection?: string
  consumePendingCollectionChange: (id: string) => void
  currentEntriesReload: React.RefObject<
    (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  >
  smartDecisionBatch: ReturnType<typeof useSmartDecisionBatch>
  selectionStore: LiteratureSelectionStore
  refreshSmartSummary: () => Promise<boolean>
}): {
  pendingDecisions: Set<string>
  decisionFailures: DecisionFailure[]
  setDecisionFailures: React.Dispatch<React.SetStateAction<DecisionFailure[]>>
  smartRefreshFailure: string | undefined
  setSmartRefreshFailure: React.Dispatch<React.SetStateAction<string | undefined>>
  smartBatchResult: BatchResult | undefined
  setSmartBatchResult: React.Dispatch<React.SetStateAction<BatchResult | undefined>>
  confirmSmartDecision: (
    decision: 'include' | 'exclude' | 'automatic',
    itemIds?: string[],
    singleRecord?: boolean
  ) => Promise<void>
} {
  const { t } = useTranslation()
  const [pendingDecisions, setPendingDecisions] = useState<Set<string>>(new Set())
  const decisionQueue = useRef(Promise.resolve())
  const [decisionFailures, setDecisionFailures] = useState<
    Array<{ key: string; collection: string; retry: () => void }>
  >([])
  const [smartRefreshFailure, setSmartRefreshFailure] = useState<string>()
  const [smartBatchResult, setSmartBatchResult] = useState<{
    collectionId: string
    done: number
    failed: string[]
    remaining: string[]
    decision: 'include' | 'exclude' | 'automatic'
  }>()
  const confirmSmartDecision = async (
    decision: 'include' | 'exclude' | 'automatic',
    itemIds?: string[],
    singleRecord = false
  ): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      smartRunningCollection === selectedCollection.id
    )
      return
    const targetCollectionId = selectedCollection.id
    if (singleRecord && itemIds?.length === 1) {
      const itemId = itemIds[0]
      const operationKey = `${targetCollectionId}:${itemId}`
      if (pendingDecisionsRef.current.has(operationKey)) return
      pendingDecisionsRef.current.add(operationKey)
      setPendingDecisions(new Set(pendingDecisionsRef.current))
      const submit = async (): Promise<void> => {
        let saved = false
        const owner =
          currentSmartState.current.collectionId === targetCollectionId
            ? currentSmartState.current
            : smartState
        owner.beginWrite()
        collectionsGenerationRef.current++
        if (currentCollectionId.current === targetCollectionId) setError(undefined)
        setDecisionFailures((current) => current.filter((failure) => failure.key !== operationKey))
        try {
          const receipt = await window.api.literature.transact({
            kind: 'smart-collection',
            collectionId: targetCollectionId,
            action: 'override',
            itemId,
            decision,
            offset: 0
          })
          saved = true
          collectionsGenerationRef.current++
          consumePendingCollectionChange(targetCollectionId)
          owner.finishWrite(receipt.smart)
          if (
            currentSmartState.current.collectionId === targetCollectionId &&
            currentSmartState.current !== owner
          )
            currentSmartState.current.finishWrite(receipt.smart)
          if (receipt.smart) {
            const view = receipt.smart
            setCollections((current) =>
              current.map((collection) =>
                collection.id === targetCollectionId
                  ? { ...collection, itemCount: view.counts.match }
                  : collection
              )
            )
            if (currentCollectionId.current === targetCollectionId) {
              const detail = detailController.getSnapshot().item
              const row = view.rows.find((row) => row.id === itemId)
              if (detail?.id === itemId && row)
                detailController.replace({ ...detail, smartDecision: row })
            }
          }
          if (receipt.smartRefreshFailed) setSmartRefreshFailure(targetCollectionId)
          if (currentCollectionId.current !== targetCollectionId) return
          const refreshed = await currentEntriesReload.current(true, true)
          setSmartRefreshFailure(
            receipt.smartRefreshFailed || refreshed === false ? targetCollectionId : undefined
          )
        } catch {
          if (saved) setSmartRefreshFailure(targetCollectionId)
          else
            setDecisionFailures((current) => [
              ...current.filter((failure) => failure.key !== operationKey),
              {
                key: operationKey,
                collection: selectedCollection.name,
                retry: () => {
                  void confirmSmartDecision(decision, [itemId], true)
                }
              }
            ])
        } finally {
          owner.finishWrite()
          collectionsGenerationRef.current++
        }
      }
      const queued = decisionQueue.current.then(submit)
      decisionQueue.current = queued.catch(() => undefined)
      try {
        await queued
      } finally {
        pendingDecisionsRef.current.delete(operationKey)
        setPendingDecisions(new Set(pendingDecisionsRef.current))
      }
      return
    }
    if (pendingDecisionsRef.current.size) return
    setIsBatching(true)
    setError(undefined)
    try {
      const ids = itemIds ?? (await resolveSelectedItemIds())
      if (currentCollectionId.current !== targetCollectionId) return
      smartState.beginWrite()
      const { done, failed, remaining } = await smartDecisionBatch.run(
        targetCollectionId,
        ids,
        decision
      )
      setSmartBatchResult(
        failed.length > 0 || remaining.length > 0
          ? {
              collectionId: targetCollectionId,
              done,
              failed,
              remaining,
              decision
            }
          : undefined
      )
      if (currentCollectionId.current === targetCollectionId) {
        selectionStore.replace([...failed, ...remaining])
        consumePendingCollectionChange(targetCollectionId)
        smartState.finishWrite()
        await Promise.all([loadEntries(true, true), loadCollections(), refreshSmartSummary()])
      }
    } catch {
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  return {
    pendingDecisions,
    decisionFailures,
    setDecisionFailures,
    smartRefreshFailure,
    setSmartRefreshFailure,
    smartBatchResult,
    setSmartBatchResult,
    confirmSmartDecision
  }
}
