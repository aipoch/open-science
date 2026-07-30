import { Decompress } from 'fflate'
import type { TiffIfd } from 'tiff'

const TIFF_TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8] as const
const MAX_TIFF_PAGES = 512
const MAX_TIFF_IFDS = 1_024
const MAX_TIFF_IFD_DEPTH = 8
const MAX_TIFF_IFD_ENTRIES = 4_096
const MAX_TIFF_TOTAL_ENTRIES = 16_384
const MAX_TIFF_FIELD_VALUES = 1_000_000
const MAX_TIFF_FIELD_BYTES = 4 * 1024 * 1024
const MAX_TIFF_METADATA_ALLOCATION_BYTES = 16 * 1024 * 1024
const TIFF_LZW_CLEAR_CODE = 256
const TIFF_LZW_EOI_CODE = 257
const TIFF_LZW_TABLE_START = 258
const DEFLATE_PREFLIGHT_CHUNK_BYTES = 1_024

type TiffStructure = {
  pageCount: number
}

type TiffByteReader = {
  view: DataView
  littleEndian: boolean
}

const assertRange = (offset: number, length: number, byteLength: number): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > byteLength ||
    offset > byteLength - length
  ) {
    throw new Error('Invalid TIFF data range')
  }
}

const readUint16 = (reader: TiffByteReader, offset: number): number => {
  assertRange(offset, 2, reader.view.byteLength)
  return reader.view.getUint16(offset, reader.littleEndian)
}

const readUint32 = (reader: TiffByteReader, offset: number): number => {
  assertRange(offset, 4, reader.view.byteLength)
  return reader.view.getUint32(offset, reader.littleEndian)
}

const estimateFieldAllocation = (type: number, count: number, valueBytes: number): number => {
  if (count <= 1) return 16
  if (type === 2) return Math.max(valueBytes * 2, count * 8)
  if (type === 5 || type === 10) return count * 16
  return valueBytes
}

const inspectTiffStructure = (data: ArrayBuffer): TiffStructure => {
  if (data.byteLength < 8) throw new Error('Invalid TIFF header')
  const view = new DataView(data)
  const byteOrder = view.getUint16(0, true)
  const littleEndian = byteOrder === 0x4949
  if (!littleEndian && byteOrder !== 0x4d4d) throw new Error('Invalid TIFF byte order')
  const reader = { view, littleEndian }
  if (readUint16(reader, 2) !== 42) throw new Error('Invalid TIFF header')

  const visitedOffsets = new Set<number>()
  let totalIfds = 0
  let totalEntries = 0
  let estimatedMetadataBytes = 0

  const inspectDirectory = (offset: number, depth: number): number => {
    if (depth > MAX_TIFF_IFD_DEPTH) throw new Error('TIFF directory nesting is too deep')
    if (visitedOffsets.has(offset)) throw new Error('Invalid cyclic TIFF directory')
    visitedOffsets.add(offset)
    totalIfds += 1
    if (totalIfds > MAX_TIFF_IFDS) throw new Error('TIFF has too many directories to preview')

    const entryCount = readUint16(reader, offset)
    if (entryCount > MAX_TIFF_IFD_ENTRIES) {
      throw new Error('TIFF metadata is too large to preview safely')
    }
    totalEntries += entryCount
    if (totalEntries > MAX_TIFF_TOTAL_ENTRIES) {
      throw new Error('TIFF metadata is too large to preview safely')
    }

    const entriesOffset = offset + 2
    const directoryBytes = entryCount * 12 + 4
    assertRange(entriesOffset, directoryBytes, data.byteLength)
    estimatedMetadataBytes += entryCount * 64

    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = entriesOffset + index * 12
      const tag = readUint16(reader, entryOffset)
      const type = readUint16(reader, entryOffset + 2)
      const count = readUint32(reader, entryOffset + 4)
      const typeBytes = TIFF_TYPE_BYTES[type]
      if (typeBytes === undefined) continue

      const valueBytes = typeBytes * count
      if (
        count > MAX_TIFF_FIELD_VALUES ||
        valueBytes > MAX_TIFF_FIELD_BYTES ||
        !Number.isSafeInteger(valueBytes)
      ) {
        throw new Error('TIFF metadata is too large to preview safely')
      }
      if (valueBytes > 4) {
        const valueOffset = readUint32(reader, entryOffset + 8)
        assertRange(valueOffset, valueBytes, data.byteLength)
      }

      estimatedMetadataBytes += estimateFieldAllocation(type, count, valueBytes)
      if (estimatedMetadataBytes > MAX_TIFF_METADATA_ALLOCATION_BYTES) {
        throw new Error('TIFF metadata is too large to preview safely')
      }

      if (tag === 0x8769 || tag === 0x8825) {
        if (type !== 4 || count !== 1) throw new Error('Invalid TIFF subdirectory pointer')
        const subdirectoryOffset = readUint32(reader, entryOffset + 8)
        if (subdirectoryOffset !== 0) inspectDirectory(subdirectoryOffset, depth + 1)
      }
    }

    return readUint32(reader, entriesOffset + entryCount * 12)
  }

  let pageCount = 0
  let directoryOffset = readUint32(reader, 4)
  while (directoryOffset !== 0) {
    directoryOffset = inspectDirectory(directoryOffset, 0)
    pageCount += 1
    if (pageCount > MAX_TIFF_PAGES) throw new Error('TIFF has too many pages to preview')
  }
  if (pageCount === 0) throw new Error('TIFF contains no image pages')

  return { pageCount }
}

