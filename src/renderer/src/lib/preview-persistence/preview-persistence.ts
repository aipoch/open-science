import { useEffect, useRef } from 'react'

import {
  PREVIEW_STATE_VERSION,
  MAX_PERSISTED_PREVIEW_ITEMS,
  createEmptyPersistedPreviewState,
  normalizePersistedPreviewState,
  type PersistedPreviewState,
  type PreviewStateSnapshot,
  type SavePreviewStateResult,
  type SavePreviewStateRequest
} from '../../../../shared/preview-state'
import { getUploadedAttachmentPath } from '../../../../shared/uploads'
import {
  usePreviewWorkbenchStore,
  type PreviewFileFormat,
  type PreviewFileSource,
  type RestoredPreviewSlice
} from '../../stores/preview-workbench-store'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { getPreviewFormatForFile } from '../../pages/workspace/preview-support'

type PreviewStoreState = ReturnType<typeof usePreviewWorkbenchStore.getState>
type PreviewSave = (request: SavePreviewStateRequest) => Promise<SavePreviewStateResult>
type PreviewSaveInput = Omit<SavePreviewStateRequest, 'expectedRevision'>
type FinalizedUploadPreview = {
  managedFileId: string
  sessionId: string
  path: string
  size: number
  mimeType?: string
}
type ProjectUploadPreviewIndex = {
  sessions: Map<string, { session: ChatSession; uploadIds: Set<string> }>
  uploads: Map<string, FinalizedUploadPreview>
}
type PreviewSaveScheduler = {
  schedule: (request: PreviewSaveInput) => void
  getGeneration: (projectId: string) => number
  acceptLoadedSnapshot: (
    projectId: string,
    generation: number,
    snapshot: PreviewStateSnapshot | null
  ) => boolean
  hasFailure: (projectId: string) => boolean
  waitForIdle: (projectId: string) => Promise<void>
  flush: () => Promise<void>
}

const reportPersistenceError = (error: unknown): void => {
  console.warn('Preview persistence failed', error)
}

const previewValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => previewValuesEqual(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) && previewValuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

// Session store updates replace changed Sessions. Keep a derived Project lookup so restores query
// only the persisted Upload ids and rescan Messages only when a Session object changes. Bound the
// recent-Project cache so removed or long-inactive Projects cannot retain Session message graphs for
// the renderer lifetime.
const MAX_UPLOAD_PREVIEW_INDEX_PROJECTS = 8
const uploadPreviewIndexes = new Map<string, ProjectUploadPreviewIndex>()

const getUploadPreviewIndex = (projectId: string): ProjectUploadPreviewIndex => {
  const cached = uploadPreviewIndexes.get(projectId)
  const index = cached ?? { sessions: new Map(), uploads: new Map() }

  // Map insertion order supplies a small LRU without another cache abstraction.
  if (cached) uploadPreviewIndexes.delete(projectId)
  uploadPreviewIndexes.set(projectId, index)
  while (uploadPreviewIndexes.size > MAX_UPLOAD_PREVIEW_INDEX_PROJECTS) {
    const oldestProjectId = uploadPreviewIndexes.keys().next().value
    if (oldestProjectId === undefined) break
    uploadPreviewIndexes.delete(oldestProjectId)
  }

  return index
}

const synchronizeUploadPreviewIndex = (
  sessions: ChatSession[]
): ReadonlyMap<string, FinalizedUploadPreview> => {
  const projectId = sessions[0]?.projectId
  if (!projectId) return new Map()

  const index = getUploadPreviewIndex(projectId)
  const currentSessionIds = new Set<string>()

  for (const session of sessions) {
    if (session.projectId !== projectId) continue
    currentSessionIds.add(session.id)
    const cached = index.sessions.get(session.id)
    if (cached?.session === session) continue

    for (const uploadId of cached?.uploadIds ?? []) index.uploads.delete(uploadId)

    const uploadIds = new Set<string>()
    for (const message of session.messages) {
      for (const upload of message.uploads ?? []) {
        const previewId = `upload:${upload.id}`
        uploadIds.add(previewId)
        index.uploads.set(previewId, {
          ...upload,
          managedFileId: upload.id,
          path: getUploadedAttachmentPath(upload, session.projectId)
        })
      }
    }
    index.sessions.set(session.id, { session, uploadIds })
  }

  for (const [sessionId, cached] of index.sessions) {
    if (currentSessionIds.has(sessionId)) continue
    for (const uploadId of cached.uploadIds) index.uploads.delete(uploadId)
    index.sessions.delete(sessionId)
  }

  return index.uploads
}

