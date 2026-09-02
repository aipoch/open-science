export const MAX_DECODED_IMAGE_PIXELS = 16_000_000

export type RasterImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export type RasterImageDimensions = { width: number; height: number }

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

// EXIF orientations 5-8 transpose width/height. Browsers apply orientation by default
// (image-orientation: from-image), so a phone-shot JPEG's displayed size is the SOF size swapped.
const EXIF_TRANSPOSE_ORIENTATIONS = new Set([5, 6, 7, 8])

// Parses the orientation tag (0x0112) out of an APP1 'Exif\0\0' payload. Any structural
// oddity degrades to undefined — orientation is a refinement, never worth failing over.
const readExifOrientation = (segment: Buffer): number | undefined => {
  if (segment.length < 14 || segment.toString('latin1', 0, 6) !== 'Exif\0\0') return undefined
  // TIFF header: byte order ('II'/'MM'), magic 42, then the offset of IFD0 relative to it.
  const tiff = segment.subarray(6)
  const order = tiff.toString('latin1', 0, 2)
  const readU16 =
    order === 'II'
      ? (offset: number) => tiff.readUInt16LE(offset)
      : order === 'MM'
        ? (offset: number) => tiff.readUInt16BE(offset)
        : undefined
  const readU32 =
    order === 'II'
      ? (offset: number) => tiff.readUInt32LE(offset)
      : order === 'MM'
        ? (offset: number) => tiff.readUInt32BE(offset)
        : undefined
  if (!readU16 || !readU32 || tiff.length < 8 || readU16(2) !== 42) return undefined

  const ifdOffset = readU32(4)
  if (ifdOffset + 2 > tiff.length) return undefined
  const entryCount = readU16(ifdOffset)
  // Each IFD entry: tag(2), type(2), count(4), inline value(4).
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12
    if (entry + 12 > tiff.length) return undefined
    if (readU16(entry) !== 0x0112 || readU16(entry + 2) !== 3 || readU32(entry + 4) !== 1) continue
    // A single SHORT value lives in the first two bytes of the value field, endian-applied.
    const orientation = readU16(entry + 8)
    return orientation >= 1 && orientation <= 8 ? orientation : undefined
  }
  return undefined
}

const readPngDimensions = (bytes: Buffer): RasterImageDimensions | undefined => {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const readJpegDimensions = (bytes: Buffer): RasterImageDimensions | undefined => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return undefined
  }
  let orientation: number | undefined
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return undefined

    const marker = bytes[offset]
    offset += 1
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0xda ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return undefined
    }
    if (offset + 2 > bytes.length) return undefined

    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined
    if (marker === 0xe1 && orientation === undefined) {
      orientation = readExifOrientation(bytes.subarray(offset + 2, offset + segmentLength))
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) return undefined
      const samplePrecision = bytes[offset + 2]
      const componentCount = bytes[offset + 7]
      if (samplePrecision === 0 || componentCount < 1 || segmentLength !== 8 + 3 * componentCount) {
        return undefined
      }
      const width = bytes.readUInt16BE(offset + 5)
      const height = bytes.readUInt16BE(offset + 3)
      return orientation !== undefined && EXIF_TRANSPOSE_ORIENTATIONS.has(orientation)
        ? { width: height, height: width }
        : { width, height }
    }
    offset += segmentLength
  }
  return undefined
}

const readGifDimensions = (bytes: Buffer): RasterImageDimensions | undefined => {
  const signature = bytes.toString('ascii', 0, 6)
  if (bytes.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) return undefined
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

const readWebpDimensions = (bytes: Buffer): RasterImageDimensions | undefined => {
  if (
    bytes.length < 25 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return undefined
  }
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1
    }
  }
  if (
    chunk === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
    }
  }
  return undefined
}

export const isPixelLimitedRasterMimeType = (value: string): value is RasterImageMimeType =>
  value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp'

export const readRasterImageDimensions = (
  bytes: Buffer,
  mimeType: RasterImageMimeType
): RasterImageDimensions | undefined => {
  if (mimeType === 'image/png') return readPngDimensions(bytes)
  if (mimeType === 'image/jpeg') return readJpegDimensions(bytes)
  if (mimeType === 'image/gif') return readGifDimensions(bytes)
  return readWebpDimensions(bytes)
}

export const exceedsDecodedImagePixelLimit = (size: RasterImageDimensions): boolean =>
  size.width < 1 ||
  size.height < 1 ||
  size.width > Math.floor(MAX_DECODED_IMAGE_PIXELS / size.height)
