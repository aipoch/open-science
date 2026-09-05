import { useVersionHistoryPages } from './use-version-history-pages'
import type { TFunction } from 'i18next'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

import { errorDetail } from '@/lib/error-detail'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type {
  ManagedFileIdentity,
  ManagedFileVersionDiffResult,
  ManagedFileVersionInspectResult
} from '../../../../shared/managed-file-versions'
import type { PreviewDownloadVersionContext } from './previews/preview-runtime-context'

type ManagedVersionMode = 'view' | 'edit' | 'diff'
type ManagedVersionWorkflow = {
  identity: ManagedFileIdentity | undefined
  inspect: ManagedFileVersionInspectResult | undefined
  inspectLoading: boolean
  inspectError: { code?: string; message?: string } | undefined
  navigationInspect: ManagedFileVersionInspectResult | undefined
  controlsInspect: ManagedFileVersionInspectResult | undefined
  diffResult: ManagedFileVersionDiffResult | undefined
  diffError: string | undefined
  showTextTools: boolean
  isSelectedSourceText: boolean
  downloadVersionContext: PreviewDownloadVersionContext | undefined
  startDiff: () => void
  stopDiff: () => void
  resetForVersionSelection: (preserveDiffMode: boolean) => void
  history: ReturnType<typeof useVersionHistoryPages>
  refreshInspect: () => void
}

const isSourceTextVersion = (inspect: ManagedFileVersionInspectResult): boolean => {
  const selected =
    inspect.selectedVersion ??
    inspect.versions.find((version) => version.id === inspect.selectedVersionId)
  return selected !== undefined && !selected.basedOnVersionId && inspect.text !== undefined
}

