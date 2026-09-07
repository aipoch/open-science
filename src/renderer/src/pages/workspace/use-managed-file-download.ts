import { useEffect, useMemo, useRef, useState } from 'react'

import {
  WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME,
  type SaveManagedFileRequest
} from '../../../../shared/file-save'

type DownloadStatus = 'idle' | 'saving' | 'saved' | 'error'
type DownloadIdentity = Readonly<{ key: string }>
type DownloadState = Readonly<{
  identity: DownloadIdentity
  status: DownloadStatus
  sizeLimitError: boolean
}>

export type ManagedFileDownloadInput = Readonly<{
  source: SaveManagedFileRequest['source']
  path: string
  projectId?: string
  fileId?: string
  versionId?: string
  versionNumber?: number
  latestVersionId?: string
  latestVersionNumber?: number
  suggestedName: string
}>

export type ManagedFileDownloadController = Readonly<{
  status: DownloadStatus
  sizeLimitError: boolean
  execute: (requestedVersionId?: string | null) => Promise<void>
}>

export const useManagedFileDownload = ({
  source,
  path,
  projectId,
  fileId,
  versionId,
  versionNumber,
  latestVersionId,
  latestVersionNumber,
  suggestedName
}: ManagedFileDownloadInput): ManagedFileDownloadController => {
  // The object token changes even when navigation later returns to the same request key, so an
  // older completion can never revive Saved/Error state for a newly selected preview identity.
  const identity = useMemo<DownloadIdentity>(
    () => ({
      key: JSON.stringify([
        source,
        path,
        projectId,
        fileId,
        versionId,
        versionNumber,
        latestVersionId,
        latestVersionNumber,
        suggestedName
      ])
    }),
    [
      fileId,
      latestVersionId,
      latestVersionNumber,
      path,
      projectId,
      source,
      suggestedName,
      versionId,
      versionNumber
    ]
  )
  const [state, setState] = useState<DownloadState>({
    identity,
    status: 'idle',
    sizeLimitError: false
  })
  // Both header and content actions receive this controller. Returning the active promise keeps
  // every caller on the same streaming save and prevents a second IPC invocation.
  const activeSaveRef = useRef<
    | {
        identity: DownloadIdentity
        attempt: symbol
        promise: Promise<void>
      }
    | undefined
  >(undefined)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const execute = (requestedVersionId?: string | null): Promise<void> => {
    const activeSave = activeSaveRef.current
    if (activeSave?.identity === identity) return activeSave.promise

    let request: SaveManagedFileRequest
    if (source === 'artifact' || source === 'upload') {
      if (!projectId || !fileId) {
        const error = new Error('Managed file download requires a logical identity.')
        console.error(`Failed to download managed file: ${suggestedName}`, error)
        setState({ identity, status: 'error', sizeLimitError: false })
        return Promise.resolve()
      }
      const resolvedVersionId = requestedVersionId === undefined ? versionId : requestedVersionId
      request = {
        source,
        projectId,
        fileId,
        ...(resolvedVersionId ? { versionId: resolvedVersionId } : {}),
        suggestedName
      }
    } else {
      request = { source, path, suggestedName }
    }

    const attempt = Symbol('managed-file-save')
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    const updateState = (status: DownloadStatus, sizeLimitError = false): void =>
      setState({ identity, status, sizeLimitError })
    updateState('saving')
    const promise = window.api
      .saveManagedFile(request)
      .then((result) => {
        if (!mountedRef.current || activeSaveRef.current?.attempt !== attempt) return
        if (!result.saved) {
          updateState('idle')
          return
        }

        updateState('saved')
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = undefined
          if (mountedRef.current) updateState('idle')
        }, 1600)
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeSaveRef.current?.attempt !== attempt) return
        console.error(`Failed to download managed file: ${suggestedName}`, error)
        updateState(
          'error',
          error instanceof Error && error.name === WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME
        )
      })
      .finally(() => {
        if (activeSaveRef.current?.attempt === attempt) activeSaveRef.current = undefined
      })
    activeSaveRef.current = { identity, attempt, promise }
    return promise
  }

  return {
    status: state.identity === identity ? state.status : 'idle',
    sizeLimitError: state.identity === identity && state.sizeLimitError,
    execute
  }
}
