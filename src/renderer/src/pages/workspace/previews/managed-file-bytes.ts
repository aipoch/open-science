import type { PreviewFileSource } from '@/stores/preview-workbench-store'

// Restores the byte representation used by parsers after IPC-safe Base64 transport.
const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

// Routes through the managed-file trust boundary and lets the main process reject oversized files
// before reading or Base64-encoding their complete contents.
export const readManagedFileBytes = async (
  path: string,
  source: PreviewFileSource,
  maxBytes?: number
): Promise<Uint8Array> => {
  const request = maxBytes === undefined ? { path } : { path, maxBytes }
  const { data } =
    source === 'upload'
      ? await window.api.uploads.readBytes(request)
      : await window.api.artifacts.readBytes(request)

  return base64ToUint8Array(data)
}