const indexAuthoritativeArtifactIds = (sessions: ChatSession[]): ReadonlyMap<string, string> => {
  const artifactIdByRecordId = new Map<string, string>()

  for (const session of sessions) {
    for (const artifact of session.artifacts ?? []) {
      if (artifact.kind === 'managed-file' && artifact.artifactId) {
        artifactIdByRecordId.set(artifact.id, artifact.artifactId)
      }
    }
  }

  return artifactIdByRecordId
}

// Applies only the changes made after `base` to the authoritative state. This preserves remote tabs
// while retaining user actions that happened after the conflicting save had already started.
const rebasePreviewState = (
  base: PersistedPreviewState,
  local: PersistedPreviewState,
  authoritative: PersistedPreviewState
): PersistedPreviewState => {
  const baseItems = new Map(base.items.map((item) => [item.id, item]))
  const localItems = new Map(local.items.map((item) => [item.id, item]))
  const mergedItems = authoritative.items
    .filter((item) => !(baseItems.has(item.id) && !localItems.has(item.id)))
    .map((item) => {
      const localItem = localItems.get(item.id)
      const baseItem = baseItems.get(item.id)
      return localItem && (!baseItem || !previewValuesEqual(localItem, baseItem)) ? localItem : item
    })
  const mergedIds = new Set(mergedItems.map((item) => item.id))

  for (const localItem of local.items) {
    const baseItem = baseItems.get(localItem.id)
    if (!mergedIds.has(localItem.id) && (!baseItem || !previewValuesEqual(localItem, baseItem))) {
      mergedItems.push(localItem)
    }
  }

  return normalizePersistedPreviewState({
    ...authoritative,
    panelState: local.panelState !== base.panelState ? local.panelState : authoritative.panelState,
    activeItemId:
      local.activeItemId !== base.activeItemId ? local.activeItemId : authoritative.activeItemId,
    items: mergedItems,
    subagents: !previewValuesEqual(local.subagents, base.subagents)
      ? local.subagents
      : authoritative.subagents
  })
}

