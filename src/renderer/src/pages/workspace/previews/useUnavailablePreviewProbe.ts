import { useEffect, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createPreviewRequestScope, getPreviewFileReader } from './preview-file-reader'
import { isUnavailableFileError } from './preview-errors'

type UnavailableProbeResult = {
  requestKey: string
  unavailable: boolean
}

// Probes one managed path only while its card is near the viewport and caches the result per path.
const useUnavailablePreviewProbe = ({
  enabled,
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  path,
  source
}: {
  enabled: boolean
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  path: string
  source: PreviewFileSource
}): boolean => {
  const requestKey = JSON.stringify([
    projectId ?? null,
    sessionId ?? null,
    source,
    managedFileId ?? null,
    selectedVersionId ?? null,
    path
  ])
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
          setResult({ requestKey, unavailable: isUnavailableFileError(error) })
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

export { useUnavailablePreviewProbe }
