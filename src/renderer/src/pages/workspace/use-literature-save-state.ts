import type { LiteratureInboxCandidateView } from '@aipoch/literature-library/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isCollectionOnlyChange, useLiteratureChanges } from '../literature/useLiteratureChanges'
import type { LiteratureToolSummary } from './literature-tool-presentation'

type LiteratureApi = Window['api']['literature']
type ReadRound = {
  pages: Map<string, ReturnType<LiteratureApi['search']>>
  items: Map<string, ReturnType<LiteratureApi['get']>>
}
const readRounds = new WeakMap<LiteratureApi, Promise<ReadRound>>()

// Batch before starting I/O: native event listeners can have microtask checkpoints
// between them. Close admission before resolving so later events cannot reuse old reads.
function sharedReadRound(api: LiteratureApi): Promise<ReadRound> {
  const existing = readRounds.get(api)
  if (existing) return existing
  const round = new Promise<ReadRound>((resolve) => {
    setTimeout(() => {
      readRounds.delete(api)
      resolve({ pages: new Map(), items: new Map() })
    }, 0)
  })
  readRounds.set(api, round)
  return round
}

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
    const api = window.api.literature
    const round = await sharedReadRound(api)
    if (version !== generation.current) return
    const wanted = new Set(ids)
    const candidates = new Map<string, LiteratureInboxCandidateView>()
    try {
      // ponytail: one shared scan still scales with Inbox history; use ID-filtered catalog
      // reads if that becomes the bottleneck. Absence from pending alone does not prove import.
      for (const inboxState of ['pending', 'accepted', 'dismissed'] as const) {
        let offset = 0
        while (version === generation.current) {
          const key = `${inboxState}:${offset}`
          let read = round.pages.get(key)
          if (!read) {
            read = api.search({ scope: 'inbox', inboxState, offset, limit: 100 })
            round.pages.set(key, read)
          }
          const page = await read
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
      for (const [id, candidate] of candidates) {
        if (candidate.state !== 'accepted' || !candidate.acceptedItemId) continue
        let read = round.items.get(candidate.acceptedItemId)
        if (!read) {
          read = api.get(candidate.acceptedItemId)
          round.items.set(candidate.acceptedItemId, read)
        }
        const item = await read
        if (version !== generation.current) return
        // Accepted receipts survive soft deletion; only offer an available Library item.
        if (item) candidates.set(id, { ...candidate, acceptedItemId: item.id })
        else candidates.delete(id)
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
  // Missing records are neutral: permanent deletion also removes accepted candidates.
  const pending = ids.filter((id) => {
    const candidate = current.candidates.get(id)
    return candidate?.state === 'pending'
  }).length
  return {
    ...summary,
    savedCount: pending,
    existingItemIds: [...new Set([...(summary.existingItemIds ?? []), ...imported])],
    otherCount: (summary.otherCount ?? 0) + ids.length - pending - imported.length
  }
}
