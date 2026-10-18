import type { LiteratureInboxCandidateView } from '@aipoch/literature-library/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isCollectionOnlyChange, useLiteratureChanges } from '../literature/useLiteratureChanges'
import type { LiteratureToolSummary } from './literature-tool-presentation'

// Receipts describe the save operation, not the current Inbox. Keep the transcript immutable
// and project current catalog state onto only the candidate identities actually saved by it.
export function useLiteratureSaveState(summary: LiteratureToolSummary): LiteratureToolSummary {
  const identity = JSON.stringify(
    summary.action === 'save' ? (summary.pendingCandidateIds ?? []) : []
  )
  const generation = useRef(0)
  const [current, setCurrent] = useState<{
    identity: string
    candidates: Map<string, LiteratureInboxCandidateView>
  }>()
  const refresh = useCallback(async () => {
    const version = ++generation.current
    const ids: string[] = JSON.parse(identity)
    if (!ids.length || !window.api?.literature?.search) return
    const wanted = new Set(ids)
    const candidates = new Map<string, LiteratureInboxCandidateView>()
    try {
      // Use the existing paged catalog API; absence from pending alone does not prove import.
      for (const inboxState of ['pending', 'accepted', 'dismissed'] as const) {
        let offset = 0
        while (version === generation.current) {
          const page = await window.api.literature.search({
            scope: 'inbox',
            inboxState,
            offset,
            limit: 100
          })
          if (version !== generation.current) return
          for (const entry of page.entries) {
            if ('candidate' in entry && 'state' in entry && wanted.has(entry.id)) {
              candidates.set(entry.id, entry)
            }
          }
          if (candidates.size === wanted.size || page.nextOffset === undefined) break
          if (page.nextOffset <= offset) throw new Error('Inbox pagination did not advance.')
          offset = page.nextOffset
        }
        if (candidates.size === wanted.size) break
      }
      if (version === generation.current) setCurrent({ identity, candidates })
    } catch {
      // Failed reads cannot authorize an imported badge. Retain the last verified projection.
    }
  }, [identity])
  useLiteratureChanges((event) => {
    if (!isCollectionOnlyChange(event)) void refresh()
  })
  useEffect(() => {
    // refresh only commits after catalog I/O; it does not synchronously set effect state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])

  if (!current || current.identity !== identity) return summary
  const ids = summary.pendingCandidateIds ?? []
  const imported = ids.flatMap((id) => {
    const candidate = current.candidates.get(id)
    return candidate?.state === 'accepted' && candidate.acceptedItemId
      ? [candidate.acceptedItemId]
      : []
  })
  // Missing records stay unverified, rather than being guessed to be imported or dismissed.
  const pending = ids.filter((id) => {
    const candidate = current.candidates.get(id)
    return !candidate || candidate.state === 'pending'
  }).length
  return {
    ...summary,
    savedCount: pending,
    existingItemIds: [...new Set([...(summary.existingItemIds ?? []), ...imported])],
    otherCount: (summary.otherCount ?? 0) + ids.length - pending - imported.length
  }
}