const useManagedVersionWorkflow = ({
  item,
  sourceItem = item,
  projectId,
  mode,
  setMode,
  t
}: {
  item: PreviewFileItem
  sourceItem?: PreviewFileItem
  projectId: string | undefined
  mode: ManagedVersionMode
  setMode: Dispatch<SetStateAction<ManagedVersionMode>>
  t: TFunction
}): ManagedVersionWorkflow => {
  const [storedInspect, setStoredInspect] = useState<
    { key: string; value: ManagedFileVersionInspectResult } | undefined
  >(undefined)
  const [inspectFailure, setInspectFailure] = useState<{
    key: string
    error: { code?: string; message?: string }
  }>()
  const [refresh, setRefresh] = useState(0)
  const refreshGeneration = useRef(0)
  const refreshInspect = useCallback(() => {
    // Notifications invalidate responses synchronously, before React commits the next effect.
    refreshGeneration.current += 1
    setRefresh(refreshGeneration.current)
  }, [])
  const [diff, setDiff] = useState<{
    result?: ManagedFileVersionDiffResult
    error?: string
  }>({})
  const activeDiffRequestId = useRef<string | undefined>(undefined)
  const source: 'upload' | 'artifact' = item.source === 'upload' ? 'upload' : 'artifact'
  const identity = useMemo(
    () =>
      projectId && item.managedFileId
        ? { source, projectId, fileId: item.managedFileId }
        : undefined,
    [item.managedFileId, projectId, source]
  )
  // Select primitive snapshots so unrelated messages/project edits do not invalidate inspection.
  const sessionRevision = useSessionStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === item.sessionId)
    return JSON.stringify([session?.id, session?.filesRevision, session?.archivedAt])
  })
  const projectLifecycle = useProjectStore((state) => {
    const project = state.projects.find((candidate) => candidate.id === projectId)
    return JSON.stringify([
      project?.id,
      project?.archivedAt,
      projectId ? state.projectDeletionRequests.has(projectId) : false
    ])
  })
  // A local historical selection must still observe its parent file metadata advancing.
  const requestKey = identity
    ? JSON.stringify([
        source,
        projectId,
        identity.fileId,
        item.selectedVersionId,
        item.sessionId,
        sourceItem.path,
        sourceItem.name,
        sourceItem.size,
        sourceItem.mtimeMs,
        sourceItem.versionNumber,
        sourceItem.originSession?.state,
        sourceItem.originSession?.deletedAt,
        sessionRevision,
        projectLifecycle,
        refresh
      ])
    : undefined
  const inspect =
    storedInspect && storedInspect.key === requestKey ? storedInspect.value : undefined
  const inspectError = inspectFailure?.key === requestKey ? inspectFailure?.error : undefined
  const inspectLoading = Boolean(
    requestKey &&
    typeof window.api.managedFileVersions?.inspect === 'function' &&
    !inspect &&
    !inspectError
  )
  // Preserve the last confirmed Version while the same logical file is being re-inspected. Default
  // previews keep following the DB head without pinning selectedVersionId on the workbench item.
  const previousInspect =
    identity &&
    storedInspect?.value.source === source &&
    storedInspect.value.projectId === projectId &&
    storedInspect.value.fileId === identity.fileId
      ? storedInspect.value
      : undefined
  const history = useVersionHistoryPages({
    historyKey:
      source + ':' + projectId + ':' + identity?.fileId + ':' + previousInspect?.headVersionId,
    initial: inspect ?? previousInspect,
    loadPage: async (cursor) => {
      const result = await window.api.managedFileVersions.inspect({
        ...identity!,
        versionId: item.selectedVersionId ?? previousInspect?.selectedVersionId,
        cursor
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
  })
  const pendingSelectedVersion = previousInspect
    ? [
        previousInspect.selectedVersion,
        previousInspect.headVersion,
        previousInspect.previousVersion,
        previousInspect.nextVersion,
        ...history.versions
      ].find((version) => version?.id === item.selectedVersionId)
    : undefined
  const initialNavigationInspect =
    inspect ??
    (previousInspect &&
    (!item.selectedVersionId || item.selectedVersionId === previousInspect.selectedVersionId)
      ? previousInspect
      : previousInspect && pendingSelectedVersion
        ? {
            ...previousInspect,
            selectedVersionId: pendingSelectedVersion.id,
            selectedVersion: pendingSelectedVersion,
            previousVersion: undefined,
            nextVersion: undefined
          }
        : undefined)
  const navigationInspect = initialNavigationInspect
    ? { ...initialNavigationInspect, versions: history.versions }
    : undefined
  // Keep Cancel/Stop comparing available during refresh, without granting stale write authority.
  const controlsInspect =
    inspect ??
    (mode !== 'view' && navigationInspect ? { ...navigationInspect, canEdit: false } : undefined)
  const selectedDownloadVersion =
    navigationInspect?.selectedVersion ??
    navigationInspect?.versions.find(
      (version) => version.id === navigationInspect.selectedVersionId
    )
  const latestDownloadVersion =
    navigationInspect?.headVersion ??
    navigationInspect?.versions.find((version) => version.id === navigationInspect.headVersionId)

  const resetDiff = useCallback(
    (nextMode: SetStateAction<ManagedVersionMode>): void => {
      if (activeDiffRequestId.current)
        void window.api.managedFileVersions.cancelDiff({ requestId: activeDiffRequestId.current })
      activeDiffRequestId.current = undefined
      setDiff({})
      setMode(nextMode)
    },
    [setMode]
  )

  useEffect(() => {
    if (!identity) return
    return window.api.projectFiles?.onChanged?.((event) => {
      if (event.projectId !== identity.projectId) return
      if (
        event.kind !== 'reset' &&
        (!event.sources.includes(identity.source) ||
          (event.sessionId !== undefined && event.sessionId !== item.sessionId))
      )
        return
      refreshInspect()
    })
  }, [identity, item.sessionId, refreshInspect])

  useEffect(() => {
    let active = true
    if (!identity || !requestKey || typeof window.api.managedFileVersions?.inspect !== 'function')
      return
    const leaveDiffMode = (): void =>
      resetDiff((current) => (current === 'diff' ? 'view' : current))
    void window.api.managedFileVersions
      .inspect({
        ...identity,
        ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {})
      })
      .then((result) => {
        if (!active || refresh !== refreshGeneration.current) return
        if (!result.ok) {
          setInspectFailure({ key: requestKey, error: result.error })
          return leaveDiffMode()
        }
        setInspectFailure(undefined)
        setStoredInspect({ key: requestKey, value: result.value })
        if (!result.value.canDiff && !isSourceTextVersion(result.value)) leaveDiffMode()
        else if (!result.value.canDiff) setDiff({})
      })
      .catch((error: unknown) => {
        if (!active || refresh !== refreshGeneration.current) return
        setInspectFailure({
          key: requestKey,
          error: {
            message: errorDetail(error),
            ...(typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
              ? { code: error.code }
              : {})
          }
        })
        leaveDiffMode()
      })
    return () => {
      active = false
    }
  }, [identity, item.selectedVersionId, requestKey, refresh, resetDiff])

  useEffect(() => {
    if (mode !== 'diff' || !identity || !inspect?.canDiff) return
    const requestId = crypto.randomUUID()
    activeDiffRequestId.current = requestId
    void window.api.managedFileVersions
      .diffText({ ...identity, versionId: inspect.selectedVersionId, requestId })
      .then((result) => {
        if (activeDiffRequestId.current !== requestId) return
        activeDiffRequestId.current = undefined
        if (result.ok) setDiff({ result: result.value })
        else if (result.error.code !== 'DIFF_CANCELLED')
          setDiff({ error: t('Diff could not be loaded.') })
      })
      .catch(() => {
        if (activeDiffRequestId.current === requestId)
          setDiff({ error: t('Diff could not be loaded.') })
      })
    return () => {
      if (activeDiffRequestId.current !== requestId) return
      activeDiffRequestId.current = undefined
      void window.api.managedFileVersions.cancelDiff({ requestId })
    }
  }, [identity, inspect?.canDiff, inspect?.selectedVersionId, mode, t])

  return {
    identity,
    inspect,
    inspectLoading,
    inspectError,
    navigationInspect,
    controlsInspect,
    diffResult: diff.result,
    diffError: diff.error,
    showTextTools: controlsInspect?.text !== undefined,
    isSelectedSourceText: inspect !== undefined && isSourceTextVersion(inspect),
    downloadVersionContext:
      selectedDownloadVersion && latestDownloadVersion
        ? {
            versionId: selectedDownloadVersion.id,
            versionNumber: selectedDownloadVersion.versionNumber,
            latestVersionId: latestDownloadVersion.id,
            latestVersionNumber: latestDownloadVersion.versionNumber
          }
        : undefined,
    startDiff: () => resetDiff('diff'),
    stopDiff: () => resetDiff('view'),
    resetForVersionSelection: (preserveDiffMode: boolean) => {
      setInspectFailure(undefined)
      resetDiff(preserveDiffMode && mode === 'diff' ? 'diff' : 'view')
    },
    history,
    refreshInspect
  }
}

export { useManagedVersionWorkflow }
export type { ManagedVersionMode }
