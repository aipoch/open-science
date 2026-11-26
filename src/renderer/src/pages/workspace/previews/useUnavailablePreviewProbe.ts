import { CLEANED_VERSION_MESSAGE } from '../../../../../shared/managed-file-versions'
import { useEffect, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-contract'

import { createPreviewRequestScope, getPreviewFileReader } from './preview-file-reader'
import { isUnavailableFileError } from './preview-errors'

type UnavailableProbeResult = {
  requestKey: string
  unavailable: boolean | 'cleaned'
}

// Probes one managed file only while its card is near the viewport and caches by file revision.
const usePreviewAvailability = ({
  enabled,
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  path,
  source,
  size,
  mtimeMs
}: {
  enabled: boolean
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  path: string
  source: PreviewFileSource
  size?: number
  mtimeMs?: number
}): boolean | 'cleaned' => {
  const [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([
    revision,
    projectId ?? null,
    sessionId ?? null,
    source,
    managedFileId ?? null,
    selectedVersionId ?? null,
    path,
    size ?? null,
    mtimeMs ?? null
  ])
  useEffect(() => {
    if (!selectedVersionId) return
    return window.api.projectFiles?.onChanged?.((event) => {
      if (
        event.projectId === projectId &&
        event.sources.includes(source === 'upload' ? 'upload' : 'artifact') &&
        event.versionIds?.includes(selectedVersionId)
      )
        setRevision((value) => value + 1)
    })
  }, [projectId, selectedVersionId, source])
  const [result, setResult] = useState<UnavailableProbeResult | null>(null)
  const hasCurrentResult = result?.requestKey === requestKey

  useEffect(() => {
    if (!enabled || hasCurrentResult) return

    let canceled = false
    const readPreview = getPreviewFileReader(source)

    // One byte verifies path availability without retaining file content in the card.
    void readPreview({
      ...createPreviewRequestScope({ projectId, sessionId, source, path }),
      path,
      ...(managedFileId ? { fileId: managedFileId } : {}),
      ...(selectedVersionId ? { versionId: selectedVersionId } : {}),
      maxBytes: 1,
      encoding: 'base64'
    }).then(
      () => {
        if (!canceled) setResult({ requestKey, unavailable: false })
      },
      (error: unknown) => {
        if (!canceled) {
          setResult({
            requestKey,
            unavailable: String(error).includes(CLEANED_VERSION_MESSAGE)
              ? 'cleaned'
              : isUnavailableFileError(error)
          })
        }
      }
    )

    return () => {
      canceled = true
    }
  }, [
    enabled,
    hasCurrentResult,
    managedFileId,
    path,
    projectId,
    requestKey,
    selectedVersionId,
    sessionId,
    source
  ])

  return hasCurrentResult ? result.unavailable : false
}

const useUnavailablePreviewProbe = (input: Parameters<typeof usePreviewAvailability>[0]): boolean =>
  Boolean(usePreviewAvailability(input))
export { usePreviewAvailability, useUnavailablePreviewProbe }
