import { useEffect, useState } from 'react'

import type { ManagedFileIdentity } from '../../../../../shared/managed-file-versions'
import type { PptxEditSessionView } from '../../../../../shared/pptx-edit-session'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'

type PptxDraftPreview = {
  view: PptxEditSessionView | undefined
  failed: boolean
}

// Replays the draft's operations in a throwaway edit session so the review uses the same staged
// preview as manual editing. The session is never saved; accepting stores the draft's own bytes.
const usePptxDraftPreview = (
  identity: ManagedFileIdentity | undefined,
  draft: PptxDraftSummary | null,
  active: boolean
): PptxDraftPreview => {
  const [result, setResult] = useState<{ draftId: string; view?: PptxEditSessionView }>()
  const source = identity?.source
  const projectId = identity?.projectId
  const fileId = identity?.fileId
  const draftId = active ? draft?.draftId : undefined
  const current = draftId !== undefined && result?.draftId === draftId ? result : undefined
  const view = current?.view
  const failed = current !== undefined && current.view === undefined

  useEffect(() => {
    if (!active || !draft || !source || !projectId || !fileId) return
    let live = true
    let sessionId: string | undefined
    const run = async (): Promise<void> => {
      const target = { source, projectId, fileId, versionId: draft.basedOnVersionId }
      const opened = await window.api.pptxEdit.open(target)
      if (!opened.ok) throw new Error(opened.error.code)
      sessionId = opened.value.sessionId
      // Cleanup may have run while open() was pending; close the session it could not see.
      if (!live) {
        void window.api.pptxEdit.close(sessionId).catch(() => undefined)
        return
      }
      const applied = await window.api.pptxEdit.apply({
        sessionId,
        operations: draft.operations
      })
      if (!applied.ok) throw new Error(applied.error.code)
      if (live) setResult({ draftId: draft.draftId, view: applied.value })
    }
    void run().catch(() => {
      if (live) setResult({ draftId: draft.draftId })
    })
    return () => {
      live = false
      if (sessionId) void window.api.pptxEdit.close(sessionId).catch(() => undefined)
    }
  }, [active, draft, source, projectId, fileId])

  return { view, failed }
}

export { usePptxDraftPreview }
export type { PptxDraftPreview }
