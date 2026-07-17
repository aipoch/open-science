import type { PreviewFileSource } from '@/stores/preview-workbench-store'

const MANAGED_FILE_READ_CHUNK_BYTES = 1024 * 1024

// Acquires an owner-scoped capability, rejects oversized files from authoritative stat metadata,
// and assembles bounded IPC ranges without restoring a general whole-file Base64 endpoint.
export const readManagedFileBytes = async (
  path: string,
  source: PreviewFileSource,
  maxBytes: number
): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Invalid managed file byte limit.')
  }

  const resource = await window.api.previewResources.acquire({ source, path })

  try {
    if (!Number.isSafeInteger(resource.size) || resource.size < 0) {
      throw new Error('Managed preview returned an invalid file size.')
    }
    if (resource.size > maxBytes) {
      throw new Error('Managed file is too large to read into memory.')
    }

    const bytes = new Uint8Array(resource.size)
    for (let begin = 0; begin < resource.size; begin += MANAGED_FILE_READ_CHUNK_BYTES) {
      const end = Math.min(resource.size, begin + MANAGED_FILE_READ_CHUNK_BYTES)
      const range = await window.api.previewResources.readRange({
        resourceId: resource.id,
        begin,
        end
      })

      if (
        range.begin !== begin ||
        range.end !== end ||
        range.total !== resource.size ||
        range.data.byteLength !== end - begin
      ) {
        throw new Error('Managed preview range did not match the requested file chunk.')
      }
      bytes.set(range.data, begin)
    }

    return bytes
  } finally {
    await window.api.previewResources.release({ resourceId: resource.id })
  }
}
