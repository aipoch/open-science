import { useEffect, useState } from 'react'

import type { ManagedPreviewResource } from '../../../../../shared/preview-resources'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from './preview-resource-key'

type ManagedPreviewResourceState =
  | { status: 'idle'; resource?: undefined; error?: undefined }
  | { status: 'loading'; resource?: undefined; error?: undefined }
  | { status: 'ready'; resource: ManagedPreviewResource; error?: undefined }
  | { status: 'error'; resource?: undefined; error: Error }

const idleState: ManagedPreviewResourceState = { status: 'idle' }

type ManagedPreviewResourceResult =
  | { requestKey: string; status: 'ready'; resource: ManagedPreviewResource }
  | { requestKey: string; status: 'error'; error: Error }

// Acquires and releases one managed-file capability with the component lifecycle.
const useManagedPreviewResource = (
  item: Pick<PreviewFileItem, 'path' | 'source' | 'mimeType' | 'size' | 'mtimeMs'>,
  enabled = true
): ManagedPreviewResourceState => {
  const [result, setResult] = useState<ManagedPreviewResourceResult | null>(null)
  // File metadata invalidates a capability when the same path is replaced in place.
  const requestKey = createPreviewResourceKey(item)

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let acquiredResource: ManagedPreviewResource | undefined

    void window.api.previewResources
      .acquire({
        source: item.source ?? 'artifact',
        path: item.path,
        ...(item.mimeType ? { mimeType: item.mimeType } : {})
      })
      .then((resource) => {
        // Release acquisitions that complete after the consumer was unmounted or disabled.
        if (disposed) {
          void window.api.previewResources.release({ resourceId: resource.id })
          return
        }

        acquiredResource = resource
        setResult({ requestKey, status: 'ready', resource })
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setResult({
            requestKey,
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error))
          })
        }
      })

    return () => {
      disposed = true
      // Releasing the capability lets the main process forget the path and future protocol access.
      if (acquiredResource) {
        void window.api.previewResources.release({ resourceId: acquiredResource.id })
      }
      queueMicrotask(() => {
        setResult((currentResult) =>
          currentResult?.requestKey === requestKey ? null : currentResult
        )
      })
    }
  }, [enabled, item.mimeType, item.mtimeMs, item.path, item.size, item.source, requestKey])

  if (!enabled) return idleState
  if (result?.requestKey !== requestKey) return { status: 'loading' }
  return result
}

export { useManagedPreviewResource }
export type { ManagedPreviewResourceState }
