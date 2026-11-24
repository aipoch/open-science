import type { AcquireManagedPreviewRequest } from '../../../../../shared/preview-resources'

const PREVIEW_RANGE_IPC_CHUNK_SIZE = 1024 * 1024

const decodeRangeBytes = (value: unknown, expectedLength: number): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value
  if (typeof value !== 'object' || value === null) return undefined

  const serialized = value as Record<number, unknown>
  const bytes = new Uint8Array(expectedLength)
  for (let index = 0; index < expectedLength; index += 1) {
    const byte = serialized[index]
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) return undefined
    bytes[index] = byte as number
  }
  return Object.keys(serialized).length === expectedLength ? bytes : undefined
}

export const readManagedPreviewBytes = async (
  request: AcquireManagedPreviewRequest,
  isCancelled?: () => boolean
): Promise<Uint8Array> => {
  const resource = await window.api.previewResources.acquire(request)
  try {
    const data = new Uint8Array(resource.size)
    for (
      let chunkBegin = 0;
      chunkBegin < resource.size;
      chunkBegin += PREVIEW_RANGE_IPC_CHUNK_SIZE
    ) {
      if (isCancelled?.()) {
        throw new Error('Managed preview read cancelled.')
      }
      const chunkEnd = Math.min(resource.size, chunkBegin + PREVIEW_RANGE_IPC_CHUNK_SIZE)
      const range = await window.api.previewResources.readRange({
        resourceId: resource.id,
        begin: chunkBegin,
        end: chunkEnd
      })
      const rangeData = decodeRangeBytes(range.data, chunkEnd - chunkBegin)
      if (range.begin !== chunkBegin || range.end !== chunkEnd || !rangeData) {
        throw new Error('Managed preview range response did not match the requested chunk.')
      }
      data.set(rangeData, chunkBegin)
    }
    return data
  } finally {
    await window.api.previewResources.release({ resourceId: resource.id }).catch(() => undefined)
  }
}
