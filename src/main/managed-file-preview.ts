import { open, stat } from 'node:fs/promises'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../shared/artifacts'

const DEFAULT_PREVIEW_BYTES = 8192
// Raised beyond the thumbnail-sized default so the preview panel can render full-size images
// without truncation; callers that only need a thumbnail keep passing a smaller explicit maxBytes.
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024

// Reads a caller-bounded preview from an already-validated managed file path.
const readBoundedManagedFilePreview = async (
  filePath: string,
  request: ReadArtifactPreviewRequest,
  invalidEncodingMessage: string
): Promise<ArtifactPreviewResult> => {
  const fileStat = await stat(filePath)
  // Normalize the optional byte limit before applying the repository-wide hard cap.
  const requestedBytes =
    typeof request.maxBytes === 'number' && Number.isFinite(request.maxBytes)
      ? Math.floor(request.maxBytes)
      : DEFAULT_PREVIEW_BYTES
  const encoding = request.encoding ?? 'utf8'

  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error(invalidEncodingMessage)
  }

  const maxBytes = Math.max(1, Math.min(requestedBytes, MAX_PREVIEW_BYTES))
  const bytesToRead = Math.min(fileStat.size, maxBytes)
  const buffer = Buffer.alloc(bytesToRead)
  // Use an explicit file handle so the bounded read never streams the whole file by accident.
  const fileHandle = await open(filePath, 'r')

  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0)

    return {
      content: buffer.subarray(0, bytesRead).toString(encoding),
      encoding,
      size: fileStat.size,
      truncated: fileStat.size > bytesRead
    }
  } finally {
    await fileHandle.close()
  }
}

export { readBoundedManagedFilePreview }
