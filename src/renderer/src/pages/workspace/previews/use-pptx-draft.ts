import { useCallback, useEffect, useState } from 'react'

import type {
  ManagedFileIdentity,
  SaveTextEditResult
} from '../../../../../shared/managed-file-versions'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'

type PptxDraftProblem = 'stale' | 'conflict' | 'failed'

type PptxDraftSaved = Extract<SaveTextEditResult, { kind: 'created' | 'noop' }>

type PptxDraftState = {
  draft: PptxDraftSummary | null
  busy: boolean
  problem: PptxDraftProblem | undefined
  accept: () => Promise<PptxDraftSaved | undefined>
  reject: () => Promise<void>
}

// State is tagged with the file it belongs to, so switching files never shows the previous
// file's draft without resetting state from inside an effect.
type Scoped<T> = { key: string; value: T }

const sameFile = (a: ManagedFileIdentity, b: ManagedFileIdentity): boolean =>
  a.source === b.source && a.projectId === b.projectId && a.fileId === b.fileId

const usePptxDraft = (identity: ManagedFileIdentity | undefined): PptxDraftState => {
  const [loaded, setLoaded] = useState<Scoped<PptxDraftSummary | null>>()
  const [reported, setReported] = useState<Scoped<PptxDraftProblem>>()
  const [busy, setBusy] = useState(false)
  const source = identity?.source
  const projectId = identity?.projectId
  const fileId = identity?.fileId
  const key = source && projectId && fileId ? `${source}\0${projectId}\0${fileId}` : undefined
  const draft = key !== undefined && loaded?.key === key ? loaded.value : null
  const problem = key !== undefined && reported?.key === key ? reported.value : undefined

  useEffect(() => {
    const api = window.api.pptxDraft
    if (!key || !source || !projectId || !fileId || !api) return
    const target: ManagedFileIdentity = { source, projectId, fileId }
    let live = true
    void api.get(target).then(
      (next) => live && setLoaded({ key, value: next }),
      () => undefined
    )
    const remove = api.onChanged((event) => {
      if (!live || !sameFile(event.identity, target)) return
      setLoaded({ key, value: event.draft })
      if (event.draft) setReported(undefined)
    })
    return () => {
      live = false
      remove()
    }
  }, [key, source, projectId, fileId])

  const accept = useCallback(async (): Promise<PptxDraftSaved | undefined> => {
    const api = window.api.pptxDraft
    if (!identity || !key || !draft || !api) return undefined
    setBusy(true)
    setReported(undefined)
    try {
      const outcome = await api.accept({ identity, draftId: draft.draftId })
      if (outcome.kind === 'stale') setReported({ key, value: 'stale' })
      else if (outcome.kind === 'saved') {
        if (outcome.result.kind === 'conflict') setReported({ key, value: 'conflict' })
        else return outcome.result
      }
      return undefined
    } catch {
      setReported({ key, value: 'failed' })
      return undefined
    } finally {
      setBusy(false)
    }
  }, [draft, identity, key])

  const reject = useCallback(async (): Promise<void> => {
    const api = window.api.pptxDraft
    if (!identity || !key || !api) return
    setReported(undefined)
    if (!draft) return
    setBusy(true)
    try {
      await api.reject({ identity, draftId: draft.draftId })
    } catch {
      setReported({ key, value: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [draft, identity, key])

  return { draft, busy, problem, accept, reject }
}

export { usePptxDraft }
export type { PptxDraftProblem, PptxDraftState }
