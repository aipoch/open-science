import { useEffect, useRef } from 'react'

import { PREVIEW_STATE_VERSION, type PersistedPreviewState } from '../../../../shared/preview-state'
import {
  usePreviewWorkbenchStore,
  type PreviewFileFormat,
  type PreviewFileSource,
  type RestoredPreviewSlice
} from '../../stores/preview-workbench-store'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { getPreviewFormatForFile } from '../../pages/workspace/preview-support'

type PreviewStoreState = ReturnType<typeof usePreviewWorkbenchStore.getState>

const reportPersistenceError = (error: unknown): void => {
  console.warn('Preview persistence failed', error)
}

// Projects the live store slice down to its durable subset: panel state + opened file previews.
// Runtime-only tool tabs (notebook, the Files tab) are dropped; they re-appear on demand.
const toPersistedPreviewState = (state: PreviewStoreState): PersistedPreviewState => ({
  version: PREVIEW_STATE_VERSION,
  panelState: state.panelState,
  activeItemId: state.activeItemId,
  items: state.items
    .filter((item) => item.type === 'file')
    .map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      title: item.title,
      source: item.source,
      path: item.path,
      format: item.format,
      name: item.name
    }))
})

// Rebuilds the store's restore payload and repairs upload paths that changed after staging.
const toRestoredSlice = (
  persisted: PersistedPreviewState,
  sessions: ChatSession[] = []
): RestoredPreviewSlice => {
  // Hydrated sessions hold finalized upload paths while persisted tabs may still reference staging.
  const uploadByPreviewId = new Map<string, { sessionId: string; path: string }>()

  for (const session of sessions) {
    for (const message of session.messages) {
      for (const upload of message.uploads ?? []) {
        uploadByPreviewId.set(`upload:${upload.id}`, upload)
      }
    }
  }

  return {
    panelState: persisted.panelState,
    activeItemId: persisted.activeItemId,
    items: persisted.items.map((item) => {
      const upload = item.source === 'upload' ? uploadByPreviewId.get(item.id) : undefined
      const currentFormat = getPreviewFormatForFile({ name: item.name })

      return {
        id: item.id,
        sessionId: upload?.sessionId ?? item.sessionId,
        title: item.title,
        type: 'file' as const,
        source: item.source as PreviewFileSource | undefined,
        path: upload?.path ?? item.path,
        // MIME is not persisted, so keep its stored result only when the name cannot infer a format.
        format: currentFormat === 'unknown' ? (item.format as PreviewFileFormat) : currentFormat,
        name: item.name
      }
    })
  }
}

// Persists and restores the preview panel per project: saves the outgoing project before switching,
// loads the incoming project's saved slice, and flushes the current project on unmount (e.g. Home).
export const usePreviewPersistence = (
  activeProjectId: string | undefined,
  isSessionPersistenceReady: boolean
): void => {
  const previousProjectIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    // Upload preview paths can only be reconciled after persisted sessions have hydrated.
    if (!isSessionPersistenceReady) return

    const previousProjectId = previousProjectIdRef.current
    const store = usePreviewWorkbenchStore.getState()

    // Persist the outgoing project, but only when the store's live top-level slice actually belongs to it
    // (store.activeProjectId === previousProjectId). If a prior switch's async load never applied — it
    // rejected, or was superseded by a rapid re-switch before activateProject ran — the top-level slice
    // still belongs to a different project, and saving it under previousProjectId would overwrite that
    // project's persisted tabs with another's. Skipping is safe: nothing new was shown for
    // previousProjectId in that case, so its last saved state stands.
    if (
      previousProjectId &&
      previousProjectId !== activeProjectId &&
      store.activeProjectId === previousProjectId
    ) {
      void window.api.preview
        .save({ projectId: previousProjectId, state: toPersistedPreviewState(store) })
        .catch(reportPersistenceError)
    }

    previousProjectIdRef.current = activeProjectId

    if (!activeProjectId) return

    let cancelled = false

    void window.api.preview
      .load({ projectId: activeProjectId })
      .then((restored) => {
        if (cancelled) return

        const projectSessions = useSessionStore
          .getState()
          .sessions.filter((session) => session.projectId === activeProjectId)

        usePreviewWorkbenchStore
          .getState()
          .activateProject(
            activeProjectId,
            restored ? toRestoredSlice(restored, projectSessions) : undefined
          )
      })
      .catch(reportPersistenceError)

    return () => {
      cancelled = true
    }
  }, [activeProjectId, isSessionPersistenceReady])

  // Flush the active project when the workspace unmounts (navigating Home does not change the id).
  useEffect(
    () => () => {
      const state = usePreviewWorkbenchStore.getState()

      if (state.activeProjectId) {
        void window.api.preview
          .save({ projectId: state.activeProjectId, state: toPersistedPreviewState(state) })
          .catch(reportPersistenceError)
      }
    },
    []
  )
}

export { toPersistedPreviewState, toRestoredSlice }