// Serializes saves per Project while coalescing queued snapshots to the newest state. Different
// Projects drain independently, and a failed write does not prevent a newer snapshot from being saved.
const createPreviewSaveScheduler = (
  save: PreviewSave,
  reportError: (error: unknown) => void,
  restoreConflict: (projectId: string, snapshot: PreviewStateSnapshot | null) => void
): PreviewSaveScheduler => {
  const queues = new Map<
    string,
    {
      pendingState: PersistedPreviewState | undefined
      pendingBaseState: PersistedPreviewState | undefined
      inFlightState: PersistedPreviewState | undefined
      drain: Promise<void> | undefined
    }
  >()
  const failures = new Map<
    string,
    {
      state: PersistedPreviewState
      error: unknown
    }
  >()
  const revisions = new Map<string, number>()
  const generations = new Map<string, number>()
  const acceptedStates = new Map<string, PersistedPreviewState>()

  const bumpGeneration = (projectId: string): void => {
    generations.set(projectId, (generations.get(projectId) ?? 0) + 1)
  }

  const schedule = ({ projectId, state }: PreviewSaveInput): void => {
    const queue = queues.get(projectId) ?? {
      pendingState: undefined,
      pendingBaseState: undefined,
      inFlightState: undefined,
      drain: undefined
    }
    if (queue.pendingState && previewValuesEqual(queue.pendingState, state)) return
    if (
      !queue.pendingState &&
      queue.inFlightState &&
      previewValuesEqual(queue.inFlightState, state)
    ) {
      return
    }
    if (!queue.drain && previewValuesEqual(acceptedStates.get(projectId), state)) return

    queue.pendingState = state
    queue.pendingBaseState = undefined
    queues.set(projectId, queue)
    bumpGeneration(projectId)

    if (queue.drain) return

    const drain = (async () => {
      try {
        while (queue.pendingState) {
          const nextState = queue.pendingState
          const nextBaseState = queue.pendingBaseState
          queue.pendingState = undefined
          queue.pendingBaseState = undefined
          queue.inFlightState = nextState

          try {
            const result = await save({
              projectId,
              state: nextState,
              expectedRevision: revisions.get(projectId) ?? 0
            })
            if (result.status === 'conflict') {
              const authoritativeState =
                result.snapshot?.state ?? createEmptyPersistedPreviewState()
              const localState = queue.pendingState ?? (nextBaseState ? nextState : undefined)
              const localBaseState = queue.pendingState ? nextState : nextBaseState
              const revision = result.snapshot?.revision ?? 0
              revisions.set(projectId, revision)
              acceptedStates.set(projectId, authoritativeState)
              bumpGeneration(projectId)
              failures.delete(projectId)

              if (localState && localBaseState) {
                const rebasedState = rebasePreviewState(
                  localBaseState,
                  localState,
                  authoritativeState
                )
                restoreConflict(projectId, { state: rebasedState, revision })
                if (!previewValuesEqual(rebasedState, authoritativeState)) {
                  queue.pendingState = rebasedState
                  queue.pendingBaseState = authoritativeState
                  continue
                }
              } else {
                restoreConflict(projectId, result.snapshot)
              }

              queue.pendingState = undefined
              queue.pendingBaseState = undefined
              break
            }
            revisions.set(projectId, Math.max(revisions.get(projectId) ?? 0, result.revision))
            acceptedStates.set(projectId, nextState)
            bumpGeneration(projectId)
            failures.delete(projectId)
          } catch (error) {
            failures.set(projectId, { state: nextState, error })
            bumpGeneration(projectId)
            reportError(error)
          } finally {
            queue.inFlightState = undefined
          }
        }
      } finally {
        if (queues.get(projectId) === queue) queues.delete(projectId)
      }
    })()
    queue.drain = drain
    void drain.catch(() => undefined)
  }

  const flush = async (): Promise<void> => {
    for (const [projectId, failure] of failures) {
      if (!queues.has(projectId)) schedule({ projectId, state: failure.state })
    }

    while (queues.size > 0) {
      await Promise.all(
        [...queues.values()]
          .map((queue) => queue.drain)
          .filter((drain): drain is Promise<void> => !!drain)
      )
    }

    if (failures.size > 0) {
      throw failures.values().next().value?.error ?? new Error('Preview persistence flush failed')
    }
  }

  const getGeneration = (projectId: string): number => generations.get(projectId) ?? 0

  const hasFailure = (projectId: string): boolean => failures.has(projectId)

  const waitForIdle = async (projectId: string): Promise<void> => {
    let drain = queues.get(projectId)?.drain
    while (drain) {
      await drain
      drain = queues.get(projectId)?.drain
    }
  }

  const acceptLoadedSnapshot = (
    projectId: string,
    generation: number,
    snapshot: PreviewStateSnapshot | null
  ): boolean => {
    if (
      generation !== getGeneration(projectId) ||
      queues.has(projectId) ||
      failures.has(projectId)
    ) {
      return false
    }

    revisions.set(projectId, Math.max(revisions.get(projectId) ?? 0, snapshot?.revision ?? 0))
    acceptedStates.set(projectId, snapshot?.state ?? createEmptyPersistedPreviewState())
    return true
  }

  return { schedule, getGeneration, acceptLoadedSnapshot, hasFailure, waitForIdle, flush }
}

