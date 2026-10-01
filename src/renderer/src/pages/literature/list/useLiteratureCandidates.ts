import { useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCatalogCommand,
  LiteratureInboxCandidateView
} from '../../../../../shared/literature'
import { readMatchingCandidateIds } from '../literature-inbox-reconciliation'
import type { LiteratureSelectionStore } from './literature-selection'

const LITERATURE_INBOX_COMMAND_SIZE = 100

type DismissedCandidateUndo = Readonly<{
  candidateIds: readonly string[]
  detail: string
  needsRecheck?: boolean
}>

type CandidateWorkflowOptions = {
  selection: LiteratureSelectionStore
  batch: { busy: boolean; setBusy: (busy: boolean) => void }
  entries: {
    candidates: LiteratureInboxCandidateView[]
    update: Dispatch<SetStateAction<LiteratureInboxCandidateView[]>>
    reload: (force?: boolean) => Promise<unknown>
    failed: boolean
  }
  counts: {
    reloadProjects: () => Promise<void>
    reloadInbox: () => Promise<void>
    updatePending: Dispatch<SetStateAction<number | undefined>>
    updateDismissed: Dispatch<SetStateAction<number | undefined>>
  }
  onError: (error: string | undefined) => void
}

export function useLiteratureCandidates({
  selection: selectionStore,
  batch: { busy: isBatching, setBusy: setIsBatching },
  entries: { candidates, update: setCandidates, reload: loadEntries, failed: entriesFailed },
  counts: {
    reloadProjects: loadProjectCounts,
    reloadInbox: loadInboxCounts,
    updatePending: setInboxPendingCount,
    updateDismissed: setInboxDismissedCount
  },
  onError: setError
}: CandidateWorkflowOptions): {
  pendingCandidateId: string | undefined
  dismissedCandidateUndo: DismissedCandidateUndo | undefined
  candidateUpdateUncertain: boolean
  candidateCountsFailed: boolean
  undoNotice: string | undefined
  retryCandidateReads: () => Promise<void>
  changeCandidateState: (
    candidateId: string,
    kind: 'accept-candidate' | 'dismiss-candidate'
  ) => Promise<boolean>
  settleSelectedCandidates: (state: 'accepted' | 'dismissed') => Promise<void>
  restoreDismissedCandidates: (candidateIds?: readonly string[]) => Promise<boolean>
  dismissUndo: () => void
} {
  const { t } = useTranslation()
  const clearSelection = (): void => selectionStore.clear()
  const [pendingCandidateId, setPendingCandidateId] = useState<string>()
  const [dismissedCandidateUndo, setDismissedCandidateUndo] = useState<DismissedCandidateUndo>()
  const [candidateUpdateUncertain, setCandidateUpdateUncertain] = useState(false)
  const [candidateCountsFailed, setCandidateCountsFailed] = useState(false)
  const [undoNotice, setUndoNotice] = useState<string>()
  const dismissedUndo = (candidateIds: readonly string[]): DismissedCandidateUndo | undefined =>
    candidateIds.length
      ? {
          candidateIds,
          detail: t('{{count}} references', {
            count: candidateIds.length,
            defaultValue_one: '{{count}} reference'
          })
        }
      : undefined

  const refreshCandidateProjectCounts = async (): Promise<void> => {
    try {
      await loadProjectCounts()
      setCandidateCountsFailed(false)
    } catch {
      setCandidateCountsFailed(true)
    }
  }

  const refreshCandidateInboxCount = async (): Promise<void> => {
    try {
      await loadInboxCounts()
    } catch {
      setInboxPendingCount(undefined)
      setError(t('Literature could not be loaded.'))
    }
  }

  const retryCandidateReads = async (): Promise<void> => {
    if (isBatching || pendingCandidateId) return
    setIsBatching(true)
    setCandidateUpdateUncertain(false)
    try {
      await Promise.all([loadEntries(true), refreshCandidateProjectCounts()])
      await refreshCandidateInboxCount()
    } finally {
      setIsBatching(false)
    }
  }

  const submitCandidateChange = async (
    candidateIds: string[],
    state: 'accepted' | 'dismissed',
    command: Extract<
      LiteratureCatalogCommand,
      { kind: 'accept-candidate' | 'dismiss-candidate' | 'settle-candidates' }
    >
  ): Promise<boolean> => {
    setError(undefined)
    setCandidateUpdateUncertain(false)
    setUndoNotice(undefined)
    try {
      await window.api.literature.transact(command)
    } catch {
      // A rejected transport response does not prove that the transaction rolled back.
      // Reload handles its own read errors; never put a saved candidate snapshot back here.
      if (state === 'dismissed') {
        const undoIds = [
          ...new Set([...(dismissedCandidateUndo?.candidateIds ?? []), ...candidateIds])
        ]
        // Keep recovery reachable even if the following reads are also unavailable.
        setDismissedCandidateUndo({ ...dismissedUndo(undoIds)!, needsRecheck: true })
        await Promise.all([recheckDismissedCandidates(undoIds), refreshCandidateProjectCounts()])
      } else {
        await Promise.all([loadEntries(true), refreshCandidateProjectCounts()])
        await refreshCandidateInboxCount()
      }
      setCandidateUpdateUncertain(true)
      return false
    }
    if (state === 'dismissed') {
      setDismissedCandidateUndo((current) => {
        const candidateIdsToUndo = [...new Set([...(current?.candidateIds ?? []), ...candidateIds])]
        const undo = dismissedUndo(candidateIdsToUndo)!
        return {
          ...undo,
          needsRecheck: current?.needsRecheck,
          detail:
            candidateIdsToUndo.length === 1
              ? (candidates.find(({ id }) => id === candidateIdsToUndo[0])?.candidate.item.title ??
                undo.detail)
              : undo.detail
        }
      })
    }
    if (state === 'dismissed')
      setInboxDismissedCount((current) =>
        current === undefined ? current : current + candidateIds.length
      )
    const settledIds = new Set(candidateIds)
    setCandidates((current) => current.filter(({ id }) => !settledIds.has(id)))
    candidateIds.forEach((id) => selectionStore.remove(id))
    setInboxPendingCount((current) =>
      current === undefined ? current : Math.max(0, current - candidateIds.length)
    )
    // Committed writes stay committed even when an independent refresh fails.
    await Promise.all([
      loadEntries(true),
      ...(state === 'accepted' ? [refreshCandidateProjectCounts()] : [])
    ])
    return true
  }

  const changeCandidateState = async (
    candidateId: string,
    kind: 'accept-candidate' | 'dismiss-candidate'
  ): Promise<boolean> => {
    if (isBatching || pendingCandidateId || entriesFailed) return false
    setPendingCandidateId(candidateId)
    try {
      return await submitCandidateChange(
        [candidateId],
        kind === 'accept-candidate' ? 'accepted' : 'dismissed',
        { kind, candidateId }
      )
    } finally {
      setPendingCandidateId(undefined)
    }
  }

  const settleSelectedCandidates = async (state: 'accepted' | 'dismissed'): Promise<void> => {
    const { selectedIds } = selectionStore.getSnapshot()
    const candidateIds = candidates.map(({ id }) => id).filter((id) => selectedIds.has(id))
    if (!candidateIds.length || isBatching || pendingCandidateId || entriesFailed) return
    setIsBatching(true)
    clearSelection()
    try {
      await submitCandidateChange(candidateIds, state, {
        kind: 'settle-candidates',
        candidateIds,
        state
      })
    } finally {
      setIsBatching(false)
    }
  }

  const recheckDismissedCandidates = async (candidateIds: readonly string[]): Promise<void> => {
    setDismissedCandidateUndo({ ...dismissedUndo(candidateIds)!, needsRecheck: true })
    try {
      const wanted = new Set(candidateIds)
      const readMatchingIds = (state: 'pending' | 'dismissed'): Promise<Set<string>> =>
        readMatchingCandidateIds(wanted, state)
      const dismissed = await readMatchingIds('dismissed')
      const pending =
        dismissed.size === wanted.size ? new Set<string>() : await readMatchingIds('pending')
      const remaining = candidateIds.filter((id) => dismissed.has(id))
      const alreadyRestored = candidateIds.filter(
        (id) => !dismissed.has(id) && pending.has(id)
      ).length
      setDismissedCandidateUndo(dismissedUndo(remaining))
      setUndoNotice(
        t(
          'Already restored: {{restored}}. Accepted or unavailable, skipped: {{skipped}}. Still dismissed: {{remaining}}.',
          {
            restored: alreadyRestored,
            skipped: candidateIds.length - remaining.length - alreadyRestored,
            remaining: remaining.length
          }
        )
      )
    } catch {
      setUndoNotice(t('The remaining references could not be checked. Recheck before undoing.'))
    }
    await loadEntries(true)
    await refreshCandidateInboxCount()
  }

  const restoreDismissedCandidates = async (
    candidateIds: readonly string[] = dismissedCandidateUndo?.candidateIds ?? []
  ): Promise<boolean> => {
    if (candidateIds.length === 0 || isBatching || pendingCandidateId) return false
    setIsBatching(true)
    setError(undefined)
    setUndoNotice(undefined)
    let remaining = [...candidateIds]
    let undoRemaining = [...(dismissedCandidateUndo?.candidateIds ?? [])]
    try {
      if (dismissedCandidateUndo?.needsRecheck) {
        await recheckDismissedCandidates([...new Set([...undoRemaining, ...remaining])])
        return false
      }
      while (remaining.length) {
        const batch = remaining.slice(0, LITERATURE_INBOX_COMMAND_SIZE)
        try {
          await window.api.literature.transact({ kind: 'restore-candidates', candidateIds: batch })
        } catch {
          await recheckDismissedCandidates([...new Set([...undoRemaining, ...remaining])])
          return false
        }
        remaining = remaining.slice(batch.length)
        undoRemaining = undoRemaining.filter((id) => !batch.includes(id))
        setInboxDismissedCount((current) =>
          current === undefined ? current : Math.max(0, current - batch.length)
        )
        setDismissedCandidateUndo(dismissedUndo(undoRemaining))
        for (const id of batch) selectionStore.remove(id)
        setCandidates((current) => current.filter(({ id }) => !batch.includes(id)))
        setInboxPendingCount((current) =>
          current === undefined ? current : current + batch.length
        )
      }
      await loadEntries(true)
      await refreshCandidateInboxCount()
      return true
    } finally {
      setIsBatching(false)
    }
  }

  const dismissUndo = (): void => {
    setDismissedCandidateUndo(undefined)
    setUndoNotice(undefined)
  }
  return {
    pendingCandidateId,
    dismissedCandidateUndo,
    candidateUpdateUncertain,
    candidateCountsFailed,
    undoNotice,
    retryCandidateReads,
    changeCandidateState,
    settleSelectedCandidates,
    restoreDismissedCandidates,
    dismissUndo
  }
}
