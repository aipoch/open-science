import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { readManagedFileBytes } from './managed-file-bytes'

// Reads a whole managed PDF (uploads or artifacts) as bytes for pdfjs. Both sources expose a
// full-bytes IPC so a large PDF is never truncated the way the bounded preview reader would.
export const readPdfBytes = async (path: string, source: PreviewFileSource): Promise<Uint8Array> =>
  readManagedFileBytes(path, source)
