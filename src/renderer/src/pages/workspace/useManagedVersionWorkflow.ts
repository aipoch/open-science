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
  projectId,
  mode,
  setMode,
  t
}: {
  item: PreviewFileItem
  projectId: string | undefined
  mode: ManagedVersionMode
  setMode: Dispatch<SetStateAction<ManagedVersionMode>>
  t: TFunction
}): ManagedVersionWorkflow => {
  const [storedInspect, setStoredInspect] = useState<
    { key: string; value: ManagedFileVersionInspectResult } | undefined
  >(undefined)
  const [refresh, setRefresh] = useState(0)
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
  const requestKey = identity
    ? `${source}:${projectId}:${identity.fileId}:${item.selectedVersionId ?? ''}:${refresh}`
    : undefined
  const inspect =
    storedInspect && storedInspect.key === requestKey ? storedInspect.value : undefined
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
  const controlsInspect = inspect ?? (mode === 'diff' ? navigationInspect : undefined)
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
        if (!active) return
        if (!result.ok) return leaveDiffMode()
        setStoredInspect({ key: requestKey, value: result.value })
        if (!result.value.canDiff && !isSourceTextVersion(result.value)) leaveDiffMode()
        else if (!result.value.canDiff) setDiff({})
      })
      .catch(() => {
        if (active) leaveDiffMode()
      })
    return () => {
      active = false
    }
  }, [identity, item.selectedVersionId, requestKey, resetDiff])

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
    resetForVersionSelection: (preserveDiffMode: boolean) =>
      resetDiff(preserveDiffMode && mode === 'diff' ? 'diff' : 'view'),
    history,
    refreshInspect: () => setRefresh((value) => value + 1)
  }
}

export { useManagedVersionWorkflow }
export type { ManagedVersionMode }
