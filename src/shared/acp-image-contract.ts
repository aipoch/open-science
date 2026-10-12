export const ACP_MESSAGE_IMAGE_MIME_TYPES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
] as const

export type AcpMessageImageMimeType = (typeof ACP_MESSAGE_IMAGE_MIME_TYPES)[number]

export type AcpMessageImage = {
  mimeType: AcpMessageImageMimeType
  data: string
  byteLength: number
}

// Replay-only identity. These optional locators are derived from persisted Session messages and
// never become part of provider image content or the durable Session JSON shape.
export type AcpReplayMessageImage = AcpMessageImage & {
  sourceMessageId?: string
  sourceImageId?: string
}

// Message images are embedded in runtime IPC and session JSON, so keep each block small enough to
// render without turning an agent event into an unbounded binary transport. SVG is deliberately not
// accepted because active image content does not belong in the transcript renderer.
export const MAX_ACP_MESSAGE_IMAGE_BYTES = 4 * 1024 * 1024

export const MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE = 4

export const MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE = 8 * 1024 * 1024

export const MAX_ACP_SESSION_IMAGE_BYTES = 24 * 1024 * 1024

// Existing runtime projection keeps only text-bearing message events. This sentinel carries a valid
// image through that projection and is removed before transcript storage or rendering.
export const ACP_MESSAGE_IMAGE_EVENT_TEXT = '[open-science:acp-message-image]'

export const ACP_MESSAGE_IMAGE_MIME_TYPE_SET = new Set<string>(ACP_MESSAGE_IMAGE_MIME_TYPES)

export const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

// Computes decoded bytes without allocating a second binary copy. Both padded and unpadded base64
// are accepted, while whitespace and malformed padding are rejected.
export const getBase64ByteLength = (data: string): number | undefined => {
  if (!data || !BASE64_BODY_PATTERN.test(data)) return undefined

  const firstPaddingIndex = data.indexOf('=')
  const paddingLength = firstPaddingIndex === -1 ? 0 : data.length - firstPaddingIndex

  if (paddingLength > 0 && data.length % 4 !== 0) return undefined
  if (paddingLength === 0 && data.length % 4 === 1) return undefined

  return Math.floor((data.length * 3) / 4) - paddingLength
}

// Validates an untrusted ACP image at both runtime and persistence boundaries.
export const sanitizeAcpMessageImage = (value: unknown): AcpMessageImage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const image = value as Record<string, unknown>
  const mimeType = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : undefined
  const data = typeof image.data === 'string' ? image.data : undefined

  if (!mimeType || !ACP_MESSAGE_IMAGE_MIME_TYPE_SET.has(mimeType) || !data) return undefined

  const byteLength = getBase64ByteLength(data)

  if (byteLength === undefined || byteLength > MAX_ACP_MESSAGE_IMAGE_BYTES) return undefined

  return {
    mimeType: mimeType as AcpMessageImageMimeType,
    data,
    byteLength
  }
}
