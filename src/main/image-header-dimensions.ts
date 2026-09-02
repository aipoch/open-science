import { open } from 'node:fs/promises'

type ImageHeaderDimensions = { width: number; height: number }

// SOF0-15 minus the non-frame markers (DHT/DAC/JPG/RST-Adjacent C4/C8/CC).
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Dimensions must be plausible; anything larger is a corrupt header, not a real image.
const MAX_PLAUSIBLE_DIMENSION = 1_000_000

const plausible = (width: number, height: number): ImageHeaderDimensions | undefined =>
  width >= 1 && height >= 1 && width <= MAX_PLAUSIBLE_DIMENSION && height <= MAX_PLAUSIBLE_DIMENSION
    ? { width, height }
    : undefined

const parsePng = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  // 8-byte signature, then the IHDR chunk: length(4)=13, type(4)='IHDR', width(4), height(4).
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined
  }
  return plausible(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
}

const parseJpeg = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return undefined

    const marker = bytes[offset]
    offset += 1
    // Standalone markers without a length field; scan data means no SOF was found in time.
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
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 9) return undefined
      return plausible(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += segmentLength
  }
  return undefined
}

const parseGif = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  // Header(6) 'GIF87a'/'GIF89a', then the logical screen descriptor: width(2 LE), height(2 LE).
  if (bytes.length < 10) return undefined
  return plausible(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
}

const parseWebp = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  // RIFF(4) size(4) 'WEBP'(4), then the first chunk fourcc at offset 12.
  if (bytes.length < 21) return undefined
  const chunkType = bytes.toString('ascii', 12, 16)
  if (chunkType === 'VP8X') {
    // flags(1) reserved(3), canvas width minus one (3 LE) at 24, height minus one at 27.
    if (bytes.length < 30) return undefined
    const width = 1 + bytes.readUIntLE(24, 3)
    const height = 1 + bytes.readUIntLE(27, 3)
    return plausible(width, height)
  }
  if (chunkType === 'VP8L') {
    // signature byte 0x2f, then 14-bit width-1 and height-1 packed into 4 little-endian bytes.
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined
    const bits = bytes.readUInt32LE(21)
    return plausible((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  if (chunkType === 'VP8 ') {
    // frame tag(3), start code 9d 01 2a, then width/height as 14-bit little-endian values.
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined
    }
    return plausible(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  }
  return undefined
}

const parseBmp = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  // 'BM', then the DIB header carries width/height as signed int32 LE at offsets 18/22
  // (a negative height marks a top-down bitmap).
  if (bytes.length < 26) return undefined
  return plausible(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)))
}

// Pure header parser: sniffs the magic bytes (not the claimed extension) and returns the pixel
// dimensions, or undefined for unknown, truncated, or forged content.
const parseImageHeaderDimensions = (bytes: Buffer): ImageHeaderDimensions | undefined => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return parsePng(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return parseJpeg(bytes)
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return parseGif(bytes)
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return parseWebp(bytes)
  }
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return parseBmp(bytes)
  return undefined
}

// JPEG SOF markers can sit behind a large EXIF segment, so read generously but never whole files.
const HEADER_READ_LIMIT = 256 * 1024

// Best-effort dimension probe for the preview acquire path: any I/O or parse failure degrades to
// undefined so acquire never fails because of a header quirk.
const readImageHeaderDimensions = async (
  filePath: string
): Promise<ImageHeaderDimensions | undefined> => {
  try {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_READ_LIMIT)
      const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_LIMIT, 0)
      return parseImageHeaderDimensions(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export { parseImageHeaderDimensions, readImageHeaderDimensions }
export type { ImageHeaderDimensions }
