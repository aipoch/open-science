import { useEffect, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { isUnavailableFileError } from './preview-errors'

type UnavailableProbeResult = {
  requestKey: string
  unavailable: boolean
}

// Probes one managed path only while its card is near the viewport and caches the result per path.
const useUnavailablePreviewProbe = ({
  enabled,
  path,
  source
}: {
  enabled: boolean
  path: string
  source: PreviewFileSource
}): boolean => {
  const requestKey = JSON.stringify([source, path])
  const [result, setResult] = useState<UnavailableProbeResult | null>(null)
  const hasCurrentResult = result?.requestKey === requestKey

  useEffect(() => {
    if (!enabled || hasCurrentResult) return

    let canceled = false
    const readPreview =
      source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

    // One byte verifies path availability without retaining file content in the card.
    void readPreview({ path, maxBytes: 1, encoding: 'base64' }).then(
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
  }, [enabled, hasCurrentResult, path, requestKey, source])

  return hasCurrentResult ? result.unavailable : false
}

export { useUnavailablePreviewProbe }