const measureLzwOutput = (data: Uint8Array, maximumBytes: number): number => {
  const dictionaryLengths = new Uint32Array(4_096)
  for (let index = 0; index < 256; index += 1) dictionaryLengths[index] = 1
  let tableLength = TIFF_LZW_TABLE_START
  let codeBits = 9
  let bitOffset = 0
  let previousCode: number | undefined
  let outputBytes = 0

  const resetTable = (): void => {
    tableLength = TIFF_LZW_TABLE_START
    codeBits = 9
    previousCode = undefined
  }

  const readCode = (): number => {
    if (bitOffset + codeBits > data.byteLength * 8) throw new Error('Invalid TIFF LZW stream')
    let code = 0
    for (let bit = 0; bit < codeBits; bit += 1) {
      const absoluteBit = bitOffset + bit
      const byte = data[absoluteBit >> 3]
      code = (code << 1) | ((byte >> (7 - (absoluteBit & 7))) & 1)
    }
    bitOffset += codeBits
    return code
  }

  const addOutput = (length: number): void => {
    outputBytes += length
    if (!Number.isSafeInteger(outputBytes) || outputBytes > maximumBytes) {
      throw new Error('TIFF compressed strip exceeds its declared size')
    }
  }

  while (true) {
    let code = readCode()
    if (code === TIFF_LZW_EOI_CODE) return outputBytes
    if (code === TIFF_LZW_CLEAR_CODE) {
      resetTable()
      code = readCode()
      if (code === TIFF_LZW_EOI_CODE) return outputBytes
      if (code >= 256) throw new Error('Invalid TIFF LZW stream')
      addOutput(1)
      previousCode = code
      continue
    }
    if (previousCode === undefined) throw new Error('Invalid TIFF LZW stream')

    const previousLength = dictionaryLengths[previousCode]
    const codeLength =
      code < tableLength ? dictionaryLengths[code] : code === tableLength ? previousLength + 1 : 0
    if (codeLength === 0) throw new Error('Invalid TIFF LZW stream')
    addOutput(codeLength)

    if (tableLength >= 4_096) throw new Error('Invalid TIFF LZW stream')
    dictionaryLengths[tableLength] = previousLength + 1
    tableLength += 1
    // TIFF LZW uses the early-change convention. These jumps intentionally match the
    // tiff@7.1.3 decoder's bitJumps table so preflight reads the same stream boundaries.
    if (tableLength === 511 || tableLength === 1_023 || tableLength === 2_047) codeBits += 1
    previousCode = code
  }
}