// Projects the live store slice down to its durable subset: file previews plus the one Session-scoped
// Subagents selection. Other tool tabs and external source URLs remain runtime-only.
const toPersistedPreviewState = (state: PreviewStoreState): PersistedPreviewState => {
  const fileItems = state.items.filter((item) => item.type === 'file')
  const retainedIds = new Set(
    [...fileItems]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PERSISTED_PREVIEW_ITEMS)
      .map((item) => item.id)
  )
  const retainedFileItems = fileItems.filter((item) => retainedIds.has(item.id))
  const subagentsItem = state.items.find(
    (candidate) => candidate.type === 'tool' && candidate.toolKind === 'subagents'
  )
  const subagents =
    subagentsItem?.type === 'tool' && subagentsItem.selectedAgentFrameId
      ? {
          id: subagentsItem.id,
          sessionId: subagentsItem.sessionId,
          title: subagentsItem.title,
          type: 'tool' as const,
          toolKind: 'subagents' as const,
          selectedAgentFrameId: subagentsItem.selectedAgentFrameId
        }
      : undefined
  const activeItemId =
    retainedIds.has(state.activeItemId ?? '') || subagents?.id === state.activeItemId
      ? state.activeItemId
      : undefined

  return {
    version: PREVIEW_STATE_VERSION,
    panelState: state.panelState,
    activeItemId,
    ...(subagents ? { subagents } : {}),
    items: retainedFileItems.map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      title: item.title,
      source: item.source,
      path: item.path,
      format: item.format,
      name: item.name,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.mtimeMs !== undefined ? { mtimeMs: item.mtimeMs } : {}),
      ...(item.artifactId ? { artifactId: item.artifactId } : {}),
      ...(item.managedFileId ? { managedFileId: item.managedFileId } : {}),
      ...(item.selectedVersionId ? { selectedVersionId: item.selectedVersionId } : {}),
      ...(item.versionNumber !== undefined ? { versionNumber: item.versionNumber } : {}),
      ...(item.originSession ? { originSession: item.originSession } : {})
    }))
  }
}

// Rebuilds the store's restore payload and repairs upload paths that changed after staging.
const toRestoredSlice = (
  persisted: PersistedPreviewState,
  sessions: ChatSession[] = []
): RestoredPreviewSlice => {
  // Hydrated sessions hold finalized upload paths while persisted tabs may still reference staging.
  const uploadByPreviewId = synchronizeUploadPreviewIndex(sessions)
  const artifactIdByRecordId = indexAuthoritativeArtifactIds(sessions)

  return {
    panelState: persisted.panelState,
    activeItemId: persisted.activeItemId,
    items: [
      ...persisted.items.map((item) => {
        const upload = item.source === 'upload' ? uploadByPreviewId.get(item.id) : undefined
        // Restore managed identity only from authoritative data for the persisted source.
        const hasArtifactSource = item.source === undefined || item.source === 'artifact'
        const artifactId = hasArtifactSource
          ? (item.artifactId ?? artifactIdByRecordId.get(item.id))
          : undefined
        const hydratedManagedFileId =
          item.source === 'upload'
            ? upload?.managedFileId
            : hasArtifactSource
              ? artifactId
              : undefined
        const managedFileId = item.managedFileId ?? hydratedManagedFileId
        const mimeType = upload?.mimeType ?? item.mimeType
        const currentFormat = getPreviewFormatForFile({ name: item.name, mimeType })

        return {
          id: item.id,
          sessionId: upload?.sessionId ?? item.sessionId,
          title: item.title,
          type: 'file' as const,
          source: item.source as PreviewFileSource | undefined,
          path: upload?.path ?? item.path,
          // Re-evaluate the format from current name/MIME metadata, falling back to the stored result.
          format: currentFormat === 'unknown' ? (item.format as PreviewFileFormat) : currentFormat,
          name: item.name,
          ...(mimeType ? { mimeType } : {}),
          ...(upload?.size !== undefined || item.size !== undefined
            ? { size: upload?.size ?? item.size }
            : {}),
          ...(item.mtimeMs !== undefined ? { mtimeMs: item.mtimeMs } : {}),
          ...(artifactId ? { artifactId } : {}),
          ...(managedFileId ? { managedFileId } : {}),
          ...(item.selectedVersionId ? { selectedVersionId: item.selectedVersionId } : {}),
          ...(item.versionNumber !== undefined ? { versionNumber: item.versionNumber } : {}),
          ...(item.originSession ? { originSession: item.originSession } : {})
        }
      }),
      ...(persisted.subagents
        ? [
            {
              ...persisted.subagents,
              type: 'tool' as const,
              toolKind: 'subagents' as const
            }
          ]
        : [])
    ]
  }
}

