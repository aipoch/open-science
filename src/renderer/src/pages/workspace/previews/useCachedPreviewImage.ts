import { useEffect, useState } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createManagedPreviewRequest } from './preview-file-reader'
import { isManagedFilePublicationPendingError } from './preview-errors'
import { createPreviewResourceKey } from './preview-resource-key'

const MAX_CACHED_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_CACHED_IMAGE_COUNT = 32
const PUBLICATION_RETRY_DELAY_MS = 200
const PUBLICATION_RETRY_LIMIT = 4

type CachedImage = { url: string; size: number; managedResourceId?: string }
type CachedImageEntry = {
  key: string
  promise: Promise<CachedImage>
  refs: number
  retained: boolean
  disposed: boolean
  value?: CachedImage
}

type CachedPreviewImageState =
  | { status: 'idle'; url?: undefined; error?: undefined }
  | { status: 'loading'; url?: undefined; error?: undefined }
  | { status: 'ready'; url: string; error?: undefined }
  | { status: 'error'; url?: undefined; error: Error }

type PreviewImageItem = Pick<PreviewFileItem, 'path' | 'source' | 'mimeType' | 'size' | 'mtimeMs'> &
  Partial<Pick<PreviewFileItem, 'projectId' | 'sessionId' | 'managedFileId' | 'selectedVersionId'>>

const entries = new Map<string, CachedImageEntry>()
let cachedImageBytes = 0

const dispose = (entry: CachedImageEntry): void => {
  if (entry.disposed || entry.refs > 0 || entry.retained) return
  entry.disposed = true
  void entry.promise
    .then(({ url, managedResourceId }) =>
      managedResourceId
        ? window.api.previewResources.release({ resourceId: managedResourceId })
        : URL.revokeObjectURL(url)
    )
    .catch(() => undefined)
}

const evict = (entry: CachedImageEntry): void => {
  if (entries.get(entry.key) === entry) entries.delete(entry.key)
  if (entry.retained && entry.value) cachedImageBytes -= entry.value.size
  entry.retained = false
  dispose(entry)
}

const prune = (): void => {
  while (entries.size > MAX_CACHED_IMAGE_COUNT || cachedImageBytes > MAX_CACHED_IMAGE_BYTES) {
    const candidate = Array.from(entries.values()).find((entry) => entry.refs === 0)
    if (!candidate) return
    evict(candidate)
  }
}

const acquirePreviewResource = async (
  item: PreviewImageItem,
  retriesRemaining = PUBLICATION_RETRY_LIMIT
): ReturnType<Window['api']['previewResources']['acquire']> => {
  try {
    return await window.api.previewResources.acquire(createManagedPreviewRequest(item))
  } catch (error) {
    if (retriesRemaining === 0 || !isManagedFilePublicationPendingError(error)) throw error
    await new Promise<void>((resolve) => setTimeout(resolve, PUBLICATION_RETRY_DELAY_MS))
    return acquirePreviewResource(item, retriesRemaining - 1)
  }
}

const loadImage = async (item: PreviewImageItem): Promise<CachedImage> => {
  const resource = await acquirePreviewResource(item)

  const imageSize = Math.max(item.size ?? 0, resource.size)
  if (imageSize > MAX_CACHED_IMAGE_BYTES) {
    return { url: resource.url, size: imageSize, managedResourceId: resource.id }
  }

  try {
    // The managed protocol intentionally disables HTTP caching. Copy the decoded source bytes into
    // a renderer-owned Blob URL so Session switches can reuse them without retaining a path-bearing
    // main-process capability.
    const response = await fetch(resource.url, { cache: 'no-store' })
    if (!response.ok)
      throw new Error(`Image preview request failed with status ${response.status}.`)
    const blob = await response.blob()
    return { url: URL.createObjectURL(blob), size: blob.size }
  } finally {
    void window.api.previewResources.release({ resourceId: resource.id })
  }
}

const acquire = (item: PreviewImageItem, key: string): CachedImageEntry => {
  const existing = entries.get(key)
  if (existing) {
    existing.refs += 1
    entries.delete(key)
    entries.set(key, existing)
    return existing
  }

  const pending = loadImage(item)
  const entry: CachedImageEntry = {
    key,
    promise: pending,
    refs: 1,
    retained: true,
    disposed: false
  }
  entry.promise = pending.then(
    (value) => {
      entry.value = value
      if (value.managedResourceId) {
        entry.retained = false
        if (entry.refs === 0) evict(entry)
      } else if (entry.retained) {
        cachedImageBytes += value.size
        prune()
      } else {
        dispose(entry)
      }
      return value
    },
    (error: unknown) => {
      evict(entry)
      throw error
    }
  )
  entries.set(key, entry)
  prune()
  return entry
}

const release = (entry: CachedImageEntry): void => {
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs === 0 && !entry.retained) evict(entry)
  else dispose(entry)
  prune()
}

const invalidate = (key: string): void => {
  const entry = entries.get(key)
  if (entry) evict(entry)
}

const useCachedPreviewImage = (
  item: PreviewImageItem,
  enabled = true,
  invalidateWhenDisabled = false
): CachedPreviewImageState => {
  const requestKey = createPreviewResourceKey(item)
  const [result, setResult] = useState<
    | { requestKey: string; status: 'ready'; url: string }
    | { requestKey: string; status: 'error'; error: Error }
    | null
  >(null)

  useEffect(() => {
    if (!enabled) {
      if (invalidateWhenDisabled) invalidate(requestKey)
      return
    }

    let disposed = false
    const entry = acquire(
      {
        path: item.path,
        source: item.source,
        mimeType: item.mimeType,
        size: item.size,
        mtimeMs: item.mtimeMs,
        projectId: item.projectId,
        sessionId: item.sessionId,
        managedFileId: item.managedFileId,
        selectedVersionId: item.selectedVersionId
      },
      requestKey
    )
    void entry.promise.then(
      ({ url }) => {
        if (!disposed) setResult({ requestKey, status: 'ready', url })
      },
      (error: unknown) => {
        if (!disposed) {
          setResult({
            requestKey,
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error))
          })
        }
      }
    )

    return () => {
      disposed = true
      release(entry)
      queueMicrotask(() => {
        setResult((current) => (current?.requestKey === requestKey ? null : current))
      })
    }
  }, [
    enabled,
    invalidateWhenDisabled,
    item.mimeType,
    item.managedFileId,
    item.mtimeMs,
    item.path,
    item.projectId,
    item.sessionId,
    item.selectedVersionId,
    item.size,
    item.source,
    requestKey
  ])

  if (!enabled) return { status: 'idle' }
  if (result?.requestKey !== requestKey) return { status: 'loading' }
  return result
}

export { useCachedPreviewImage }
export type { CachedPreviewImageState }