const measureDeflateOutput = (data: Uint8Array, maximumBytes: number): number => {
  let outputBytes = 0
  let completed = false
  const decompressor = new Decompress((chunk, final) => {
    outputBytes += chunk.byteLength
    if (!Number.isSafeInteger(outputBytes) || outputBytes > maximumBytes) {
      throw new Error('TIFF compressed strip exceeds its declared size')
    }
    completed = final
  })

  // fflate emits after each push. Small source chunks keep the transient inflated allocation
  // bounded even when a hostile stream has an extreme compression ratio.
  for (let offset = 0; offset < data.byteLength; offset += DEFLATE_PREFLIGHT_CHUNK_BYTES) {
    const end = Math.min(offset + DEFLATE_PREFLIGHT_CHUNK_BYTES, data.byteLength)
    decompressor.push(data.subarray(offset, end), end === data.byteLength)
  }

  if (!completed) throw new Error('Invalid TIFF Deflate stream')
  return outputBytes
}

const getSampleBytes = (ifd: TiffIfd): number => {
  if (ifd.bitsPerSample === 1 || ifd.bitsPerSample === 8) return 1
  if (ifd.bitsPerSample === 16) return 2
  if (ifd.bitsPerSample === 32 && ifd.sampleFormat === 3) return 4
  if (ifd.bitsPerSample === 64 && ifd.sampleFormat === 3) return 8
  throw new Error('Unsupported TIFF sample layout')
}

const assertTiffCompressionSafe = (data: ArrayBuffer, ifd: TiffIfd): void => {
  if (ifd.tiled) throw new Error('Unsupported TIFF tiled layout')
  if (![1, 5, 8, 32946].includes(ifd.compression)) {
    throw new Error(`Unsupported TIFF compression: ${ifd.compression}`)
  }

  const offsets = ifd.stripOffsets as ArrayLike<number> | undefined
  const byteCounts = ifd.stripByteCounts as ArrayLike<number> | undefined
  const rowsPerStrip = ifd.rowsPerStrip
  if (!offsets || !byteCounts || !Number.isSafeInteger(rowsPerStrip) || rowsPerStrip <= 0) {
    throw new Error('Invalid TIFF strip layout')
  }

  const expectedStrips = Math.ceil(ifd.height / rowsPerStrip)
  if (offsets.length !== expectedStrips || byteCounts.length !== expectedStrips) {
    throw new Error('Invalid TIFF strip layout')
  }

  const sampleBytes = getSampleBytes(ifd)
  const packedRowBytes = Math.ceil((ifd.width * ifd.components) / 8)
  for (let index = 0; index < expectedStrips; index += 1) {
    const offset = offsets[index]
    const byteCount = byteCounts[index]
    assertRange(offset, byteCount, data.byteLength)
    const rows = Math.min(rowsPerStrip, ifd.height - index * rowsPerStrip)
    const expectedBytes =
      ifd.bitsPerSample === 1
        ? packedRowBytes * rows
        : ifd.width * ifd.components * rows * sampleBytes

    if (ifd.compression === 1) {
      if (byteCount < expectedBytes) throw new Error('Invalid TIFF strip data')
      continue
    }

    const compressed = new Uint8Array(data, offset, byteCount)
    const outputBytes =
      ifd.compression === 5
        ? measureLzwOutput(compressed, expectedBytes)
        : measureDeflateOutput(compressed, expectedBytes)
    if (outputBytes !== expectedBytes) throw new Error('Invalid TIFF strip data')
  }
}

export { assertTiffCompressionSafe, inspectTiffStructure, measureLzwOutput }
export type { TiffStructure }
