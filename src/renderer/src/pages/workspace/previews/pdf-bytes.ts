import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { base64ToUint8Array } from './pdfjs'

// Reads a whole managed PDF (uploads or artifacts) as bytes for pdfjs. Both sources expose a
// full-bytes IPC so a large PDF is never truncated the way the bounded preview reader would.
export const readPdfBytes = async (
  path: string,
  source: PreviewFileSource
): Promise<Uint8Array> => {
  const { data } =
    source === 'upload'
      ? await window.api.uploads.readBytes({ path })
      : await window.api.artifacts.readBytes({ path })

  return base64ToUint8Array(data)
}
