import { extname } from 'node:path'

const ZIP_CONTAINER_CONTENT_TYPES = new Set([
  'application/epub+zip',
  'application/java-archive',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
])

const NON_ZIP_SIGNATURE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
])

const SIGNATURE_VERIFIED_CONTENT_TYPES = new Set([
  'application/zip',
  ...NON_ZIP_SIGNATURE_CONTENT_TYPES,
  ...ZIP_CONTAINER_CONTENT_TYPES
])

const isZipContainerContentType = (contentType: string): boolean =>
  ZIP_CONTAINER_CONTENT_TYPES.has(contentType) ||
  contentType.endsWith('+zip') ||
  /^application\/vnd\.openxmlformats-officedocument\./.test(contentType) ||
  /^application\/vnd\.oasis\.opendocument\./.test(contentType) ||
  /^application\/vnd\.ms-(?:word|excel|powerpoint)\..*(?:macroenabled|template)/.test(contentType)

const normalizeContentType = (value: string): string => {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (normalized === 'image/jpg') return 'image/jpeg'
  if (normalized === 'application/x-zip-compressed') return 'application/zip'
  return normalized
}

const contentTypeFromExtension = (filename: string): string | undefined => {
  switch (extname(filename).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.zip':
      return 'application/zip'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.odt':
      return 'application/vnd.oasis.opendocument.text'
    case '.ods':
      return 'application/vnd.oasis.opendocument.spreadsheet'
    case '.odp':
      return 'application/vnd.oasis.opendocument.presentation'
    case '.epub':
      return 'application/epub+zip'
    case '.jar':
      return 'application/java-archive'
    default:
      return undefined
  }
}

const startsWith = (sample: Buffer, bytes: readonly number[]): boolean =>
  bytes.every((byte, index) => sample[index] === byte)

const contentTypeFromSignature = (sample: Buffer): string | undefined => {
  if (startsWith(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(sample, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  const ascii = sample.toString('ascii')
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif'
  if (ascii.includes('%PDF-')) return 'application/pdf'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  if (
    startsWith(sample, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(sample, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(sample, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip'
  }
  return undefined
}

const isDetectedTypeCompatible = (detected: string, asserted: string): boolean => {
  if (detected === asserted) return true
  if (detected !== 'application/zip') return false

  // PK proves only that the bytes are a ZIP container. Accept explicitly identified container
  // formats without pretending to distinguish their final subtype, but do not let arbitrary text,
  // JSON, or another unrelated MIME assertion hide behind a generic archive signature.
  return isZipContainerContentType(asserted)
}

export const validateArtifactContentType = (request: {
  filename: string
  declaredContentType?: string
  sample: Buffer
}): void => {
  const declared = request.declaredContentType
    ? normalizeContentType(request.declaredContentType)
    : undefined
  const detected = contentTypeFromSignature(request.sample)
  const expectedFromName = contentTypeFromExtension(request.filename)

  if (
    declared &&
    declared !== 'application/octet-stream' &&
    detected &&
    !isDetectedTypeCompatible(detected, declared)
  ) {
    throw new Error(
      `Artifact declared MIME type ${declared} conflicts with detected source type ${detected}.`
    )
  }
  if (detected && expectedFromName && !isDetectedTypeCompatible(detected, expectedFromName)) {
    throw new Error(
      `Artifact source type ${detected} conflicts with filename ${request.filename} (${expectedFromName}).`
    )
  }
  if (
    declared &&
    declared !== 'application/octet-stream' &&
    expectedFromName &&
    declared !== expectedFromName
  ) {
    throw new Error(
      `Artifact declared MIME type ${declared} conflicts with filename ${request.filename} (${expectedFromName}).`
    )
  }

  const assertedTypes = [
    declared === 'application/octet-stream' ? undefined : declared,
    expectedFromName
  ].filter((value): value is string => value !== undefined)
  if (
    !detected &&
    assertedTypes.some(
      (value) => SIGNATURE_VERIFIED_CONTENT_TYPES.has(value) || isZipContainerContentType(value)
    )
  ) {
    throw new Error(
      `Artifact bytes do not contain the required signature for ${assertedTypes.join(' or ')}.`
    )
  }
}