const suppressedConflictRestoreSaves = new Set<string>()

const restorePreviewConflict = (projectId: string, snapshot: PreviewStateSnapshot | null): void => {
  const store = usePreviewWorkbenchStore.getState()
  // The next activation will merge a fresh durable snapshot into the cached runtime-owned tabs.
  if (store.activeProjectId !== projectId) return

  const projectSessions = useSessionStore
    .getState()
    .sessions.filter((session) => session.projectId === projectId)
  suppressedConflictRestoreSaves.add(projectId)
  try {
    store.activateProject(
      projectId,
      snapshot ? toRestoredSlice(snapshot.state, projectSessions) : { items: [] }
    )
  } finally {
    suppressedConflictRestoreSaves.delete(projectId)
  }
}

// WorkspacePage can unmount while an IPC save is still in flight. Keep one renderer-lifetime scheduler
// so a later Workspace mount cannot start a competing queue for the same Project.
const previewSaveScheduler = createPreviewSaveScheduler(
  (request) => window.api.preview.save(request),
  reportPersistenceError,
  restorePreviewConflict
)
const schedulePreviewSave = previewSaveScheduler.schedule
const flushPreviewPersistence = previewSaveScheduler.flush

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
      schedulePreviewSave({ projectId: previousProjectId, state: toPersistedPreviewState(store) })
    }

    previousProjectIdRef.current = activeProjectId

    if (!activeProjectId) return

    let cancelled = false
    const loadLatest = async (): Promise<void> => {
      const loadGeneration = previewSaveScheduler.getGeneration(activeProjectId)
      const snapshot = await window.api.preview.load({ projectId: activeProjectId })
      if (cancelled) return

      if (!previewSaveScheduler.acceptLoadedSnapshot(activeProjectId, loadGeneration, snapshot)) {
        const currentStore = usePreviewWorkbenchStore.getState()
        if (currentStore.activeProjectId === activeProjectId) return
        if (previewSaveScheduler.hasFailure(activeProjectId)) {
          currentStore.activateProject(activeProjectId)
          return
        }

        await previewSaveScheduler.waitForIdle(activeProjectId)
        if (!cancelled) await loadLatest()
        return
      }

      const projectSessions = useSessionStore
        .getState()
        .sessions.filter((session) => session.projectId === activeProjectId)

      usePreviewWorkbenchStore
        .getState()
        .activateProject(
          activeProjectId,
          snapshot ? toRestoredSlice(snapshot.state, projectSessions) : undefined
        )
    }

    void loadLatest().catch(reportPersistenceError)

    return () => {
      cancelled = true
    }
  }, [activeProjectId, isSessionPersistenceReady])

  // Write through workbench changes so a process-level restart cannot lose the selected Subagent
  // Frame (or another durable preview change) before React gets an unmount opportunity.
  useEffect(() => {
    const unsubscribe = usePreviewWorkbenchStore.subscribe((state) => {
      if (!state.activeProjectId) return
      if (suppressedConflictRestoreSaves.has(state.activeProjectId)) return
      schedulePreviewSave({
        projectId: state.activeProjectId,
        state: toPersistedPreviewState(state)
      })
    })

    return () => {
      unsubscribe()
      const state = usePreviewWorkbenchStore.getState()
      if (state.activeProjectId) {
        schedulePreviewSave({
          projectId: state.activeProjectId,
          state: toPersistedPreviewState(state)
        })
      }
      state.closeFileDialog()
    }
  }, [])
}

export { flushPreviewPersistence, toPersistedPreviewState, toRestoredSlice }
