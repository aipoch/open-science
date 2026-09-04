import { useCallback, useEffect, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from '../preview-resource-key'
import { tiffThumbnailScheduler } from '../tiff-thumbnail-scheduler'
import {
  TIFF_THUMBNAIL_LIMITS,
  TIFF_THUMBNAIL_MAX_DIMENSION,
  type DecodedTiffPage
} from '../tiff-preview-types'
import { createTiffDecodeSession } from '../tiff-preview-worker-client'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
import { TiffCanvas } from './TiffCanvas'

type TiffThumbnailResult = { status: 'ready'; page: DecodedTiffPage } | { status: 'error' }

type TiffThumbnailProps = {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  enabled: boolean
  fallback: React.ReactNode
}

type EnabledTiffThumbnailProps = Omit<TiffThumbnailProps, 'enabled'> & {
  requestKey: string
}

const EnabledTiffThumbnail = ({
  requestKey,
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs,
  fallback
}: EnabledTiffThumbnailProps): React.JSX.Element => {
  const [result, setResult] = useState<TiffThumbnailResult | null>(null)
  const resourceState = useManagedPreviewResource(
    {
      projectId,
      sessionId,
      managedFileId,
      selectedVersionId,
      source,
      path,
      mimeType,
      size,
      mtimeMs,
      maxBytes: TIFF_THUMBNAIL_LIMITS.maxFileBytes
    },
    result === null
  )

  useEffect(() => {
    if (resourceState.status !== 'ready' || result !== null) return

    const resource = resourceState.resource
    const controller = new AbortController()
    let disposed = false

    void tiffThumbnailScheduler
      .schedule(controller.signal, async () => {
        if (resource.size > TIFF_THUMBNAIL_LIMITS.maxFileBytes) {
          throw new Error('TIFF file is too large to preview safely')
        }

        const response = await fetch(resource.url, {
          cache: 'no-store',
          signal: controller.signal
        })
        if (!response.ok) {
          throw new Error(`TIFF thumbnail read failed with status ${response.status}`)
        }

        const data = await response.arrayBuffer()
        if (data.byteLength !== resource.size) {
          throw new Error('TIFF file changed during the thumbnail read')
        }
        if (controller.signal.aborted) throw controller.signal.reason

        const session = createTiffDecodeSession(data, {
          limits: TIFF_THUMBNAIL_LIMITS,
          maxOutputDimension: TIFF_THUMBNAIL_MAX_DIMENSION
        })
        try {
          return await session.decodePage(0, controller.signal)
        } finally {
          session.dispose()
        }
      })
      .then((page) => {
        if (!disposed) setResult({ status: 'ready', page })
      })
      .catch(() => {
        if (!disposed && !controller.signal.aborted) setResult({ status: 'error' })
      })

    return () => {
      disposed = true
      controller.abort()
    }
  }, [requestKey, resourceState, result])

  const handleDrawError = useCallback(() => setResult({ status: 'error' }), [])

  if (result?.status !== 'ready') return <>{fallback}</>

  return (
    <TiffCanvas
      page={result.page}
      name={`Preview of ${name}`}
      fit="cover"
      onError={handleDrawError}
    />
  )
}

const TiffThumbnail = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs,
  enabled,
  fallback
}: TiffThumbnailProps): React.JSX.Element => {
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    mimeType,
    size,
    mtimeMs,
    managedFileId,
    selectedVersionId
  })

  if (!enabled) return <>{fallback}</>

  return (
    <EnabledTiffThumbnail
      key={requestKey}
      requestKey={requestKey}
      path={path}
      name={name}
      source={source}
      projectId={projectId}
      sessionId={sessionId}
      managedFileId={managedFileId}
      selectedVersionId={selectedVersionId}
      mimeType={mimeType}
      size={size}
      mtimeMs={mtimeMs}
      fallback={fallback}
    />
  )
}

export { TiffThumbnail }
