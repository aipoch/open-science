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
  const offset = request.offset ?? 0
  const encoding = request.encoding ?? 'utf8'

  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error(invalidEncodingMessage)
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > fileStat.size) {
    throw new Error('Invalid managed file preview offset.')
  }

  const maxBytes = Math.max(1, Math.min(requestedBytes, MAX_PREVIEW_BYTES))
  const includePageMetadata = request.offset !== undefined
  // UTF-8 pages may read up to three extra bytes so the final character is never split.
  const readBudget = encoding === 'utf8' ? maxBytes + 3 : maxBytes
  const bytesToRead = Math.min(fileStat.size - offset, readBudget)
  const buffer = Buffer.alloc(bytesToRead)
  // Use an explicit file handle so the bounded read never streams the whole file by accident.
  const fileHandle = await open(filePath, 'r')

  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset)
    let contentBytesRead = Math.min(bytesRead, maxBytes)
    if (encoding === 'utf8') {
      while (contentBytesRead < bytesRead && (buffer[contentBytesRead] & 0xc0) === 0x80) {
        contentBytesRead += 1
      }
    }
    const endOffset = offset + contentBytesRead

    return {
      content: buffer.subarray(0, contentBytesRead).toString(encoding),
      encoding,
      size: fileStat.size,
      truncated: fileStat.size > endOffset,
      ...(includePageMetadata ? { offset } : {}),
      ...(includePageMetadata && fileStat.size > endOffset ? { nextOffset: endOffset } : {})
    }
  } finally {
    await fileHandle.close()
  }
}

export { readBoundedManagedFilePreview }
