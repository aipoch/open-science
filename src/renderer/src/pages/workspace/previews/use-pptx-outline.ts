import { useEffect, useState } from 'react'

import type { ManagedFileIdentity } from '../../../../../shared/managed-file-versions'
import type { DeckOutline } from '../../../../../shared/pptx-edit'
import type { PptxEditSessionView } from '../../../../../shared/pptx-edit-session'

type PptxVersionView = { view: PptxEditSessionView | undefined; failed: boolean }

// Opens one fixed version through a short-lived edit session that is never applied. The session
// stays open while mounted so its revision 0 can back a staged preview.
const usePptxVersionView = (
  identity: ManagedFileIdentity | undefined,
  versionId: string | undefined,
  enabled: boolean
): PptxVersionView => {
  const [loaded, setLoaded] = useState<{ key: string; view?: PptxEditSessionView }>()
  const key =
    enabled && identity && versionId
      ? `${identity.source}:${identity.projectId}:${identity.fileId}:${versionId}`
      : undefined

  useEffect(() => {
    if (!key || !identity || !versionId || !window.api.pptxEdit) return
    let cancelled = false
    let sessionId: string | undefined
    void window.api.pptxEdit
      .open({ ...identity, versionId })
      .then((result) => {
        if (cancelled) {
          if (result.ok) void window.api.pptxEdit.close(result.value.sessionId).catch(() => {})
          return
        }
        if (result.ok) sessionId = result.value.sessionId
        setLoaded({ key, view: result.ok ? result.value : undefined })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key })
      })
    return () => {
      cancelled = true
      if (sessionId) void window.api.pptxEdit.close(sessionId).catch(() => undefined)
    }
  }, [identity, key, versionId])

  const current = loaded && loaded.key === key ? loaded : undefined
  return { view: current?.view, failed: current !== undefined && current.view === undefined }
}

const usePptxOutline = (
  identity: ManagedFileIdentity | undefined,
  versionId: string | undefined,
  enabled: boolean
): DeckOutline | undefined => usePptxVersionView(identity, versionId, enabled).view?.outline

export { usePptxOutline, usePptxVersionView }
export type { PptxVersionView }
